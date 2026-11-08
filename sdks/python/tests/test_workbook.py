"""WorkbookStore: the .ap-workbook format (workbook-format.md) from Python."""

import os
import sqlite3
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from autophys.store import GENESIS, config_hash
from autophys.workbook import APPLICATION_ID, INITIAL_VERSION, WorkbookError, WorkbookStore, slug

CFG = {"name": "p", "params": {"a": {"lo": 0.1, "hi": 1.0}}}
OUTLOOK = {"axes": [{"name": "freq", "values": [0.1, 0.5, 2.0]}], "score": [1.0, 2.0, 3.0], "after": {"a": [0.3, 0.2, 0.1]}}


@pytest.fixture
def wb(tmp_path):
    with WorkbookStore(tmp_path / "p.ap-workbook") as s:
        yield s


def pinned(store, **meta):
    pid = store.ensure_project("p")
    ver = store.put_config_version(pid, config_hash(CFG), CFG)
    return store.create_investigation({"project_id": pid, "config_version": ver, "title": "t", **meta})


def propose(store, inv, pid="p1", outlook=OUTLOOK):
    payload = {"proposal_id": pid, "event": "proposed", "experiment": "sine", "settings": {"kind": "sine", "freq": 0.5, "amp": 1.0}}
    if outlook is not None:
        payload["outlook"] = outlook
    return store.append(inv, "proposal", payload)


def code(exc_info):
    return exc_info.value.error, exc_info.value.path


def test_new_file_is_a_versioned_wal_workbook(tmp_path):
    path = tmp_path / "sub" / "p.ap-workbook"
    WorkbookStore(path).close()
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
    assert conn.execute("PRAGMA user_version").fetchone()[0] == INITIAL_VERSION == 1
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert tables == {"records", "investigations", "proposals", "projects", "config_versions", "blobs"}
    assert "keys" not in tables and "pairings" not in tables


def test_foreign_and_newer_files_are_refused(tmp_path):
    other = tmp_path / "other.db"
    sqlite3.connect(other).execute("CREATE TABLE t (x)")
    with pytest.raises(WorkbookError, match="not an autophys workbook"):
        WorkbookStore(other)
    newer = tmp_path / "newer.ap-workbook"
    WorkbookStore(newer).close()
    c = sqlite3.connect(newer)
    c.execute("PRAGMA user_version = 99")
    c.commit()
    c.close()
    with pytest.raises(WorkbookError, match="format 99"):
        WorkbookStore(newer)
    with pytest.raises(WorkbookError, match="no workbook"):
        WorkbookStore(tmp_path / "missing.ap-workbook", create=False)


def test_one_project_per_workbook(wb):
    pid = wb.ensure_project("p")
    assert wb.ensure_project("p") == pid and pid.startswith("prj_") and len(pid) == 20
    with pytest.raises(WorkbookError, match="holds project 'p'"):
        wb.ensure_project("q")


def test_slug():
    assert slug("Heated Block / v2") == "heated-block-v2"
    assert slug("..") == "project" and slug("a.b_c-d") == "a.b_c-d"


def test_chain_projections_and_check(wb):
    inv = pinned(wb, overrides={"free": ["a"]})
    assert inv.startswith("inv_") and len(inv) == 20
    wb.append(inv, "measurement", {"observation": {"t": [0.0]}})
    wb.append(inv, "run", {"loss": 1.5, "nan": float("nan")})
    recs = wb.records(inv)
    assert [r.seq for r in recs] == [0, 1, 2] and recs[0].prev_hash == GENESIS
    assert recs[2].payload["nan"] is None
    assert recs[0].ts == round(recs[0].ts, 6)
    assert wb.verify(inv)
    [row] = wb.investigations()
    assert row["status"] == "open" and row["budget_used"] == 1 and row["overrides"] == {"free": ["a"]}
    assert row["updated"] == recs[2].ts
    propose(wb, inv)
    assert wb.investigations()[0]["status"] == "awaiting_approval"
    wb.append(inv, "proposal", {"proposal_id": "p1", "event": "approved", "by": "me"})
    assert wb.investigations()[0]["status"] == "awaiting_data"
    wb.append(inv, "proposal", {"proposal_id": "p1", "event": "data_attached", "measurement_version": 2})
    wb.append(inv, "outcome", {"status": "validated"})
    assert wb.investigations()[0]["status"] == "validated"
    assert wb.proposal(inv, "p1")["status"] == "data_attached"
    report = wb.check()
    assert report == {"ok": True, "records": 7, "investigations": 1, "chain_errors": [], "projections_match": True}


