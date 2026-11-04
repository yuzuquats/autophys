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
        yield {"url": url, "coll": coll, "db": db, "key": creds.api_key, "key_id": creds.key_id}
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
