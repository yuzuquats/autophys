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

import hashlib
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
    """An HTTP error response. ``retry_after`` is the raw ``Retry-After`` header, if any."""

    def __init__(self, status: int, error: str, message: str = "", *, retry_after: str | None = None, path: str | None = None) -> None:
        super().__init__(f"HTTP {status} {error}: {message}".strip())
        self.status = status
        self.error = error
        self.message = message
        self.retry_after = retry_after
        self.path = path


class AuthError(HttpError):
    pass


def _route_missing(error: HttpError) -> bool:
    """True when the daemon has no such route, as opposed to a missing resource.

    The daemon answers an unknown route with 404 ``unknown route`` (older
    builds with an empty body) or 405; a 404 naming a resource, such as
    ``unknown investigation``, is an ordinary error.
    """
    return error.status == 405 or (error.status == 404 and error.message in ("", "unknown route"))


def _daemon_too_old(error: HttpError, feature: str) -> HttpError:
    """RS-REMOTE-2: a daemon without a feature's endpoint is an error, never a skip."""
    return HttpError(error.status, error.error,
                     f"the daemon is too old for {feature} (no endpoint); upgrade the autophys daemon",
                     retry_after=error.retry_after, path=error.path)


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
    try:
        raw = e.read()
    finally:
        e.close()
    try:
        j = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        j = {}
    if not isinstance(j, dict):
        j = {}
    err, msg = j.get("error", "http_error"), j.get("message", "")
    cls = AuthError if e.code in (401, 403) and err not in ("access_denied",) else HttpError
    retry_after = e.headers.get("Retry-After") if e.headers is not None else None
    return cls(e.code, err if isinstance(err, str) else "http_error",
               msg if isinstance(msg, str) else "", retry_after=retry_after,
               path=j.get("path") if isinstance(j.get("path"), str) else None)


# --------------------------------------------------------------------------
# Server-sent events


@dataclass
class StreamEvent:
    event: str
    id: str
    data: str


#: Statuses a wait retries until its deadline (as the reasoners do).
_TRANSIENT_STATUS = (429, 500, 502, 503, 504)


class StreamUnavailable(RuntimeError):
    """The server has no usable ``/stream``; callers fall back to polling."""


def iter_sse(lines: Iterable[bytes], *, keep_alive=False) -> Iterator[StreamEvent]:
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
            if keep_alive:
                yield StreamEvent("keep-alive", eid, "")
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


def normalize_server(server: str) -> str:
    """Canonical daemon identity, validated without I/O or echoing userinfo."""
    try:
        u = urllib.parse.urlsplit(server)
        if (u.scheme.lower() not in ("http", "https") or not u.hostname
                or u.username is not None or u.password is not None
                or "?" in server or "#" in server
                or any(c.isspace() for c in server) or "\\" in server):
            raise ValueError()
        host = u.hostname.lower()
        if not host.isascii():
            raise ValueError()
        port = u.port
        authority = f"[{host}]" if ":" in host else host
        if port is not None and port != (80 if u.scheme.lower() == "http" else 443):
            authority += f":{port}"
        return f"{u.scheme.lower()}://{authority}{u.path.rstrip('/')}"
    except ValueError:
        raise StoreError("invalid daemon URL") from None


def config_dir() -> Path:
    return Path(os.environ.get("AUTOPHYS_CONFIG_DIR") or Path.home() / ".config" / "autophys")


def credentials_path() -> Path:
    return config_dir() / "credentials"


@dataclass
class Credentials:
    server: str
    api_key: str
    key_id: str | None = ""
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
    resolved_server = normalize_server(server or os.environ.get("AUTOPHYS_SERVER") or (file_creds.server if file_creds else DEFAULT_SERVER))
    if env_key:
        return Credentials(resolved_server, env_key, key_id=None)
    if file_creds:
        if normalize_server(file_creds.server) != resolved_server:
            raise StoreError("saved credentials belong to a different server; supply an explicit API key")
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

