"""Format-1 reference bytes and the presentation/physics identity boundary."""
import copy
import hashlib
import json
import pickle
from pathlib import Path

import numpy as np
import pytest

from autophys import Display, Project, simulator
from autophys.synthetic import case_project
from autophys.client import RemoteClient
from autophys.http import HttpError, HttpStore
from autophys.models import battery_ecm, oscillator, thermal_rc
from autophys.simulator import CallBudget, SimulationError
from autophys.store import MemoryStore, JsonlStore, StoreError, canonical
from autophys.synthetic import CASES
from autophys.workbook import WorkbookStore
from fake_server import FakeAutophys

PINS = {'oscillator-free-only': ['sha256:7f5fbe29b561af77f7645bf236187bd210a98a1c9fb385437b11687fc27b7d7c', 'sha256:b2a93a6b049bcde4ee57d9509a890fe7d853d0e5a3d364decc9f33278e90a3be'], 'oscillator': ['sha256:7f5fbe29b561af77f7645bf236187bd210a98a1c9fb385437b11687fc27b7d7c', 'sha256:db6e9a07907ef31dc2410d0fb314ab16a943e8d28ab54dd357564b3c57ba50f5'], 'thermal-short-only': ['sha256:80664bb0ec18f4f30f82e20f22c9768815deb88a0679c041c4365d96b2a6836f', 'sha256:2817f542ac1b9b588e9d7843092dbdfba1840422ec492791e0ac6e2cb6d6123f'], 'thermal': ['sha256:80664bb0ec18f4f30f82e20f22c9768815deb88a0679c041c4365d96b2a6836f', 'sha256:5376c25da7a34ac8f0e34e5ba2e6b0447674c73126819ed144fde43ed313b561'], 'battery-short-only': ['sha256:daeb931d6d04bf5dd70209cab126772af275386020e54a94e1ee6fab4a75cfca', 'sha256:7286184db7c4b0035ff1df1aa0902c1ac1d4d7538917121aad86b4b27a472790'], 'battery': ['sha256:daeb931d6d04bf5dd70209cab126772af275386020e54a94e1ee6fab4a75cfca', 'sha256:06425c23cabd475fcf3e75f1cddd1c0ea8c0a4906cd1032f45dbea31a5f9c230']}
GOLDENS = {
    "battery_ecm": "e1aea0cbe6f8065c8b642d4aeb895509290ae3b30eb6496373c2a17d70c3f5fd",
    "oscillator": "824b945f5f05e47112940e0dfddbafc42a05e6bd0e3f40e9759b3b91ef3abe96",
    "thermal_rc": "e19385e061d7fa85fd0fffc66a21c549976d337d9098606c7105ffd5d0442e11",
}


def toy(display=None):
    @simulator(params={"p": ("", 1., 9.)}, experiments={"pulse": {"kind": "pulse", "duration": 2., "rate": 1.}},
               outputs=("y",), display=display)
    def fn(p, e):
        return {"t": np.array([0., 1., 2.]), "y": np.array([p["p"]] * 3), "u": np.array([0., 1., 0.])}
    return fn


def declaration(**kwargs):
    return Display(channels={"y": {"label": "Y", "unit": "V", "role": "output"},
                             "u": {"label": "U", "unit": "A", "role": "input"}}, **kwargs)


@pytest.mark.parametrize("name", PINS)
def test_hash_pins(name):
    project = case_project(CASES[name](0)[0])
    assert [project.simulator.source_hash, project.config_version] == PINS[name]


@pytest.mark.parametrize("sim", [battery_ecm, oscillator, thermal_rc])
def test_goldens(sim):
    project = Project(sim.name, sim)
    body = sim.display.canonical(project)
    path = Path(__file__).resolve().parents[2] / "rust/src/models/fixtures/display" / (sim.name + ".json")
    assert path.read_bytes() == body
    assert hashlib.sha256(body).hexdigest() == GOLDENS[sim.name]
    assert sim.display.digest(project) == "sha256:" + GOLDENS[sim.name]
    assert body == canonical(json.loads(body)).encode()
    assert sim.display.canonical(project) == body


