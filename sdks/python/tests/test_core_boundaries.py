"""Paired round-1 acceptance: outcomes/effects at public SDK boundaries."""
import io
import json
import copy
import urllib.error

import numpy as np
import pytest

import autophys as ap
from autophys.agent import Investigation, ProposalRunner
from autophys.data import Observation, Dataset
from autophys.fit import fit
from autophys.http import HttpStore, HttpError, AuthError, Credentials, save_credentials, load_credentials
from autophys.project import Project, NoiseConfig
from autophys.store import StoreError, MemoryStore
from autophys.synthetic import thermal_case
from fake_server import FakeAutophys


def inputs():
    view, _ = thermal_case(0)
    p = Project("core", view.simulator, noise=NoiseConfig(bias="off"), initial={"C": 500., "R": 2.})
    return p, view.dataset


@pytest.mark.parametrize("sigma", [float("inf"), -float("inf"), float("nan"), 0., -1.])
def test_sigma_rejected_at_construction_and_mutated_use_before_effects(sigma):
    p, ds = inputs()
    with pytest.raises(ValueError, match="T.*finite|finite.*T"):
        NoiseConfig(sigma={"T": sigma})
    obs = copy.deepcopy(ds.split("train")[0])
    obs.sigma["T"] = sigma
    with pytest.raises(ValueError, match="T.*finite|finite.*T"):
        Observation.from_dict(obs.__dict__)
    calls = p.simulator.calls
    with pytest.raises(ValueError, match="T.*finite|finite.*T"):
        fit(p.simulator, [obs], initial=p.initial, n_starts=0)
    store = MemoryStore()
    # A valid dataset mutated after construction must fail before creating records.
    ds.split("train")[0].sigma["T"] = sigma
    with pytest.raises(ValueError):
        Investigation(p, ds, ProposalRunner(), store=store)
    assert store.investigations() == []
    assert p.simulator.calls == calls


@pytest.mark.parametrize("initial", [{"C":500.}, {"C":500.,"R":2.,"extra":1.}, {"C":-1.,"R":2.}, {"C":float("nan"),"R":2.}, {"C":500.,"R":float("inf")}])
def test_invalid_initial_before_simulation(initial):
    p, ds = inputs()
    calls = p.simulator.calls
    with pytest.raises(ValueError, match="missing|unknown|outside"):
        fit(p.simulator, ds.split("train"), initial=initial, n_starts=0)
    assert p.simulator.calls == calls


def test_no_starts_and_no_finite_training_data():
    p, ds = inputs()
    obs = copy.deepcopy(ds.split("train")[0])
    calls = p.simulator.calls
    with pytest.raises(ValueError, match="start"):
        fit(p.simulator, [obs], n_starts=0)
    for y in obs.y.values(): y[:] = np.nan
    with pytest.raises(ValueError, match="finite"):
        fit(p.simulator, [obs], initial=p.initial, n_starts=0)
    with pytest.raises(ValueError, match="finite"):
        Investigation(p, Dataset([obs]), ProposalRunner())
    assert p.simulator.calls == calls
    valid = fit(p.simulator, ds.split("train"), initial=p.initial, n_starts=0)
    assert valid.n > 0 and np.isfinite(valid.loss)


@pytest.mark.parametrize("kind", ["absent", "empty", "missing", "partial", "normal"])
def test_validation_requires_usable_evidence(kind):
    p, ds = inputs()
    train = ds.split("train")
    val = copy.deepcopy(ds.split("validation")[0])
    if kind == "empty":
        val.t = val.t[:0]; val.y = {k:v[:0] for k,v in val.y.items()}
    if kind == "missing":
        for v in val.y.values(): v[:] = np.nan
    if kind == "partial":
        for v in val.y.values(): v[::2] = np.nan
    inv = Investigation(p, Dataset(train + ([] if kind == "absent" else [val])), ProposalRunner())
    inv.tool_optimize_parameters()
    result = inv.tool_validate_predictions()
    if kind in ("absent", "empty", "missing"):
        assert result == {"available": False, "passed": False}
    else:
        assert result["available"] and result["passed"]
        assert result["n"] == val.n_samples > 0
        assert result["chi2_per_n"] < 2.