def test_idempotent_replay_and_conflict(wb):
    inv = pinned(wb)
    a = wb.append(inv, "step", {"i": 1}, record_id="r1")
    assert wb.append(inv, "step", {"i": 1}, record_id="r1") == a
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "step", {"i": 2}, record_id="r1")
    assert e.value.error == "idempotency_conflict"
    meta = {"project_id": wb.projects()[0]["id"], "config_version": config_hash(CFG)}
    assert wb.create_investigation(meta, record_id="k1") == wb.create_investigation(meta, record_id="k1")


def test_validation_names_the_field(wb):
    inv = pinned(wb)
    cases = [
        (("step", {}, "a b"), ("invalid", "id")),
        (("measurement", {}, None), ("invalid", "payload.observation")),
        (("outcome", {"status": ""}, None), ("invalid", "payload.status")),
        (("proposal", {"proposal_id": "p", "event": "maybe"}, None), ("invalid", "payload.event")),
        (("proposal", {"proposal_id": "p", "event": "proposed", "experiment": "e",
                       "outlook": {**OUTLOOK, "score": [1.0, None, 3.0]}}, None), ("invalid", "payload.outlook.score[1]")),
        (("proposal", {"proposal_id": "p", "event": "proposed", "experiment": "e",
                       "outlook": {**OUTLOOK, "after": {"a": [1, 2]}}}, None), ("invalid", "payload.outlook.after.a")),
        (("proposal", {"proposal_id": "p", "event": "proposed", "experiment": "e",
                       "outlook": {**OUTLOOK, "score": [True, 2, 3]}}, None), ("invalid", "payload.outlook.score[0]")),
        (("dataset", {}, None), ("invalid", "kind")),
    ]
    for (kind, payload, rid), want in cases:
        with pytest.raises(WorkbookError) as e:
            wb.append(inv, kind, payload, record_id=rid)
        assert code(e) == want, (kind, payload)
    with pytest.raises(WorkbookError, match="create_investigation"):
        wb.append(inv, "investigation", {"project_id": "x", "config_version": "y"})
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "step", {"blob": "x" * (1 << 20)})
    assert e.value.error == "too_large"
    with pytest.raises(WorkbookError) as e:
        wb.append("inv_missing", "step", {})
    assert e.value.error == "not_found"


def test_config_versions_are_hash_checked_and_pinned(wb):
    pid = wb.ensure_project("p")
    with pytest.raises(WorkbookError) as e:
        wb.put_config_version(pid, "sha256:" + "0" * 64, CFG)
    assert e.value.error == "hash_mismatch"
    with pytest.raises(WorkbookError) as e:
        wb.create_investigation({"project_id": pid, "config_version": config_hash(CFG)})
    assert e.value.error == "unknown_config_version"
    v = wb.put_config_version(pid, config_hash(CFG), CFG)
    assert wb.put_config_version(pid, v, CFG) == v
    assert wb.config_versions(pid) == [{"version": v, "config": CFG}]


def test_proposal_state_machine(wb):
    inv = pinned(wb)
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "approved"})
    assert e.value.error == "not_found"
    propose(wb, inv)
    with pytest.raises(WorkbookError) as e:
        propose(wb, inv)
    assert e.value.error == "proposal_exists"
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "data_attached", "measurement_version": 1})
    assert e.value.error == "conflict"
    wb.append(inv, "proposal", {"proposal_id": "p1", "event": "rejected", "reason": "no"})
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "approved"})
    assert e.value.error == "conflict"
    propose(wb, inv, "p2")
    wb.append(inv, "proposal", {"proposal_id": "p2", "event": "withdrawn"})
    assert wb.proposal(inv, "p2")["status"] == "withdrawn"
    assert wb.investigations()[0]["status"] == "open"


def test_edits_stay_on_outlook_axes(wb):
    inv = pinned(wb)
    propose(wb, inv)
    base = {"kind": "sine", "freq": 0.5, "amp": 1.0}
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, "freq": 2.5}})
    assert code(e) == ("invalid", "payload.settings.freq")
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, "amp": 2.0}})
    assert code(e) == ("invalid", "payload.settings.amp")
    with pytest.raises(WorkbookError) as e:
        wb.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, "freq": "fast"}})
    assert code(e) == ("invalid", "payload.settings.freq")
    wb.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, "freq": 2.0 + 1e-12}})
    p = wb.proposal(inv, "p1")
    assert p["status"] == "edited" and p["settings"]["freq"] == pytest.approx(2.0)
    # without an outlook nothing is checked: the store cannot know what is editable
    propose(wb, inv, "p2", outlook=None)
    wb.append(inv, "proposal", {"proposal_id": "p2", "event": "edited", "settings": {"anything": 1}})


