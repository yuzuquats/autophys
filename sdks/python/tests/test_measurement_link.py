"""RR1-b: a ``data_attached`` event links its measurement by record hash.

Python writes ``measurement_version`` as the measurement record's hash in
every store, as Rust's ``attach_data`` does: HttpStore through the batch
envelope's ``hash_of``, the local stores through the same ``hash_of`` in
their ``append_batch``. Events written before RR1-b hold the dataset version
integer; readers accept both.
"""
from dataclasses import replace

import pytest

from fake_server import FakeAutophys
from autophys.agent import Investigation, ProposalRunner
from autophys.http import HttpStore
from autophys.store import JsonlStore, MemoryStore, StoreError, config_hash
from autophys.synthetic import battery_case, case_project
from autophys.workbook import WorkbookStore

PULSE = 1 + 300 / 3600  # pulse_2A's cost_hours in the battery catalogue


@pytest.fixture(params=["memory", "jsonl", "workbook", "http"])
def store(request, tmp_path):
    if request.param == "http":
        with FakeAutophys() as server:
            yield HttpStore(server.url, server.issue_key())
        return
    yield {"memory": MemoryStore, "jsonl": lambda: JsonlStore(tmp_path / "j"),
           "workbook": lambda: WorkbookStore(tmp_path / "w.ap-workbook")}[request.param]()


def battery(store):
    view, _ = battery_case()
    project = case_project(view)
    project.budgets = replace(project.budgets, max_test_hours=10.0)
    return Investigation(project, view.dataset, ProposalRunner(), store=store), view


def approved(inv, store):
    pid = inv.tool_request_experiment("pulse_2A")["proposal_id"]
    if isinstance(store, HttpStore):
        store.append(inv.id, "proposal", {"proposal_id": pid, "event": "approved", "by": "test"})
        inv.pending = pid
    else:
        inv.approve(pid)
    return pid


def test_attach_data_links_the_measurement_by_hash_in_every_store(store):
    inv, view = battery(store)
    pid = approved(inv, store)
    sent = []
    if isinstance(store, HttpStore):
        req = inv.store._req
        inv.store._req = lambda method, path, body=None, **kw: (sent.append(body), req(method, path, body, **kw))[1]
    inv.attach_data(pid, view.runner.run("pulse_2A"))
    records = store.records(inv.id)
    measurement = [r for r in records if r.kind == "measurement"][-1]
    event = records[-1]
    assert event.payload["event"] == "data_attached" and event.seq == measurement.seq + 1
    assert event.payload["measurement_version"] == measurement.hash
    assert measurement.payload["version"] == inv.dataset.version  # the measurement keeps its dataset version
    assert store.verify(inv.id) if not isinstance(store, HttpStore) else True
    if isinstance(store, HttpStore):
        batch = [b for b in sent if isinstance(b, dict) and "records" in b][-1]["records"]
        assert batch[1]["hash_of"] == {"measurement_version": 0}
        assert "measurement_version" not in batch[1]["payload"]
    # Resume reads the hash link: the attached data costs once.
    resumed = Investigation.resume(inv.project, store, inv.id)
    assert resumed.test_hours_used == pytest.approx(PULSE)


@pytest.mark.parametrize("kind", ["memory", "jsonl", "workbook"])
def test_local_append_batch_hash_of(tmp_path, kind):
    store = {"memory": MemoryStore, "jsonl": lambda: JsonlStore(tmp_path / "j"),
             "workbook": lambda: WorkbookStore(tmp_path / "w.ap-workbook")}[kind]()
    pid = store.ensure_project("thermal")
    cfg = {"name": "thermal"}
    inv = store.create_investigation({"project_id": pid, "config_version": store.put_config_version(pid, config_hash(cfg), cfg)})
    first = store.append_batch(inv, [("run", {"n": 1}, "r-1"), ("step", {"n": 2}, "s-1", {"run": 0})])
    assert first[1].payload == {"n": 2, "run": first[0].hash}
    # A replayed earlier record still lends its stored hash.
    again = store.append_batch(inv, [("run", {"n": 1}, "r-1"), ("step", {"n": 3}, None, {"run": 0})])
    assert again[0] == first[0] and again[1].payload["run"] == first[0].hash
    count = len(store.records(inv))
    for bad in ([("run", {"n": 4}, None, {"x": 0})],  # names itself
                [("run", {"n": 4}), ("step", {"n": 5, "x": 1}, None, {"x": 0})],  # field also in the payload
                [("run", {"n": 4}), ("step", {"n": 5}, None, {"x": 2})],  # names a later record
                [("run", {"n": 4}), ("step", {"n": 5}, None, ["x"])]):
        with pytest.raises(StoreError, match="hash_of"):
            store.append_batch(inv, bad)
    assert len(store.records(inv)) == count


@pytest.mark.parametrize("kind", ["memory", "workbook"])
def test_mixed_integer_and_hash_links_resume(tmp_path, kind):
    """A log holding an event written before RR1-b (integer dataset version)
    and one written after (record hash) resolves both lab names."""
    store = MemoryStore() if kind == "memory" else WorkbookStore(tmp_path / "w.ap-workbook")
    inv, view = battery(store)
    # Before RR1-b, Python's attach_data wrote the dataset version as the link.
    pid = approved(inv, store)
    old = view.runner.run("pulse_2A")
    old.experiment = "lab-trace-old"
    version = inv.dataset.version + 1
    store.append_batch(inv.id, [
        ("measurement", {"version": version, "digest": "d", "observation": old.to_dict()}),
        ("proposal", {"proposal_id": pid, "event": "data_attached", "measurement_version": version, "digest": old.digest()})])
    inv = Investigation.resume(inv.project, store, inv.id, runner=ProposalRunner())
    assert inv.test_hours_used == pytest.approx(PULSE)
    # Now the current attach_data, which links by hash.
    pid = approved(inv, store)
    new = view.runner.run("pulse_2A")
    new.experiment = "lab-trace-new"
    inv.attach_data(pid, new)
    links = [r.payload["measurement_version"] for r in store.records(inv.id, "proposal")
             if r.payload["event"] == "data_attached"]
    assert links[0] == version and links[1] == store.records(inv.id, "measurement")[-1].hash
    resumed = Investigation.resume(inv.project, store, inv.id)
    assert resumed.test_hours_used == pytest.approx(2 * PULSE)


from test_cross_writer import BIN, daemon  # noqa: E402,F401 - the opt-in real daemon fixture
from test_review_regressions import pending  # noqa: E402


@pytest.mark.skipif(not BIN, reason="set AUTOPHYS_RUST_BIN to a built autophys binary")
def test_real_daemon_fills_the_hash_link(daemon):  # noqa: F811
    store = HttpStore(daemon["url"], daemon["key"])
    inv, view, _ = pending(store)
    pid, experiment = inv.pending, inv.pending_experiment
    inv.approve(pid)
    inv.attach_data(pid, view.runner.run(experiment))
    records = inv.store.records(inv.id)
    assert records[-1].payload["event"] == "data_attached"
    assert records[-1].payload["measurement_version"] == records[-2].hash and records[-2].kind == "measurement"