@pytest.mark.parametrize("field", ["initial", "catalog", "noise", "investigation"])
def test_configuration_alias_drift_rejected_before_run_approve_attach_resume(field):
    from test_review_regressions import pending
    inv, view, _ = pending()
    p = inv.project
    pid = inv.pending
    obs = view.runner.run(inv.pending_experiment)
    before = len(inv.records()), inv.call_budget.used
    if field == "initial": p.initial[next(iter(p.simulator.params))] = 1.23
    elif field == "catalog": p.catalog[inv.pending_experiment]["cost_hours"] = 123.
    elif field == "noise":
        p.noise = NoiseConfig(sigma={"T":0.1}, bias="off")
    else: inv.project.n_starts += 1
    for fn in [inv.run, lambda: inv.approve(pid), lambda: inv.attach_data(pid, obs),
               lambda: Investigation.resume(p, inv.store, inv.id)]:
        with pytest.raises(StoreError, match="pinned"):
            fn()
    assert (len(inv.records()), inv.call_budget.used) == before
    assert p.simulator({"C":500.,"R":2.}, next(iter(p.simulator.experiments)), count=False) is not None


def test_saved_keys_bound_to_server_with_explicit_key_override(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("AUTOPHYS_API_KEY", raising=False)
    monkeypatch.delenv("AUTOPHYS_SERVER", raising=False)
    with FakeAutophys() as a, FakeAutophys() as b:
        key = a.issue_key()
        save_credentials(Credentials(a.url, key))
        with pytest.raises(StoreError, match="different server") as exc:
            ap.connect(b.url)
        assert not b.requests and key not in repr(exc.value)
        monkeypatch.setenv("AUTOPHYS_SERVER", b.url)
        with pytest.raises(StoreError, match="different server"):
            load_credentials()
        monkeypatch.delenv("AUTOPHYS_SERVER")
        assert ap.connect(a.url.replace("http:", "HTTP:") + "/").projects() == []
        import os, subprocess
        peer = os.environ.get("AUTOPHYS_CORE_PEER")
        if peer:
            def discover(target):
                run = subprocess.run([peer],input=json.dumps({"target":target,"action":"discover"}),text=True,capture_output=True,timeout=10)
                assert run.returncode == 0 and key not in run.stdout + run.stderr
                return json.loads(run.stdout)
            previous = len(b.requests)
            assert not discover(b.url)["ok"] and len(b.requests) == previous
            assert discover(a.url.replace("http:","HTTP:") + "/")["ok"]
        explicit = b.issue_key()
        assert ap.connect(b.url, api_key=explicit).projects() == []
        monkeypatch.setenv("AUTOPHYS_API_KEY", explicit)
        assert ap.connect(b.url).projects() == []
        assert key not in repr(ap.connect(a.url, api_key=key))


@pytest.mark.parametrize("body,status,auth", [({"error":"invalid_payload","message":"bad","path":"payload.x"},422,False), ({"error":"unauthorized","message":"bad"},401,True), ({"error":"access_denied"},403,False), ([],422,False), (b"malformed",500,False)])
def test_structured_errors_through_public_store(monkeypatch, body, status, auth):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    def fail(req, **kw):
        raise urllib.error.HTTPError(req.full_url,status,"failure",{"Retry-After":"3"},io.BytesIO(data))
    monkeypatch.setattr("urllib.request.urlopen", fail)
    with pytest.raises(HttpError) as caught:
        HttpStore("http://127.0.0.1:9", "synthetic-private-key").projects()
    e = caught.value
    assert e.status == status and e.retry_after == "3" and isinstance(e, AuthError) == auth
    assert e.path == (body.get("path") if isinstance(body,dict) else None)
    assert e.error == (body.get("error") if isinstance(body,dict) else "http_error")
    assert e.message == (body.get("message", "") if isinstance(body,dict) else "")
    assert "synthetic-private-key" not in repr(e)


def test_target_policy_and_explicit_open_create(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_HOME", str(tmp_path / "default"))
    assert ap.connect().root == ap.connect("").root == tmp_path / "default"
    assert str(ap.connect(".").root) == "."
    assert ap.connect(str(tmp_path / "one.ap-workbook")).only == tmp_path / "one.ap-workbook"
    for target, expected in [
        ("HTTP://LOCALHOST:80/", "http://localhost/api/v1"),
        ("http://localhost", "http://localhost/api/v1"),
        ("HTTPS://LOCALHOST:443/", "https://localhost/api/v1"),
        ("http://localhost:", "http://localhost/api/v1"),
        ("http://localhost:00080/", "http://localhost/api/v1"),
        ("https://localhost:0", "https://localhost:0/api/v1"),
        ("https://localhost:65535", "https://localhost:65535/api/v1"),
        ("HTTP://[::1]:80/", "http://[::1]/api/v1"),
        ("https://[::1]:443/prefix/", "https://[::1]/prefix/api/v1"),
        ("https://[::1]:8443", "https://[::1]:8443/api/v1"),
    ]:
        assert ap.connect(target, api_key="key").store.base == expected
    for target in ["http://u:private@localhost", "http://localhost?x", "http://localhost#x", "http:/broken", "ftp://localhost", "https://localhost:99999", "http://localhost:65536", "http://localhost:abc", "http://localhost:-1", "http://localhost:+80", "http://[::1]:99999", "http://[::1]:abc", "http://[::1"]:
        with pytest.raises(StoreError, match="invalid daemon URL"):
            ap.connect(target, api_key="key")
    assert not list(tmp_path.iterdir())
    with ap.connect(tmp_path / "books") as c:
        with pytest.raises(StoreError): c.open_project("missing")
        assert not (tmp_path / "books").exists()
        a = c.ensure_project("created"); b = c.open_project("created")
        assert a.project_id == b.project_id and len(c.projects()) == 1


def test_retained_workbook_blob_ownership_and_reopen():
    with FakeAutophys() as s:
        c = ap.connect(s.url, api_key=s.issue_key())
        p, _ = inputs(); p.name = "A"
        a = c.project(p)
        q, _ = inputs(); q.name = "B"
        b = c.project(q)
        ka = a.store.put_blob(b"A image", "image/png")
        kb = b.store.put_blob(b"B playbook", "text/markdown")
        assert a.store.get_blob(ka) == (b"A image", "image/png")
        assert b.store.get_blob(kb) == (b"B playbook", "text/markdown")
        for w,k in [(c.project("A"),ka),(c.project("B"),kb)]: assert w.store.get_blob(k)[0]
        with pytest.raises(HttpError): a.store.get_blob(kb)
        with pytest.raises(StoreError): c.open_project("missing")
        assert len(c.projects()) == 2


def test_old_daemon_atomic_attachment_fails_without_record_fallback(monkeypatch):
    from test_review_regressions import pending
    with FakeAutophys() as server:
        store=HttpStore(server.url,server.issue_key())
        inv,view,_=pending(store);pid=inv.pending;inv.approve(pid)
        before=len(inv.records())
        obs=view.runner.run(inv.pending_experiment)
        request=inv.store._req; attempted=[]
        def old_server(method,path,body=None,**kw):
            if path.endswith("/attachment"):
                attempted.append(path);raise HttpError(404,"not_found")
            return request(method,path,body,**kw)
        monkeypatch.setattr(inv.store,"_req",old_server)
        with pytest.raises(HttpError): inv.attach_data(pid,obs)
        assert len(attempted)==1 and len(inv.records())==before and inv.experiments_used==0


def test_nested_noise_alias_and_mutated_project_before_persistence(tmp_path):
    sigma={"T":0.05}
    p,ds=inputs();p.noise=NoiseConfig(sigma=sigma,bias="off")
    inv=Investigation(p,ds,ProposalRunner())
    before=len(inv.records())
    sigma["T"]=float("inf")
    with pytest.raises(StoreError,match="pinned"):inv.run()
    assert len(inv.records())==before
    with ap.connect(tmp_path/"books") as client:
        with pytest.raises(ValueError,match="finite"):client.project(p)
        assert not (tmp_path/"books").exists()
