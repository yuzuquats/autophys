"""Python and the Rust daemon writing one collection at the same time (AX-17).

Opt-in: set ``AUTOPHYS_RUST_BIN`` to a built ``autophys`` binary (and
``AUTOPHYS_RUST_WEB_ROOT`` unless it is a deployed bundle). The test
starts its own daemon on a free loopback port with a private collection and
key database, pairs a key through ``pair approve``, and then writes the same
``.ap-workbook`` through both implementations: the SDK's local
``WorkbookStore`` and ``HttpStore`` (whose writes the Rust daemon performs).
"""

import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from autophys.http import HttpStore, pair_poll, pair_start
from autophys.store import config_hash
from autophys.workbook import WorkbookStore

BIN = os.environ.get("AUTOPHYS_RUST_BIN")
# A deployed bundle keeps its web tree beside bin/; a cargo build needs the override.
WEB_ROOT = os.environ.get("AUTOPHYS_RUST_WEB_ROOT") or (
    str(Path(BIN).resolve().parent.parent / "web" / "autophys") if BIN else None)
pytestmark = pytest.mark.skipif(not BIN, reason="set AUTOPHYS_RUST_BIN to a built autophys binary")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def daemon(tmp_path):
    coll, db = tmp_path / "collection", tmp_path / "server.db"
    coll.mkdir()
    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    log = open(tmp_path / "daemon.log", "wb")
    proc = subprocess.Popen([BIN, "serve", "--addr", f"127.0.0.1:{port}", "--collection", str(coll),
                             "--server-db", str(db)]
                            + (["--web-root", WEB_ROOT] if WEB_ROOT and Path(WEB_ROOT).is_dir() else []),
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                urllib.request.urlopen(url + "/api/healthz", timeout=1).close()
                break
            except OSError:
                if proc.poll() is not None or time.monotonic() > deadline:
                    pytest.fail("daemon did not start: " + (tmp_path / "daemon.log").read_text()[-2000:])
                time.sleep(0.1)
        start = pair_start(url, "cross-writer-test")
        subprocess.run([BIN, "pair", "approve", start.user_code, "--collection", str(coll), "--server-db", str(db)],
                       check=True, capture_output=True)
        creds = pair_poll(url, start, "cross-writer-test", sleep=lambda s: time.sleep(min(s, 0.2)))
        def stop():
            # Simulate a crash, including active SSE connections. Graceful
            # shutdown deliberately waits for those connections to drain.
            proc.kill()
            proc.wait(10)

        def restart():
            nonlocal proc
            proc = subprocess.Popen([BIN, "serve", "--addr", f"127.0.0.1:{port}", "--collection", str(coll),
                                     "--server-db", str(db)]
                                    + (["--web-root", WEB_ROOT] if WEB_ROOT and Path(WEB_ROOT).is_dir() else []),
                                    stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 10
            while True:
                try:
                    urllib.request.urlopen(url + "/api/healthz", timeout=.2).close()
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise TimeoutError("daemon did not restart")
                    time.sleep(.05)

        yield {"url": url, "coll": coll, "db": db, "key": creds.api_key, "key_id": creds.key_id,
               "stop": stop, "restart": restart}
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log.close()


def _rust_verify(d) -> dict:
    out = subprocess.run([BIN, "db", "verify", "--json", "--collection", str(d["coll"]), "--server-db", str(d["db"])],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def _pinned(wb):
    pid = wb.ensure_project("p")
    cfg = {"name": "p"}
    ver = wb.put_config_version(pid, config_hash(cfg), cfg)
    return wb.create_investigation({"project_id": pid, "config_version": ver})


def _proposed(pid):
    return {"proposal_id": pid, "event": "proposed", "experiment": "e", "settings": {"x": 1.0}}


def test_rust_daemon_and_python_share_one_workbook(daemon):
    with WorkbookStore(daemon["coll"] / "p.ap-workbook") as wb:
        inv = _pinned(wb)
        wb.append(inv, "proposal", _proposed("p1"))
        http = HttpStore(daemon["url"], daemon["key"], key_id=daemon["key_id"])

        # 1. Rust writes the approval; the local waiter sees it through data_version.
        seen = {}
        waiter = threading.Thread(target=lambda: seen.update(wb.wait_for_approval(inv, "p1", timeout=20)))
        waiter.start()
        time.sleep(0.3)
        http.append(inv, "proposal", {"proposal_id": "p1", "event": "approved", "by": "rust", "via": "sdk"})
        waiter.join(25)
        assert seen.get("status") == "approved"

        # 2. Python's atomic attach is visible to Rust as two consecutive records.
        wb.append_batch(inv, [("measurement", {"version": 1, "observation": {}}),
                              ("proposal", {"proposal_id": "p1", "event": "data_attached", "measurement_version": 1})])
        assert http.proposal(inv, "p1")["status"] == "data_attached"
        kinds = [r.kind for r in http.records(inv)]
        assert kinds[-2:] == ["measurement", "proposal"]

        # 3. Both sides append at once; every write lands once, in one chain.
        errors = []

        def local():
            try:
                for i in range(25):
                    wb.append(inv, "proposal", _proposed(f"py{i}"))
            except Exception as e:  # noqa: BLE001 - reported below
                errors.append(e)

        def remote():
            try:
                for i in range(25):
                    http.append(inv, "proposal", _proposed(f"rs{i}"))
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=local), threading.Thread(target=remote)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        assert not errors
        recs = wb.records(inv)
        assert [r.seq for r in recs] == list(range(len(recs)))
        ids = {r.payload.get("proposal_id") for r in recs}
        assert {f"py{i}" for i in range(25)} | {f"rs{i}" for i in range(25)} <= ids
        assert [r.id for r in http.records(inv)] == [r.id for r in recs]

        # 4. Both implementations agree the workbook is intact.
        check = wb.check()
        assert check["ok"] and check["projections_match"], check
        [rust] = _rust_verify(daemon)
        assert rust["project"] == "p" and not rust["rebuilt"], rust
        assert rust["report"] == {"ok": True, "records": len(recs), "investigations": 1,
                                  "chain_errors": [], "projections_match": True}, rust


def test_B1_real_daemon_wait_deadline(daemon):
    http = HttpStore(daemon["url"], daemon["key"], stream_idle=30)
    inv = _pinned(http)
    http.append(inv, "proposal", _proposed("p1"))
    start = time.monotonic()
    with pytest.raises(TimeoutError):
        http.wait_for_approval(inv, "p1", timeout=3)
    assert 2.9 <= time.monotonic() - start < 4


@pytest.mark.parametrize("stream", [True, False])
def test_B6_real_daemon_wait_survives_restart(daemon, stream):
    http = HttpStore(daemon["url"], daemon["key"], stream_idle=.2, timeout=.3)
    inv = _pinned(http)
    http.append(inv, "proposal", _proposed("p1"))
    errors, result = [], []
    def wait():
        try:
            result.append(http.wait_for_approval(inv, "p1", timeout=15, interval=.1, stream=stream))
        except BaseException as error:
            errors.append(error)
    thread = threading.Thread(target=wait)
    thread.start()
    try:
        time.sleep(.1)
        daemon["stop"]()
        time.sleep(.3)
        daemon["restart"]()
        http.append(inv, "proposal", {"proposal_id": "p1", "event": "approved", "by": "test"})
    finally:
        thread.join(16)
    assert not thread.is_alive() and not errors
    assert result[0]["status"] == "approved"


def test_A5_real_daemon_blob_route_when_available(daemon):
    from autophys.http import HttpError
    http = HttpStore(daemon["url"], daemon["key"])
    _pinned(http)
    try:
        key = http.put_blob(b"playbook bytes", "text/markdown")
    except HttpError as error:
        if error.status in (404, 405):
            pytest.skip("installed daemon does not expose project blob PUT yet")
        raise
    assert http.get_blob(key) == (b"playbook bytes", "text/markdown")


def test_overviews_cross_the_rust_daemon_and_a_local_writer(daemon):
    md = '# Daemon é\n\n<ap-investigation investigation="inv_gone"></ap-investigation>\n'
    with WorkbookStore(daemon["coll"] / "p.ap-workbook") as wb:
        inv = _pinned(wb)
        pid = wb.ensure_project("p")
        http = HttpStore(daemon["url"], daemon["key"], key_id=daemon["key_id"])
        assert http.overview(pid) is None and http.overview_versions(pid) == []
        stored, changed, warnings = http.put_overview(pid, md, "rust")
        assert changed and stored["markdown"] == md
        assert [(w["code"], w["investigation"]) for w in warnings] == [("unknown_investigation", "inv_gone")]
        assert wb.overview(pid) == stored, "the daemon's write is the local reader's"
        assert http.put_overview(pid, md, "someone")[:2] == (stored, False)
        local = f'# Local\n\n<ap-investigation investigation="{inv}"></ap-investigation>\n'
        mine, changed, warnings = wb.put_overview(pid, local, "python")
        assert changed and warnings == []
        assert http.overview(pid) == mine
        assert http.overview_versions(pid) == [stored, mine]
    assert all(r["report"]["ok"] for r in _rust_verify(daemon))
