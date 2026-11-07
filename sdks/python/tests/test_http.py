import io
import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from fake_server import FakeAutophys
from autophys import cli
from autophys.agent import Investigation, ProposalRunner, ScriptedPolicy
from autophys.http import (AuthError, DEFAULT_SERVER, HttpError, HttpStore, iter_sse, load_credentials, pair_poll,
                           pair_start, request_json, save_credentials, whoami)
from autophys.project import Budgets, Project
from autophys.reasoner import HttpReasoner, ReasonerError, parse_json_content
from autophys.store import config_hash
from autophys.synthetic import thermal_case


@pytest.fixture
def server():
    with FakeAutophys() as s:
        yield s


@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    d = tmp_path / "cfg"
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(d))
    monkeypatch.delenv("AUTOPHYS_API_KEY", raising=False)
    monkeypatch.delenv("AUTOPHYS_SERVER", raising=False)
    return d


def test_http_store_contract(server):
    key = server.issue_key()
    store = HttpStore(server.url, key)
    assert "apk_" not in repr(store)
    pid = store.ensure_project("thermal")
    assert store.ensure_project("thermal") == pid
    cfg = {"name": "thermal", "x": 1.5}
    ver = store.put_config_version(pid, config_hash(cfg), cfg)
    assert [c["version"] for c in store.config_versions(pid)] == [ver]
    inv = store.create_investigation({"project_id": pid, "config_version": ver, "overrides": {"free": ["C"]}})
    assert server.investigations[inv]["overrides"] == {"free": ["C"]}
    r1 = store.append(inv, "run", {"loss": 1.0}, record_id="abc")
    r2 = store.append(inv, "run", {"loss": 1.0}, record_id="abc")
    assert r1.seq == r2.seq == 1
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "proposed", "experiment": "e", "settings": {}})
    assert store.proposal(inv, "p1")["status"] == "proposed"
    server.approve_record(inv, "p1")
    assert store.wait_for_approval(inv, "p1", sleep=lambda s: None)["status"] == "approved"
    assert store.last_wait == "stream"
    assert store.verify(inv)

    assert store.base == server.url + "/api/v1"
    for method, _path, headers in server.requests:
        assert headers.get("Authorization") == f"Bearer {key}" or _path.startswith("/pair")


def test_http_store_rejects_bad_key_and_unpinned(server):
    with pytest.raises(HttpError) as e:
        HttpStore(server.url, "apk_wrong").ensure_project("x")
    assert e.value.status == 401
    store = HttpStore(server.url, server.issue_key())
    with pytest.raises(HttpError) as e:
        store.create_investigation({"project_id": "prj_nope", "config_version": "sha256:00"})
    assert e.value.status == 409


