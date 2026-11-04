"""In-process fake of the daemon's /api/v1 contract.

Route table: tento/projects/autophys.project.docs/content/architecture.md
("API: the SDK's draft contract, rehomed"). Every record has the daemon's
global ``gseq``, which travels beside the record, never inside its JSON:
``GET /stream?after=<gseq>`` serves records as server-sent events
(``id: <gseq>``, ``event: record``, ``data: <the record's 8 fields>``), as
``tento-autophys-store`` frames them. Where the table is silent this fake
keeps the SDK's draft behaviour; sdk.md lists those points as contract
questions.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from autophys.store import GENESIS, chain_hash

PREFIX = "/api/v1"


class FakeAutophys:
    def __init__(self, *, auto_approve_after: int | None = 2, deny: bool = False, stream: bool = True) -> None:
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.gseq = 0
        self.stream = stream
        self.stream_afters: list[int] = []
        self.closing = False
        self.pairings: dict[str, dict] = {}
        self.keys: dict[str, dict] = {}
        self.projects: dict[str, dict] = {}
        self.configs: dict[str, dict[str, bytes]] = {}
        self.investigations: dict[str, dict] = {}
        self.records: dict[str, list[dict]] = {}
        self.auto_approve_after = auto_approve_after
        self.deny = deny
        self.requests: list[tuple[str, str, dict]] = []
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        with self.lock:
            self.closing = True
            self.changed.notify_all()
        self.httpd.shutdown()
        self.httpd.server_close()

    def issue_key(self, account="eng@example.com", workspace="ws_demo", device="test") -> str:
        key = "apk_" + secrets.token_hex(16)
        self.keys[key] = {"key_id": "key_" + uuid.uuid4().hex[:8], "account": account, "workspace": workspace, "device_name": device}
        return key

    def approve_record(self, inv: str, pid: str, decision: str = "approved", settings: dict | None = None) -> None:
        """What the dashboard does: append an approval event."""
        payload = {"proposal_id": pid, "event": decision, "by": "dashboard"}
        if settings is not None:
            payload["settings"] = settings
        with self.lock:
            self._append(inv, uuid.uuid4().hex, "proposal", payload)

    def _since(self, after: int) -> list[dict]:
        return sorted((r for log in self.records.values() for r in log if r["gseq"] > after), key=lambda r: r["gseq"])

    # ------------------------------------------------------------------
    def _append(self, inv: str, rid: str, kind: str, payload: dict) -> dict:
        log = self.records[inv]
        for r in log:
            if r["id"] == rid:
                return self._wire(r)
        prev = log[-1]["hash"] if log else GENESIS
        self.gseq += 1
        rec = {"gseq": self.gseq, "id": rid, "investigation": inv, "seq": len(log), "kind": kind, "ts": time.time(),
               "payload": payload, "prev_hash": prev, "hash": chain_hash(prev, rid, kind, payload)}
        log.append(rec)
        self.changed.notify_all()
        return self._wire(rec)

    @staticmethod
    def _wire(r: dict) -> dict:
        return {k: v for k, v in r.items() if k != "gseq"}

    def _proposal(self, inv: str, pid: str) -> dict | None:
        state = None
        for r in self.records[inv]:
            p = r["payload"]
            if r["kind"] == "proposal" and p.get("proposal_id") == pid:
                state = state or {"proposal_id": pid}
                state["status"] = p["event"]
                if p["event"] in ("proposed", "edited") and "settings" in p:
                    state["settings"] = p["settings"]
                if p["event"] == "proposed":
                    state["experiment"] = p.get("experiment")
        return state

    def _handler(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _err(self, code, error, message=""):
                self._send(code, {"error": error, "message": message})

            def _auth(self):
                h = self.headers.get("Authorization", "")
                if not h.startswith("Bearer ") or h[7:] not in fake.keys:
                    self._err(401, "unauthorized", "missing or unknown API key")
                    return None
                return fake.keys[h[7:]]

            def _body(self) -> tuple[bytes, dict]:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                return raw, (json.loads(raw) if raw else {})

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def do_PUT(self):
                self._route("PUT")

            def _route(self, method):
                u = urlparse(self.path)
                path = u.path
                if not path.startswith(PREFIX):
                    return self._err(404, "not_found")
                path = path[len(PREFIX):]
                raw, body = self._body() if method in ("POST", "PUT") else (b"", {})
                fake.requests.append((method, path, dict(self.headers)))
                if path == "/stream" and method == "GET" and fake.stream:
                    if self._auth() is not None:
                        self._stream(int(parse_qs(u.query).get("after", ["0"])[0]))
                    return
                with fake.lock:
                    return self._dispatch(method, path, raw, body, parse_qs(u.query))

            def _stream(self, after):
                """SSE of records with gseq > after, then live ones; keep-alive comments while idle."""
                fake.stream_afters.append(after)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                cursor = after
                deadline = time.monotonic() + 30
                try:
                    while time.monotonic() < deadline:
                        with fake.lock:
                            batch = fake._since(cursor)
                            if not batch and not fake.closing:
                                fake.changed.wait(0.5)
                                batch = fake._since(cursor)
                            closing = fake.closing
                        for r in batch:
                            self.wfile.write(f"id: {r['gseq']}\nevent: record\ndata: {json.dumps(fake._wire(r))}\n\n".encode())

                            cursor = r["gseq"]
                        if not batch:
                            self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
                        if closing:
                            return
                except (BrokenPipeError, ConnectionResetError):
                    return


            def _dispatch(self, method, path, raw, body, query):
                if path == "/pair/start" and method == "POST":
                    dc = secrets.token_hex(12)
                    uc = "ABCD-" + secrets.token_hex(2).upper()
                    fake.pairings[dc] = {"user_code": uc, "polls": 0, "device_name": body.get("device_name", "")}
                    return self._send(200, {"device_code": dc, "user_code": uc, "verification_url": "https://example.test/autophys/pair",
                                            "interval": 0.01, "expires_in": 30})
                if path == "/pair/poll" and method == "POST":
                    p = fake.pairings.get(body.get("device_code"))
                    if p is None:
                        return self._err(400, "expired_token")
                    p["polls"] += 1
                    if fake.deny:
                        return self._err(400, "access_denied", "the request was declined")
                    if fake.auto_approve_after is None or p["polls"] <= fake.auto_approve_after:
                        return self._err(400, "authorization_pending")
                    key = fake.issue_key(device=p["device_name"])
                    del fake.pairings[body["device_code"]]
                    info = fake.keys[key]
                    return self._send(200, {"api_key": key, "key_id": info["key_id"], "account": info["account"], "workspace": info["workspace"]})
                who = self._auth()
                if who is None:
                    return
                if path == "/whoami" and method == "GET":
                    return self._send(200, who)
                if path == "/projects":
                    if method == "GET":
                        return self._send(200, {"projects": [p for p in fake.projects.values() if p["workspace"] == who["workspace"]]})
                    for p in fake.projects.values():
                        if p["name"] == body["name"] and p["workspace"] == who["workspace"]:
                            return self._send(200, {"project": p})
                    pid = "prj_" + uuid.uuid4().hex[:16]
                    fake.projects[pid] = {"id": pid, "name": body["name"], "workspace": who["workspace"]}
                    fake.configs[pid] = {}
                    return self._send(201, {"project": fake.projects[pid]})
                m = re.fullmatch(r"/projects/([^/]+)/config_versions(?:/([^/]+))?", path)
                if m:
                    pid, ver = m.group(1), m.group(2)
                    if pid not in fake.projects:
                        return self._err(404, "not_found", "unknown project")
                    if method == "GET" and ver is None:
                        return self._send(200, {"config_versions": [{"version": v, "config": json.loads(b)} for v, b in fake.configs[pid].items()]})
                    if method == "PUT" and ver:
                        from urllib.parse import unquote

                        ver = unquote(ver)
                        if "sha256:" + hashlib.sha256(raw).hexdigest() != ver:
                            return self._err(422, "hash_mismatch", "sha256 of the body does not match the version")
                        created = ver not in fake.configs[pid]
                        fake.configs[pid].setdefault(ver, raw)
                        return self._send(201 if created else 200, {"version": ver})
                if path == "/investigations":
                    if method == "GET":
                        return self._send(200, {"investigations": list(fake.investigations.values())})
                    pid, ver = body.get("project_id"), body.get("config_version")
                    if pid not in fake.configs or ver not in fake.configs[pid]:
                        return self._err(409, "unknown_config_version", "PUT the config version first")
                    inv = "inv_" + uuid.uuid4().hex[:16]
                    fake.investigations[inv] = {"id": inv, "project_id": pid, "config_version": ver, "overrides": body.get("overrides", {})}
                    fake.records[inv] = []
                    fake._append(inv, uuid.uuid4().hex, "investigation", body.get("meta", {}))
                    return self._send(201, {"id": inv})
                m = re.fullmatch(r"/investigations/([^/]+)/(.+)", path)
                if not m or m.group(1) not in fake.records:
                    return self._err(404, "not_found")
                inv, rest = m.group(1), m.group(2)
                if rest == "records" and method == "GET":
                    kind = query.get("kind", [None])[0]
                    return self._send(200, {"records": [fake._wire(r) for r in fake.records[inv] if kind is None or r["kind"] == kind]})
                kinds = {"measurements": "measurement", "runs": "run", "steps": "step", "outcome": "outcome"}
                if rest in kinds and method == "POST":
                    if body.get("kind") != kinds[rest]:
                        return self._err(400, "invalid_request", "kind does not match the route")
                    return self._send(201, {"record": fake._append(inv, body["id"], body["kind"], body["payload"])})
                if rest == "proposals" and method == "POST":
                    return self._send(201, {"record": fake._append(inv, body["id"], "proposal", body["payload"])})
                m2 = re.fullmatch(r"proposals/([^/]+)(?:/(approvals|data))?", rest)
                if m2:
                    pid, sub = m2.group(1), m2.group(2)
                    state = fake._proposal(inv, pid)
                    if state is None:
                        return self._err(404, "not_found", "unknown proposal")
                    if method == "GET" and sub is None:
                        return self._send(200, state)
                    if method == "POST" and sub == "approvals":
                        if state["status"] != "proposed":
                            return self._err(409, "conflict", f"proposal is {state['status']}")
                        return self._send(201, {"record": fake._append(inv, body["id"], "proposal", body["payload"])})
                    if method == "POST" and sub == "data":
                        if state["status"] not in ("approved", "edited"):
                            return self._err(409, "conflict", f"proposal is {state['status']}")
                        return self._send(201, {"record": fake._append(inv, body["id"], "proposal", body["payload"])})
                return self._err(405 if method else 404, "method_not_allowed")

        return H