def test_format_preview_initial_rounding_budget_and_inputs():
    sim = toy(declaration(default_view="fit", params={"p": {"label": "P", "description": "parameter"}}))
    sim.budget = CallBudget(0)
    project = Project("toy", sim, initial={"p": 4.})
    data = sim.display.to_dict(project)
    assert data["format"] == 1 and data["simulator"] == sim.name
    assert data["params"]["p"]["description"] == "parameter"
    assert data["settings"]["kind"] == {"label": "kind", "unit": "", "role": "other"}
    preview = data["experiments"]["pulse"]["preview"]
    t = np.linspace(0, 2, 64)
    assert preview["t"] == [float(f"{v:.6g}") for v in t]
    assert preview["u"]["u"] == [float(f"{v:.6g}") for v in np.interp(t, [0, 1, 2], [0, 1, 0])]
    assert sim.calls == sim.budget.used == 0
    result = sim({"p": 4.}, "pulse", count=False)
    assert set(result) == {"t", "y"}
    assert result["y"].tolist() == [4.] * 3
    assert result.u["u"].tolist() == [0., 1., 0.]
    restored = pickle.loads(pickle.dumps(result))
    for k in result:
        np.testing.assert_array_equal(restored[k], result[k])
    np.testing.assert_array_equal(restored.u["u"], result.u["u"])
    assert type(restored) is type(result)
    assert type(result)({"a": 1}, u={"x": [1]}) == {"a": 1}
    # Geometric midpoint for positive bounds, arithmetic for zero/negative lo.
    assert Project("default", sim).initial_value("p") == 3.
    plain = toy()
    assert plain({"p": 3.}, "pulse", count=False).u == {}


def test_preview_uses_project_initial():
    seen = []
    @simulator(params={"a": ("", -2., 4.)}, outputs=("y",),
               experiments={"e": {"kind": "step", "duration": 1., "rate": 1.}})
    def sim(p, e):
        seen.append(p["a"])
        return {"t": [0., 1.], "y": [0., 0.], "u": [p["a"]] * 2}
    sim.with_display(declaration())
    seen.clear()
    preview = sim.display.to_dict(Project("p", sim, initial={"a": 2.12345678}))["experiments"]["e"]["preview"]
    assert seen == [2.12345678]
    assert preview["u"]["u"] == [2.12346] * 64
    seen.clear()
    sim.display.to_dict(Project("p", sim))
    assert seen == [1.]


@pytest.mark.parametrize("change", [
    {"settings": {"unknown": {"role": "other"}}},
    {"channels": {"missing": {"role": "output"}}},
    {"channels": {"missing": {"role": "input"}}},
    {"experiments": {"pulse": {"views": ["frequency"]}}},
    {"default_view": "unknown"},
    {"settings": {"rate": {"role": "unknown"}}},
    {"channels": {"u": {"role": "unknown"}}},
    {"channels": {"y": {"role": "input"}}},
    {"params": {"unknown": {}}},
    {"experiments": {"unknown": {}}},
    {"inputs": {"unknown": lambda e, t: t}},
    {"channels": {"t": {"role": "input"}}},
])
def test_validation_at_attachment(change):
    args = {"channels": declaration().channels, **change}
    with pytest.raises(ValueError):
        toy().with_display(Display(**args))


def test_invalid_input_shape_and_nonfinite():
    for fn in (lambda e, t: [1.], lambda e, t: np.full(t.shape, np.nan)):
        with pytest.raises(ValueError, match="invalid input"):
            toy().with_display(Display(channels={"drive": {"role": "input"}}, inputs={"drive": fn}))


def test_attachment_does_not_change_identity_and_copies_metadata():
    sim = toy()
    baseline = copy.copy(sim)
    before = sim.schema(), sim.source_hash, Project("p", sim).config_version
    display = declaration()
    assert sim.with_display(display) is sim
    assert sim == baseline
    assert (sim.schema(), sim.source_hash, Project("p", sim).config_version) == before
    display.channels["u"]["label"] = "changed"
    assert sim.display.channels["u"]["label"] == "U"