def test_investigation_over_http_with_dashboard_approval(server):
    store = HttpStore(server.url, server.issue_key())
    view, _ = thermal_case(0)
    project = Project(view.name, view.simulator, budgets=Budgets(max_experiments=1))
    inv = Investigation(project, view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    out = inv.run()
    assert out.status == "awaiting_data"
    server.approve_record(inv.id, out.proposal_id)  # the dashboard approves
    assert inv.wait_for_approval(sleep=lambda s: None)["status"] == "approved"
    obs = view.runner.run(store.proposal(inv.id, out.proposal_id)["experiment"])
    assert store.last_wait == "stream"
    inv.attach_data(out.proposal_id, obs)
    assert inv.run().status == "validated"

    kinds = [r["kind"] for r in server.records[inv.id]]
    assert kinds[0] == "investigation" and kinds[-1] == "outcome" and "measurement" in kinds and "step" in kinds
    assert server.investigations[inv.id]["config_version"] == project.config_version


def _pair(url, name, sleep=lambda s: None):
    start = pair_start(url, name)
    return pair_poll(url, start, name, sleep=sleep)


def test_pairing_saves_0600_and_whoami_reads_it(server, config_dir):
    # The device flow the Rust `autophys connect` drives, through the SDK's
    # own pairing client: the key file is private and its repr hides the key.
    creds = _pair(server.url, "lab-pc")
    path = save_credentials(creds)
    saved = json.loads(path.read_text())
    assert path == config_dir / "credentials"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert saved["api_key"].startswith("apk_") and saved["api_key"] not in repr(creds)
    me = whoami(load_credentials())
    assert me["device_name"] == "lab-pc" and me["workspace"] == "ws_demo"
    assert saved["api_key"] not in json.dumps(me)


def test_saved_credentials_follow_autophys_server(server, config_dir, monkeypatch):
    save_credentials(_pair(server.url, "lab-pc"))
    monkeypatch.setenv("AUTOPHYS_SERVER", server.url)
    assert load_credentials().server == server.url


def test_pairing_denied(config_dir):
    with FakeAutophys(deny=True) as s:
        with pytest.raises(HttpError) as e:
            _pair(s.url, "lab-pc")
        assert e.value.error == "access_denied"
    assert not (config_dir / "credentials").exists()


def test_whoami_env_key_and_unpaired(server, config_dir, monkeypatch):
    assert load_credentials(server.url) is None
    key = server.issue_key(account="env@example.com")
    monkeypatch.setenv("AUTOPHYS_API_KEY", key)
    me = whoami(load_credentials(server.url))
    assert me["account"] == "env@example.com" and key not in json.dumps(me)
    monkeypatch.setenv("AUTOPHYS_API_KEY", "apk_revoked")
    with pytest.raises(AuthError):
        whoami(load_credentials(server.url))


def test_sdk_ships_no_console_script():
    # CLI-1: the only `autophys` command is the Rust binary.
    from pathlib import Path
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    if not pyproject.exists():
        pytest.skip("pyproject.toml is not part of the installed package")
    assert "[project.scripts]" not in pyproject.read_text()
    assert {"pair", "whoami"}.isdisjoint(cli.build_parser()._subparsers._group_actions[0].choices)


def test_credentials_with_open_mode_are_refused(config_dir):
    config_dir.mkdir(parents=True)
    p = config_dir / "credentials"
    p.write_text(json.dumps({"server": "http://x", "api_key": "k"}))
    os.chmod(p, 0o644)
    with pytest.raises(Exception, match="chmod 600"):
        load_credentials()


# --- reason lane ---------------------------------------------------------


class _ReasonLane:
    def __init__(self, reply):
        self.reply = reply
        self.bodies = []
        lane = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                lane.bodies.append((self.path, body))
                code, obj = lane.reply(body)
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_http_reasoner_wire_shape():
    lane = _ReasonLane(lambda b: (200, {"content": {"ok": True}, "model": "muse-spark-1.3", "usage": {"prompt_tokens": 5},
                                        "route": "meta", "elapsed_ms": 12}))
    try:
        r = HttpReasoner(lane.url).complete([{"role": "user", "content": "hi"}], response_schema={"type": "object"},
                                            effort="low", max_tokens=100)
        path, body = lane.bodies[0]
        assert path == "/api/inference/reason"
        assert body["max_tokens"] == 1800 and body["effort"] == "low" and body["response_schema"] == {"type": "object"}
        assert "images" not in body
        assert r.content == {"ok": True} and r.model == "muse-spark-1.3" and r.route == "meta"
    finally:
        lane.close()


def test_http_reasoner_errors():
    lane = _ReasonLane(lambda b: (200, {"content": None, "model": "m"}))
    try:
        with pytest.raises(ReasonerError, match="no content"):
            HttpReasoner(lane.url).complete([{"role": "user", "content": "hi"}])
        with pytest.raises(ReasonerError, match="text-only"):
            HttpReasoner(lane.url).complete([{"role": "user", "content": [{"type": "image_url"}]}])
    finally:
        lane.close()
    lane = _ReasonLane(lambda b: (503, {"error": "route_disabled", "message": "off"}))
    try:
        with pytest.raises(ReasonerError, match="HTTP 503"):
            HttpReasoner(lane.url, sleep=lambda _: None).complete([{"role": "user", "content": "hi"}])
    finally:
        lane.close()


def test_parse_json_content_variants():
    assert parse_json_content('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_content('Here: {"a": 2} done') == {"a": 2}
    assert parse_json_content({"a": 3}) == {"a": 3}
    with pytest.raises(ReasonerError):
        parse_json_content(None)


@pytest.mark.skipif(not os.environ.get("AUTOPHYS_LIVE_REASON_URL"), reason="set AUTOPHYS_LIVE_REASON_URL to run the live smoke")
def test_live_reason_lane_smoke():
    """Opt-in: one real decision through a running hacks-site reason lane. Prints nothing secret."""
    from autophys.agent import ReasonLanePolicy

    view, _ = thermal_case(0)
    policy = ReasonLanePolicy(HttpReasoner(os.environ["AUTOPHYS_LIVE_REASON_URL"]))
    inv = Investigation(Project(view.name, view.simulator, budgets=Budgets(max_steps=1)), view.dataset, view.runner, policy=policy)
    decision, trace = policy.decide(inv.facts())
    assert decision["action"] in ("optimize_parameters", "inspect_data")


# --- /api/v1 stream ------------------------------------------------------


def _pending_proposal(store):
    pid = store.ensure_project("p")
    cfg = {"name": "p"}
    ver = store.put_config_version(pid, config_hash(cfg), cfg)
    inv = store.create_investigation({"project_id": pid, "config_version": ver})
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "proposed", "experiment": "e", "settings": {}})
    return inv