def test_records_are_append_only_and_check_finds_tampering(tmp_path):
    path = tmp_path / "p.ap-workbook"
    with WorkbookStore(path) as wb:
        inv = pinned(wb)
        propose(wb, inv)
    raw = sqlite3.connect(path)
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        raw.execute("UPDATE records SET payload = '{}'")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        raw.execute("DELETE FROM records")
    raw.execute("UPDATE proposals SET state = 'approved'")
    raw.commit()
    with WorkbookStore(path) as wb:
        r = wb.check()
        assert r["projections_match"] is False and r["chain_errors"] == [] and not r["ok"]
    raw.execute("DROP TRIGGER records_no_update")
    raw.execute("UPDATE records SET payload = '{\"project_id\":\"x\",\"config_version\":\"y\"}' WHERE seq = 0")
    raw.commit()
    raw.close()
    with WorkbookStore(path, readonly=True) as wb:
        assert wb.check()["chain_errors"] == [{"investigation": inv, "seq": 0, "id": wb.records(inv)[0].id}]
        with pytest.raises(WorkbookError, match="read-only"):
            wb.append(inv, "step", {})


def test_blobs_are_content_addressed(wb):
    key = wb.put_blob(b"\x00\x01data", "application/x-npy")
    assert key.startswith("sha256:") and wb.put_blob(b"\x00\x01data", "application/x-npy") == key
    assert wb.get_blob(key) == (b"\x00\x01data", "application/x-npy")
    with pytest.raises(WorkbookError):
        wb.get_blob("sha256:none")


def test_wait_sees_another_threads_write_on_the_same_store(wb):
    inv = pinned(wb)
    propose(wb, inv)
    threading.Timer(0.2, lambda: wb.append(inv, "proposal", {"proposal_id": "p1", "event": "approved"})).start()
    st = wb.wait_for_approval(inv, "p1", timeout=5)
    assert st["status"] == "approved"
    with pytest.raises(TimeoutError):
        propose(wb, inv, "p2")
        wb.wait_for_approval(inv, "p2", timeout=0.3)


def test_another_process_approves_while_the_sdk_waits(tmp_path):
    """The SDK and the browser viewer are different processes writing one file."""
    path = tmp_path / "p.ap-workbook"
    wb = WorkbookStore(path)
    inv = pinned(wb)
    propose(wb, inv)
    src = Path(__file__).resolve().parents[1] / "src"
    viewer = textwrap.dedent(f"""
        import time
        from autophys.workbook import WorkbookStore
        time.sleep(0.3)
        with WorkbookStore({str(path)!r}) as s:
            s.append({inv!r}, "proposal", {{"proposal_id": "p1", "event": "edited",
                     "settings": {{"kind": "sine", "freq": 0.1, "amp": 1.0}}, "by": "viewer"}})
    """)
    env = {**os.environ, "PYTHONPATH": str(src), "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.Popen([sys.executable, "-I", "-B", "-c", f"import sys; sys.path.insert(0, {str(src)!r})\n" + viewer], env=env)
    t0 = time.monotonic()
    st = wb.wait_for_approval(inv, "p1", timeout=20)
    assert proc.wait(timeout=20) == 0
    assert st["status"] == "edited" and st["settings"]["freq"] == 0.1
    assert time.monotonic() - t0 < 10
    assert wb.check()["ok"]
    wb.close()


def _curve_run(points, rid="m1", pad=0):
    values = [1.0] * points
    run = {"fit_id": 1, "curves": {rid: {"fit": {"v": values}, "initial": {"v": values}}}}
    if pad:
        run["note"] = "x" * pad
    return run


def test_run_curves_bounds_match_rust():
    from autophys.workbook import WorkbookError, payload_shape
    payload_shape("run", _curve_run(2000))
    with pytest.raises(WorkbookError, match="2000 curve points"):
        payload_shape("run", _curve_run(2001))
    with pytest.raises(WorkbookError, match="may contain only"):
        payload_shape("run", _curve_run(3, rid="bad id"))
    with pytest.raises(WorkbookError) as err:
        payload_shape("run", _curve_run(3, pad=300_000))
    assert err.value.error == "too_large"
    payload_shape("run", {"fit_id": 1, "note": "x" * 300_000})  # no curves: the 1 MiB limit applies