@pytest.mark.parametrize("sim,ch", [(battery_ecm, "i"), (oscillator, "force"), (thermal_rc, "power")])
def test_builtin_input_functions(sim, ch):
    p = Project("p", sim)
    initial = {k: p.initial_value(k) for k in sim.params}
    result = sim(initial, next(iter(sim.experiments)), count=False)
    assert set(result) == {"t", *sim.outputs}
    assert set(result.u) == {ch}
    assert len(result.u[ch]) == len(result["t"])


def test_http_upload_and_idempotence():
    with FakeAutophys() as fake:
        store = HttpStore(fake.url, fake.issue_key())
        project = Project("toy", toy(declaration()))
        workbook = RemoteClient(store).project(project)
        pid = workbook.project_id
        body = project.simulator.display.canonical(project)
        assert list(fake.displays[pid].values()) == [body]
        store.register_display(pid, project)
        assert len(fake.displays[pid]) == 1
        assert len(store.config_versions(pid)) == 1
        assert fake.projects[pid]["display"] == json.loads(body)
        req = next(r for r in fake.requests if r[1].endswith("/display"))
        assert req[2]["Content-Type"] == "application/json"
        project.simulator.display.settings["rate"] = {"label": "Sample rate", "unit": "Hz", "role": "sampling"}
        store.register_display(pid, project)
        assert len(fake.displays[pid]) == 2
        assert fake.projects[pid]["display"]["settings"]["rate"]["label"] == "Sample rate"
        store.put_display(pid, body)  # a previously stored digest is a no-op
        assert fake.projects[pid]["display"]["settings"]["rate"]["label"] == "Sample rate"


@pytest.mark.parametrize("status", [404, 405])
def test_http_old_daemon_is_an_upgrade_error(status):
    with FakeAutophys() as fake:
        fake.display_status = status
        store = HttpStore(fake.url, fake.issue_key())
        project = Project("toy", toy(declaration()))
        with pytest.raises(HttpError, match="too old for display manifests.*upgrade the autophys daemon") as caught:
            RemoteClient(store).project(project)
        assert caught.value.status == status and caught.value.error == "display_upload_failed"
        pid = store.ensure_project("toy")
        assert len(store.config_versions(pid)) == 1  # the config went up before the display
        with pytest.raises(HttpError, match="upgrade"):
            store.register_display(pid, project)  # every attempt errors, not only the first


def test_http_display_unknown_project_is_not_an_upgrade_error():
    with FakeAutophys() as fake:
        store = HttpStore(fake.url, fake.issue_key())
        with pytest.raises(HttpError) as caught:
            store.put_display("prj_missing", b'{"format":1}')
        assert caught.value.status == 404 and "upgrade" not in str(caught.value)


@pytest.mark.parametrize("body,message", [(b'{"format":2}', "expected format 1"),
                                          (canonical({"format": 1, "padding": "x" * (256 * 1024)}).encode(), "256 KiB")])
def test_http_rejections(body, message):
    with FakeAutophys() as fake:
        store = HttpStore(fake.url, fake.issue_key())
        pid = store.ensure_project("p")
        with pytest.raises(StoreError, match=message) as caught:
            store.put_display(pid, body)
        assert "untrusted" not in str(caught.value)
        fake.display_status = 422
        with pytest.raises(StoreError) as caught:
            store.put_display(pid, b'{"format":1}')
        assert "untrusted server text" not in str(caught.value)


@pytest.mark.parametrize("kind", ["memory", "jsonl", "workbook"])
def test_local_stores_noop(tmp_path, kind):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "log"),
             "workbook": lambda: WorkbookStore(tmp_path / "p.autophys")}[kind]()
    try:
        project = Project("toy", toy(declaration()))
        pid = store.ensure_project("toy")
        project.simulator.budget = CallBudget(0)
        def forbidden(*a, **kw):
            raise AssertionError("local registration must not generate previews")
        project.simulator.fn = forbidden
        store.register_display(pid, project)
        store.put_display(pid, b'{"format":1}')
        assert store.config_versions(pid) == []
    finally:
        if hasattr(store, "close"):
            store.close()