_ENDPOINT = {"measurement": "measurements", "run": "runs", "step": "steps", "outcome": "outcome", "reveal": "reveal"}


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
        self.base = normalize_server(server) + API_PREFIX
        self._key = api_key
        self.key_id = key_id
        self.timeout = timeout
        self.stream_idle = stream_idle
        self.cursors: dict[str, int] = {}
        self._wait_state: dict[str, str | None] = {"last_wait": None}
        self._project_id: str | None = None
        self._bound_project_name: str | None = None

    @property
    def last_wait(self) -> str | None:
        return self._wait_state["last_wait"]

    @last_wait.setter
    def last_wait(self, value: str | None) -> None:
        self._wait_state["last_wait"] = value

    def _see(self, investigation: str, rec: dict) -> dict:
        g = rec.get("gseq")
        if isinstance(g, int) and g > self.cursors.get(investigation, 0):
            self.cursors[investigation] = g
        return rec

    def __repr__(self) -> str:
        return f"HttpStore({self.base!r})"

    def _req(self, method: str, path: str, body: Any = None, **kw) -> Any:
        return request_json(method, self.base + path, body, api_key=self._key, timeout=kw.pop("timeout", self.timeout), **kw)[1]

    def for_project(self, project_id: str, name: str) -> "HttpStore":
        # Share the transport cursor map; blob ownership belongs to this handle.
        import copy
        bound = copy.copy(self)
        bound._project_id = project_id
        bound._bound_project_name = name
        return bound

    def ensure_project(self, name: str) -> str:
        if self._bound_project_name is not None:
            if name != self._bound_project_name:
                raise StoreError("store is bound to a different workbook")
            return self._project_id
        self._project_id = self._req("POST", "/projects", {"name": name})["project"]["id"]
        return self._project_id

    def _blob_url(self, key):
        digest = key.removeprefix("sha256:")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise StoreError("invalid blob hash")
        if self._project_id is None:
            raise StoreError("select a project with ensure_project before accessing blobs")
        return f"{self.base}/projects/{urllib.parse.quote(self._project_id, safe='')}/blobs/{digest}"

    def put_blob(self, data: bytes, media_type: str = "application/octet-stream") -> str:
        if len(data) > 16 * 1024 * 1024:
            raise StoreError("blob exceeds 16 MiB limit")
        if not isinstance(media_type, str) or not media_type.strip():
            raise StoreError("blob requires Content-Type")
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        req = urllib.request.Request(self._blob_url(key), data=data, method="PUT",
                                     headers={"Content-Type": media_type, "Authorization": f"Bearer {self._key}",
                                              "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout):
                pass
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                detail = json.load(error)
            except (ValueError, TypeError):
                detail = {}
            finally:
                error.close()
            if status == 413:
                raise StoreError("blob exceeds 16 MiB limit") from None
            if status == 422:
                # Interpret only known codes/paths, never echo server text.
                if isinstance(detail, dict) and detail.get("error") == "hash_mismatch":
                    message = "blob hash mismatch"
                elif isinstance(detail, dict) and detail.get("path") == "Content-Type":
                    message = "blob requires Content-Type"
                else:
                    message = "blob rejected (HTTP 422)"
                raise StoreError(message) from None
            raise HttpError(status, "blob_upload_failed") from None
        return key

    def get_blob(self, key: str) -> tuple[bytes, str]:
        req = urllib.request.Request(self._blob_url(key), headers={"Authorization": f"Bearer {self._key}",
                                                                 "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return response.read(), response.headers["Content-Type"]
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise HttpError(status, "blob_read_failed") from None

    def register_display(self, project_id: str, project) -> None:
        if project.simulator.display is not None:
            self.put_display(project_id, project.simulator.display.canonical(project))

    def put_display(self, project_id: str, body: bytes) -> None:
        """Upload exact canonical bytes independently of config identity."""
        pid = urllib.parse.quote(project_id, safe="")
        req = urllib.request.Request(self.base + f"/projects/{pid}/display", data=body, method="PUT",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._key}",
                                              "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout):
                pass
        except urllib.error.HTTPError as raw:
            error = _http_error(raw)  # parsed only to classify; server text is not echoed
            status = error.status
            if _route_missing(error):
                raise _daemon_too_old(HttpError(status, "display_upload_failed"), "display manifests") from None
            if status == 413:
                raise StoreError("display manifest exceeds 256 KiB limit") from None
            if status == 422:
                raise StoreError("display manifest rejected: expected format 1 (HTTP 422)") from None
            raise HttpError(status, "display_upload_failed") from None

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

    def create_investigation(self, meta: dict, *, idempotency_key: str | None = None) -> str:
        """Reuse an explicit key across retries of one logical create.

        As in Rust/daemon, no key means a new investigation, even for equal meta.
        """
        from .workbook import canonical_payload
        meta, _ = canonical_payload(meta)
        body = {"project_id": meta.get("project_id"), "config_version": meta.get("config_version"),
                "overrides": meta.get("overrides", {}), "meta": meta}
        j = self._req("POST", "/investigations", body, headers={"Idempotency-Key": uuid.uuid4().hex if idempotency_key is None else idempotency_key})
        self._see(j["id"], j)
        return j["id"]

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        from .workbook import canonical_payload
        payload, _ = canonical_payload(payload)
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
        try:
            j = self._req("POST", path, envelope, headers={"Idempotency-Key": rid})
        except HttpError as error:
            if kind == "reveal" and _route_missing(error):
                raise _daemon_too_old(error, "reveal records") from None
            raise
        self._see(investigation, j)
        return _to_record(j["record"])

    def attach_data(self, investigation: str, proposal_id: str, measurement: dict, attached: dict) -> Record:
        """Commit the existing two record bodies atomically; old servers fail closed."""
        def identity(kind, payload):
            return hashlib.sha256(canonical({"investigation": investigation, "proposal_id": proposal_id,
                                             "kind": kind, "payload": payload}).encode()).hexdigest()
        inv, pid = urllib.parse.quote(investigation, safe=""), urllib.parse.quote(proposal_id, safe="")
        body = {"measurement": {"id": identity("measurement", measurement), "kind": "measurement", "payload": measurement},
                "attachment_id": identity("proposal", attached), "attachment_payload": attached}
        out = self._req("POST", f"/investigations/{inv}/proposals/{pid}/attachment", body)
        self._see(investigation, out)
        return _to_record(out["record"])

    def records(self, investigation, kind=None):
        q = "?kind=" + urllib.parse.quote(kind) if kind else ""
        j = self._req("GET", f"/investigations/{urllib.parse.quote(investigation, safe='')}/records{q}")
        return [_to_record(r) for r in j["records"]]

    def investigations(self):
        return self._req("GET", "/investigations")["investigations"]

    def proposal(self, investigation: str, proposal_id: str, *, timeout=None) -> dict:
        inv = urllib.parse.quote(investigation, safe="")
        return self._req("GET", f"/investigations/{inv}/proposals/{urllib.parse.quote(proposal_id, safe='')}", timeout=self.timeout if timeout is None else timeout)

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
            if err.status in (401, 403):
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
        """Wait through transient disconnects, bounded by one absolute deadline."""
        deadline = clock() + timeout
        if stream:
            try:
                result = self._wait_streaming(investigation, proposal_id, deadline, clock, sleep)
                self.last_wait = "stream"
                return result
            except StreamUnavailable:
                pass
        self.last_wait = "poll"
        attempt = 0
        while True:
            remaining = self._remaining(deadline, clock, proposal_id)
            try:
                p = self.proposal(investigation, proposal_id, timeout=min(self.timeout, remaining))
                if p["status"] != "proposed":
                    return p
                delay = interval
                attempt = 0
            except HttpError as error:
                if error.status not in _TRANSIENT_STATUS:
                    raise  # 401/403/404/4xx will not clear by waiting
                delay = min(5, .1 * 2 ** min(attempt, 6))
                attempt += 1
            except OSError:
                delay = min(5, .1 * 2 ** min(attempt, 6))
                attempt += 1
            sleep(min(delay, self._remaining(deadline, clock, proposal_id)))

    @staticmethod
    def _remaining(deadline, clock, proposal_id):
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError(f"proposal {proposal_id} still awaiting approval")
        return remaining

    def _wait_streaming(self, investigation: str, proposal_id: str, deadline: float, clock, sleep=time.sleep) -> dict:
        attempt = 0
        while True:
            remaining = self._remaining(deadline, clock, proposal_id)
            try:
                # Subscribe before checking state so decisions cannot fall in a gap.
                with self.stream(investigation, idle=min(self.stream_idle, remaining)) as resp:
                    p = self.proposal(investigation, proposal_id,
                                      timeout=min(self.timeout, self._remaining(deadline, clock, proposal_id)))
                    if p["status"] != "proposed":
                        return p
                    def lines():
                        while True:
                            remaining = self._remaining(deadline, clock, proposal_id)
                            # HTTPResponse.readline otherwise retains its original
                            # idle timeout even as keep-alives renew it forever.
                            sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
                            if sock is not None:  # CPython internals; without them reads keep the connect-time idle
                                sock.settimeout(min(self.stream_idle, remaining))
                            line = resp.readline()
                            if not line:
                                return
                            yield line
                    for event in iter_sse(lines(), keep_alive=True):
                        self._remaining(deadline, clock, proposal_id)
                        if event.event not in ("message", "record"):
                            continue
                        rec = json.loads(event.data)
                        if event.id.isdigit():
                            self._see(investigation, {"gseq": int(event.id)})
                        payload = rec.get("payload") or {}
                        if (rec.get("investigation") == investigation and rec.get("kind") == "proposal"
                                and payload.get("proposal_id") == proposal_id
                                and payload.get("event") != "proposed"):
                            return self.proposal(investigation, proposal_id,
                                                 timeout=min(self.timeout, self._remaining(deadline, clock, proposal_id)))
                attempt = 0
            except HttpError as error:
                if error.status not in _TRANSIENT_STATUS:
                    raise  # 401/403/404/4xx will not clear by waiting
            except socket.timeout:
                # An idle stream is usable; immediately reconnect with its cursor.
                self._remaining(deadline, clock, proposal_id)
                continue
            except OSError:
                pass  # refused/reset: retry from the last cursor
            sleep(min(.1 * 2 ** min(attempt, 6), 5, self._remaining(deadline, clock, proposal_id)))
            attempt += 1