def _never_poll(_s):
    pytest.fail("polled although the stream is available")


def test_default_server_is_the_loopback_daemon():
    assert DEFAULT_SERVER == "http://127.0.0.1:4794"


def test_wait_for_approval_consumes_the_stream_from_the_cursor(server):
    store = HttpStore(server.url, server.issue_key())
    inv = _pending_proposal(store)
    head = store.cursors[inv]
    assert head == server.gseq  # POST responses advance the cursor
    timer = threading.Timer(0.3, server.approve_record, (inv, "p1"))
    timer.start()
    try:
        p = store.wait_for_approval(inv, "p1", timeout=10, sleep=_never_poll)
    finally:
        timer.cancel()
    assert p["status"] == "approved" and store.last_wait == "stream"
    first = store.cursors[inv]
    assert server.stream_afters == [head] and first == server.gseq  # the approval's id advanced it
    store.append(inv, "proposal", {"proposal_id": "p2", "event": "proposed", "experiment": "e", "settings": {}})
    second = store.cursors[inv]
    timer = threading.Timer(0.3, server.approve_record, (inv, "p2", "rejected"))
    timer.start()
    try:
        assert store.wait_for_approval(inv, "p2", timeout=10, sleep=_never_poll)["status"] == "rejected"
    finally:
        timer.cancel()
    assert server.stream_afters == [head, second]  # the second wait resumed from the cursor



def test_wait_for_approval_reconnects_after_idle_and_resumes(server):
    store = HttpStore(server.url, server.issue_key(), stream_idle=0.2)  # the fake keeps alive every 0.5 s
    inv = _pending_proposal(store)
    head = server.gseq
    timer = threading.Timer(0.7, server.approve_record, (inv, "p1", "edited", {"amplitude": 1.0}))
    timer.start()
    try:
        p = store.wait_for_approval(inv, "p1", timeout=10, sleep=_never_poll)
    finally:
        timer.cancel()
    assert p["status"] == "edited" and p["settings"] == {"amplitude": 1.0}
    # POSTs and stream events share the same cursor.
    assert server.stream_afters[0] == head and len(server.stream_afters) >= 2
    assert set(server.stream_afters[1:]) == {head}



def test_wait_for_approval_falls_back_to_polling_without_a_stream():
    with FakeAutophys(stream=False) as s:
        store = HttpStore(s.url, s.issue_key())
        inv = _pending_proposal(store)
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            s.approve_record(inv, "p1", "rejected")

        assert store.wait_for_approval(inv, "p1", interval=7, sleep=sleep)["status"] == "rejected"
        assert store.last_wait == "poll" and sleeps == [7]
        assert any(m == "GET" and p == "/stream" for m, p, _ in s.requests)  # tried the stream first



def test_wait_for_approval_stream_false_polls(server):
    store = HttpStore(server.url, server.issue_key())
    inv = _pending_proposal(store)
    server.approve_record(inv, "p1")
    assert store.wait_for_approval(inv, "p1", stream=False, sleep=_never_poll)["status"] == "approved"
    assert store.last_wait == "poll" and server.stream_afters == []


def test_stream_rejects_a_bad_key(server):
    store = HttpStore(server.url, "apk_wrong")
    with pytest.raises(HttpError) as e:
        store.stream("inv_0000000000000000", after=0)
    assert e.value.status == 401


def test_iter_sse_parses_frames():
    body = [b": keep-alive\n", b"\n", b"id: 7\r\n", b"event: record\n", b"data: {\"a\":\n", b"data: 1}\n", b"\n",
            b"data:plain\n", b"\n", b"event: other\n", b"\n"]
    evs = list(iter_sse(body))
    assert [(e.event, e.id, e.data) for e in evs] == [("record", "7", "{\"a\":\n1}"), ("message", "7", "plain")]


def test_streams_are_scoped_with_a_cursor_per_investigation(server):
    """gseq orders one workbook, so each wait streams its own investigation."""
    store = HttpStore(server.url, server.issue_key())
    a = _pending_proposal(store)
    b = _pending_proposal(store)
    assert store.cursors[a] < store.cursors[b]
    timer = threading.Timer(0.3, server.approve_record, (a, "p1"))
    timer.start()
    try:
        assert store.wait_for_approval(a, "p1", timeout=10, sleep=_never_poll)["status"] == "approved"
    finally:
        timer.cancel()
    assert store.last_wait == "stream" and store.cursors[a] == server.gseq
    # b's cursor did not move with a's records.
    assert store.cursors[b] < store.cursors[a]


def test_unscoped_stream_with_a_bare_gseq_is_refused(server):
    with pytest.raises(HttpError) as e:
        request_json("GET", server.url + "/api/v1/stream?after=3", None, api_key=server.issue_key())
    assert e.value.status == 400
