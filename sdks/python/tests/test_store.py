import json

import pytest

from autophys.store import JsonlStore, MemoryStore, StoreError, config_hash

CFG = {"name": "p", "params": {"a": {"lo": 0.1, "hi": 1.0}}}


def pinned(store):
    pid = store.ensure_project("p")
    ver = store.put_config_version(pid, config_hash(CFG), CFG)
    return store.create_investigation({"project_id": pid, "config_version": ver, "title": "t"})


@pytest.fixture(params=["memory", "jsonl"])
def store(request, tmp_path):
    return MemoryStore() if request.param == "memory" else JsonlStore(tmp_path / "records")


def test_append_only_chain(store):
    inv = pinned(store)
    store.append(inv, "measurement", {"version": 1, "observation": {}})
    store.append(inv, "run", {"loss": 1.5, "nan": float("nan")})
    recs = store.records(inv)
    assert [r.kind for r in recs] == ["investigation", "measurement", "run"]
    assert [r.seq for r in recs] == [0, 1, 2]
    assert recs[2].payload["nan"] is None
    assert store.verify(inv)
    assert store.records(inv, "run")[0].payload["loss"] == 1.5


def test_idempotent_record_ids(store):
    inv = pinned(store)
    a = store.append(inv, "step", {"i": 1}, record_id="r1")
    b = store.append(inv, "step", {"i": 1}, record_id="r1")
    assert a.seq == b.seq and len(store.records(inv, "step")) == 1


def test_kinds_and_proposal_events(store):
    inv = pinned(store)
    with pytest.raises(StoreError):
        store.append(inv, "dataset", {})
    with pytest.raises(StoreError):
        store.append(inv, "proposal", {"proposal_id": "p1", "event": "maybe"})
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "proposed", "experiment": "e", "settings": {"x": 1}})
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {"x": 2}})
    st = store.proposal_status(inv, "p1")
    assert st["status"] == "edited" and st["settings"] == {"x": 2} and st["events"] == ["proposed", "edited"]


def test_projects_and_config_versions(store):
    pid = store.ensure_project("p")
    assert store.ensure_project("p") == pid
    v = config_hash(CFG)
    store.put_config_version(pid, v, CFG)
    store.put_config_version(pid, v, CFG)
    assert [c["version"] for c in store.config_versions(pid)] == [v]
    with pytest.raises(StoreError, match="hash"):
        store.put_config_version(pid, "sha256:" + "0" * 64, CFG)
    with pytest.raises(StoreError, match="config_version"):
        store.create_investigation({"project_id": pid})
    with pytest.raises(StoreError, match="not stored"):
        store.create_investigation({"project_id": pid, "config_version": "sha256:" + "1" * 64})


def test_jsonl_tamper_detected(tmp_path):
    store = JsonlStore(tmp_path)
    inv = pinned(store)
    store.append(inv, "run", {"loss": 1.0})
    path = tmp_path / f"{inv}.jsonl"
    lines = path.read_text().splitlines()
    rec = json.loads(lines[1])
    rec["payload"]["loss"] = 0.5
    lines[1] = json.dumps(rec)
    path.write_text("\n".join(lines) + "\n")
    assert not store.verify(inv)
    # a fresh store over the same directory reads the same log
    assert len(JsonlStore(tmp_path).records(inv)) == 2
