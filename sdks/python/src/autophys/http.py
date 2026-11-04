"""HTTP client for the autophys daemon's ``/api/v1`` contract.

The daemon is the autophys repo's ``autophys serve`` (loopback
``127.0.0.1:4794``); its route table is in

``tento/projects/autophys.project.docs/content/architecture.md``. The daemon's
store is being built in parallel, so this client is tested against an
in-process fake of that table (``tests/fake_server.py``).

Authentication: ``Authorization: Bearer <api key>`` on every route except
``pair/start`` and ``pair/poll``. The key comes from ``AUTOPHYS_API_KEY`` or
``~/.config/autophys/credentials`` (JSON, mode 0600). Nothing in this module
prints or logs a key.

Waiting for an approval: :meth:`HttpStore.wait_for_approval` consumes
``GET /stream?after=<gseq>`` (server-sent events) and falls back to polling
``GET .../proposals/{pid}`` when the stream is unavailable.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Iterable, Iterator

from .store import Record, Store, StoreError, canonical, config_hash

API_PREFIX = "/api/v1"
DEFAULT_SERVER = "http://127.0.0.1:4794"
USER_AGENT = "autophys-python/0.1"


class HttpError(RuntimeError):
    def __init__(self, status: int, error: str, message: str = "") -> None:
        super().__init__(f"HTTP {status} {error}: {message}".strip())
        self.status = status
        self.error = error
        self.message = message


class AuthError(HttpError):
    pass


def request_json(
    method: str,
    url: str,
    body: Any | None = None,
    *,
    api_key: str | None = None,
    timeout: float = 30.0,
    headers: dict | None = None,
) -> tuple[int, Any]:
    data = None if body is None else canonical(body).encode()
    h = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if data is not None:
        h["Content-Type"] = "application/json"
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raise _http_error(e) from None


def _http_error(e: urllib.error.HTTPError) -> HttpError:
    raw = e.read()
    try:
        j = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        j = {}
    if not isinstance(j, dict):
        j = {}
    err, msg = j.get("error", "http_error"), j.get("message", "")
    cls = AuthError if e.code in (401, 403) and err not in ("access_denied",) else HttpError
    return cls(e.code, err, msg)


# --------------------------------------------------------------------------
# Server-sent events


@dataclass
class StreamEvent:
    event: str
    id: str
    data: str


class StreamUnavailable(RuntimeError):
    """The server has no usable ``/stream``; callers fall back to polling."""


def iter_sse(lines: Iterable[bytes]) -> Iterator[StreamEvent]:
    """Parse a ``text/event-stream`` body (WHATWG HTML, "event stream
    interpretation"): ``data:`` lines join with newlines, a blank line
    dispatches, ``:`` lines are comments (keep-alives)."""
    event, eid, data = "", "", []
    for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                yield StreamEvent(event or "message", eid, "\n".join(data))
            event, data = "", []
            continue
        if line.startswith(":"):
            continue
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "data":
            data.append(value)
        elif name == "event":
            event = value
        elif name == "id":
            eid = value


_RECORD_FIELDS = {f.name for f in fields(Record)}


def _to_record(d: dict) -> Record:
    """A store record from the wire; extra daemon fields (``gseq``) are dropped."""
    return Record(**{k: v for k, v in d.items() if k in _RECORD_FIELDS})


# --------------------------------------------------------------------------
# Credentials


def config_dir() -> Path:
    return Path(os.environ.get("AUTOPHYS_CONFIG_DIR") or Path.home() / ".config" / "autophys")


def credentials_path() -> Path:
    return config_dir() / "credentials"


@dataclass
class Credentials:
    server: str
    api_key: str
    key_id: str = ""
    account: str = ""
    device_name: str = ""

    def __repr__(self) -> str:  # never show the key
        return f"Credentials(server={self.server!r}, key_id={self.key_id!r}, account={self.account!r})"


def save_credentials(creds: Credentials) -> Path:
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(
            {"server": creds.server, "api_key": creds.api_key, "key_id": creds.key_id,
             "account": creds.account, "device_name": creds.device_name},
            f,
        )
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


def load_credentials(server: str | None = None) -> Credentials | None:
    """``AUTOPHYS_API_KEY`` wins over the credentials file."""
    env_key = os.environ.get("AUTOPHYS_API_KEY")
    path = credentials_path()
    file_creds = None
    if path.exists():
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise StoreError(f"{path} is readable by others (mode {mode:o}); run chmod 600")
        d = json.loads(path.read_text())
        file_creds = Credentials(d["server"], d["api_key"], d.get("key_id", ""), d.get("account", ""), d.get("device_name", ""))
    resolved_server = server or os.environ.get("AUTOPHYS_SERVER") or (file_creds.server if file_creds else DEFAULT_SERVER)
    if env_key:
        return Credentials(resolved_server, env_key, key_id="(AUTOPHYS_API_KEY)")
    if file_creds:
        file_creds.server = resolved_server
        return file_creds
    return None


# --------------------------------------------------------------------------
# Pairing (device-code flow, RFC 8628 shaped)


@dataclass
class PairingStart:
    device_code: str
    user_code: str
    verification_url: str
    interval: float
    expires_in: float


def pair_start(server: str, device_name: str, *, timeout: float = 30.0) -> PairingStart:
    _, j = request_json("POST", server.rstrip("/") + API_PREFIX + "/pair/start",
                        {"device_name": device_name, "client": USER_AGENT}, timeout=timeout)
    return PairingStart(j["device_code"], j["user_code"], j["verification_url"], float(j.get("interval", 5)), float(j.get("expires_in", 600)))


def pair_poll(server: str, start: PairingStart, device_name: str, *, sleep=time.sleep, clock=time.monotonic) -> Credentials:
    """Poll until approved; raises HttpError on denial or expiry."""
    deadline = clock() + start.expires_in
    interval = start.interval
    while True:
        try:
            _, j = request_json("POST", server.rstrip("/") + API_PREFIX + "/pair/poll", {"device_code": start.device_code})
            return Credentials(server, j["api_key"], j.get("key_id", ""), j.get("account", ""), device_name)
        except HttpError as e:
            if e.error == "authorization_pending":
                pass
            elif e.error == "slow_down":
                interval += 5
            else:
                raise
        if clock() >= deadline:
            raise HttpError(400, "expired_token", "pairing code expired before approval")
        sleep(interval)


def whoami(creds: Credentials) -> dict:
    _, j = request_json("GET", creds.server.rstrip("/") + API_PREFIX + "/whoami", api_key=creds.api_key)
    return j


# --------------------------------------------------------------------------
# HttpStore

_ENDPOINT = {"measurement": "measurements", "run": "runs", "step": "steps", "outcome": "outcome"}


class HttpStore(Store):
    """Store backed by the daemon's ``/api/v1`` contract.

    ``cursors`` maps each investigation to the highest ``gseq`` this store has
    seen for it. ``gseq`` orders one workbook, so streams are always scoped
    (``?investigation=``) and keep integer cursors; the collection-wide
    cursor of an unscoped stream is never used. The daemon puts ``gseq`` in
    the stream's ``id:`` field and beside ``record`` in POST responses, both
    of which advance the investigation's cursor; :meth:`wait_for_approval`
    resumes from it.
    ``last_wait`` says how the last wait was served: ``"stream"`` or
    ``"poll"``.
    """

    def __init__(self, server: str, api_key: str, *, timeout: float = 30.0, stream_idle: float = 30.0, key_id: str | None = None) -> None:
        self.base = server.rstrip("/") + API_PREFIX
        self._key = api_key
        self.key_id = key_id
        self.timeout = timeout
        self.stream_idle = stream_idle
        self.cursors: dict[str, int] = {}
        self.last_wait: str | None = None

    def _see(self, investigation: str, rec: dict) -> dict:
        g = rec.get("gseq")
        if isinstance(g, int) and g > self.cursors.get(investigation, 0):
            self.cursors[investigation] = g
        return rec

    def __repr__(self) -> str:
        return f"HttpStore({self.base!r})"

    def _req(self, method: str, path: str, body: Any = None, **kw) -> Any:
        return request_json(method, self.base + path, body, api_key=self._key, timeout=self.timeout, **kw)[1]

    def ensure_project(self, name: str) -> str:
        return self._req("POST", "/projects", {"name": name})["project"]["id"]

    def put_config_version(self, project_id: str, version: str, config: dict) -> str:
        """PUT the canonical config bytes; the server checks sha256(body) == version."""
        if config_hash(config) != version:
            raise StoreError("config version does not match the hash of its content")
        pid = urllib.parse.quote(project_id, safe="")
        return self._req("PUT", f"/projects/{pid}/config_versions/{urllib.parse.quote(version, safe='')}", config)["version"]

    def config_versions(self, project_id: str) -> list[dict]:
        pid = urllib.parse.quote(project_id, safe="")
        return self._req("GET", f"/projects/{pid}/config_versions")["config_versions"]

    def projects(self) -> list[dict]:
        return self._req("GET", "/projects")["projects"]

    def create_investigation(self, meta: dict) -> str:
        body = {"project_id": meta.get("project_id"), "config_version": meta.get("config_version"),
                "overrides": meta.get("overrides", {}), "meta": meta}
        j = self._req("POST", "/investigations", body, headers={"Idempotency-Key": uuid.uuid4().hex})
        self._see(j["id"], j)
        return j["id"]

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        rid = record_id if record_id is not None else uuid.uuid4().hex
        inv = urllib.parse.quote(investigation, safe="")
        envelope = {"id": rid, "kind": kind, "payload": payload}
        if kind == "proposal":
            pid = urllib.parse.quote(payload["proposal_id"], safe="")
            ev = payload["event"]
            if ev in ("proposed", "withdrawn"):
                path = f"/investigations/{inv}/proposals"
            elif ev in ("approved", "edited", "rejected"):
                path = f"/investigations/{inv}/proposals/{pid}/approvals"
            elif ev == "data_attached":
                path = f"/investigations/{inv}/proposals/{pid}/data"
            else:
                raise StoreError(f"unknown proposal event {ev}")
        elif kind in _ENDPOINT:
            path = f"/investigations/{inv}/{_ENDPOINT[kind]}"
        else:
            raise StoreError(f"kind {kind!r} is not uploaded through HttpStore")
        j = self._req("POST", path, envelope, headers={"Idempotency-Key": rid})
        self._see(investigation, j)
        return _to_record(j["record"])

    def records(self, investigation, kind=None):
        q = "?kind=" + urllib.parse.quote(kind) if kind else ""
        j = self._req("GET", f"/investigations/{urllib.parse.quote(investigation, safe='')}/records{q}")
        return [_to_record(r) for r in j["records"]]

    def investigations(self):
        return self._req("GET", "/investigations")["investigations"]

    def proposal(self, investigation: str, proposal_id: str) -> dict:
        inv = urllib.parse.quote(investigation, safe="")
        return self._req("GET", f"/investigations/{inv}/proposals/{urllib.parse.quote(proposal_id, safe='')}")

    def stream(self, investigation: str, after: int | None = None, *, idle: float | None = None):
        """Open ``GET /stream?investigation=<inv>&after=<gseq>``; returns the open response.

        Raises :class:`StreamUnavailable` when the route is missing or does
        not answer with ``text/event-stream``, :class:`AuthError` for a bad
        key. Iterate it with :meth:`stream_records`.
        """
        after = self.cursors.get(investigation, 0) if after is None else after
        q = urllib.parse.urlencode({"investigation": investigation, "after": int(after)})
        req = urllib.request.Request(
            f"{self.base}/stream?{q}",
            headers={"Accept": "text/event-stream", "User-Agent": USER_AGENT, "Authorization": f"Bearer {self._key}"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=idle or self.stream_idle)
        except urllib.error.HTTPError as e:
            err = _http_error(e)
            if isinstance(err, AuthError):
                raise err from None
            raise StreamUnavailable(str(err)) from None
        ctype = resp.headers.get("Content-Type", "")
        if not ctype.startswith("text/event-stream"):
            resp.close()
            raise StreamUnavailable(f"/stream answered {ctype or 'no content type'}")
        return resp

    def stream_records(self, resp) -> Iterator[dict]:
        """Records from an open scoped stream, in ``gseq`` order; advances ``cursors``."""
        for ev in iter_sse(resp):
            if ev.event not in ("message", "record"):
                continue
            rec = json.loads(ev.data)
            if ev.id.isdigit() and isinstance(rec.get("investigation"), str):
                self._see(rec["investigation"], {"gseq": int(ev.id)})
            yield rec


    def wait_for_approval(self, investigation: str, proposal_id: str, *, timeout: float = 3600, interval: float = 5,
                          sleep=time.sleep, clock=time.monotonic, stream: bool = True) -> dict:
        """Block until the proposal leaves ``proposed`` (approved, edited or rejected).

        Consumes the investigation's record stream from its cursor and returns as soon as
        an approval, edit or rejection of this proposal arrives. If the stream
        is unavailable (or ``stream=False``) it polls the proposal every
        ``interval`` seconds instead. Sets :attr:`last_wait`.
        """
        deadline = clock() + timeout
        if stream:
            try:
                p = self._wait_streaming(investigation, proposal_id, deadline, clock)
                self.last_wait = "stream"
                return p
            except StreamUnavailable:
                pass
        self.last_wait = "poll"
        while True:
            p = self.proposal(investigation, proposal_id)
            if p["status"] != "proposed":
                return p
            if clock() >= deadline:
                raise TimeoutError(f"proposal {proposal_id} still awaiting approval")
            sleep(interval)

    def _wait_streaming(self, investigation: str, proposal_id: str, deadline: float, clock) -> dict:
        decided = ("approved", "edited", "rejected", "withdrawn")
        while True:
            remaining = deadline - clock()
            if remaining <= 0:
                raise TimeoutError(f"proposal {proposal_id} still awaiting approval")
            # Subscribe first, then read the state once: a decision made in
            # between is replayed by the stream (after=cursor), and one made
            # before the cursor shows in the GET.
            try:
                resp = self.stream(investigation, idle=min(self.stream_idle, remaining))
            except OSError as e:  # refused, reset, DNS: no stream here
                raise StreamUnavailable(str(e)) from None
            with resp:
                p = self.proposal(investigation, proposal_id)
                if p["status"] != "proposed":
                    return p
                try:
                    for rec in self.stream_records(resp):
                        pl = rec.get("payload") or {}
                        if (rec.get("investigation") == investigation and rec.get("kind") == "proposal"
                                and pl.get("proposal_id") == proposal_id and pl.get("event") in decided):
                            return self.proposal(investigation, proposal_id)
                        if clock() >= deadline:
                            break
                except (socket.timeout, TimeoutError, ConnectionError):
                    pass  # idle past stream_idle or dropped: reconnect from the cursor
            # end of stream: reconnect from the cursor

