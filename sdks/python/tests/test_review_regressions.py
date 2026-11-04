"""Verified SDK review regressions; all provider work is fake or replayed."""
import hashlib
import io
import json
import multiprocessing
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from autophys.agent import Decision, Investigation, ProposalRunner, ReasonLanePolicy, ScriptedPolicy
from autophys.bench import case_project
from autophys.data import Dataset
from autophys.http import HttpError, HttpStore
from autophys.playbook import load_playbook
from autophys.reasoner import BudgetError, FakeReasoner, HttpReasoner, ModelSpec, ReasonerError, ReasonReply
from autophys.research import MuseCLIResearcher, evaluate, proposal_prompt, research
from autophys.store import JsonlStore, MemoryStore, StoreError, canonical, config_hash
from autophys.synthetic import CASES
from autophys.trajectories import trajectories
from autophys.usage import normalize_usage
from autophys.workbook import WorkbookError, WorkbookStore
from fake_server import FakeAutophys


def pinned(store):
    pid = store.ensure_project("p")
    cfg = {"name": "p"}
    ver = store.put_config_version(pid, config_hash(cfg), cfg)
    return store.create_investigation({"project_id": pid, "config_version": ver})


def proposed(pid="p1"):
    return {"proposal_id": pid, "event": "proposed", "experiment": "e", "settings": {}}


def pending(store=None, policy=None):
    view, _ = CASES["thermal"](0)
    project = case_project(view)
    inv = Investigation(project, view.dataset, ProposalRunner(), store=store,
                        policy=policy or ScriptedPolicy())
    out = inv.run()
    assert out.status == "awaiting_data"
    return inv, view, project


def test_A1_evaluate_prompt_identity(tmp_path, monkeypatch):
    import autophys.bench as bench
    # Failing transcripts carry investigation metadata, including reasoner repr.
    monkeypatch.setattr(bench, "heuristic_responder", lambda messages: "invalid")
    reports = [evaluate(load_playbook().path, ["thermal"], [0], "fake-reasoner", tmp_path / str(i))
               for i in range(2)]
    hashes = [hashlib.sha256(proposal_prompt("skill", r).encode()).hexdigest() for r in reports]
    assert hashes[0] == hashes[1]
    assert proposal_prompt("skill", {"reasoner": "volatile"}) == proposal_prompt("skill", {})


def test_A1_wrapper_reprs(tmp_path):
    from autophys.reasoner import RecordingReasoner, ReplayReasoner, _ConfiguredReasoner
    path = tmp_path / "cassette"
    path.write_text("")
    def wrappers():
        fake = FakeReasoner(lambda m: "ok")
        return [fake, RecordingReasoner(fake, path), ReplayReasoner(path),
                _ConfiguredReasoner(fake, ModelSpec("policy", "meta", "m")),
                HttpReasoner("http://secret:credential@127.0.0.1")]
    assert list(map(repr, wrappers())) == list(map(repr, wrappers()))
    assert all("0x" not in repr(r) and "credential" not in repr(r) for r in wrappers())


@pytest.mark.parametrize("immediate", [False, True])
def test_A2_first_402_stops_scheduling(monkeypatch, immediate):
    import autophys.bench as bench
    started, failed_at = [], []
    release = threading.Event()
    def run(unit):
        index = unit[2]
        started.append((index, time.monotonic()))
        if index == 0:
            if not immediate:
                release.wait(2)
            failed_at.append(time.monotonic())
            raise BudgetError("402")
        release.set()
        time.sleep(.1)
        return index
    monkeypatch.setattr(bench, "_run_unit", run)
    with pytest.raises(BudgetError):
        bench.run_units([("thermal", "reason", i, {}) for i in range(20)], jobs=2)
    assert len(started) <= 2
    assert all(start <= failed_at[0] for _, start in started)


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504, "connection"])
def test_A3_lane_retry_and_sanitization(monkeypatch, status):
    import autophys.reasoner as module
    calls, delays = [], []
    def request(*a, **kw):
        calls.append(1)
        if len(calls) == 1:
            if status == "connection":
                raise OSError("SECRET")
            raise HttpError(status, "SECRET", retry_after="2")
        return 200, {"content": "ok"}
    monkeypatch.setattr(module, "request_json", request)
    assert HttpReasoner("http://127.0.0.1", sleep=delays.append, jitter=lambda: 0).complete([]).content == "ok"
    assert len(calls) == 2 and delays == ([.5] if status == "connection" else [2])
    def refuse(*a, **kw):
        raise HttpError(402, "SECRET", "SECRET")
    monkeypatch.setattr(module, "request_json", refuse)
    with pytest.raises(BudgetError, match="402") as error:
        HttpReasoner("http://127.0.0.1").complete([])
    assert "SECRET" not in str(error.value)


@pytest.mark.parametrize("counts", [{}, {"prompt_tokens": None, "completion_tokens": -1},
                                   {"prompt_tokens": True, "completion_tokens": 2.0}])
def test_A4_unknown_counts_have_unknown_cost(counts):
    usage = normalize_usage(ReasonReply("x", "muse-spark-1.3", counts))
    assert usage["input_tokens"] == usage["output_tokens"] == 0
    assert usage["cost_usd"] is None


def test_A4_optional_counts_and_openai_aliases():
    usage = normalize_usage(ReasonReply("x", "muse-spark-1.3", {
        "input_tokens": 800, "output_tokens": 320, "total_tokens": None,
        "completion_tokens_details": {"reasoning_tokens": None},
        "prompt_tokens_details": {"cached_tokens": -1}}))
    assert usage["input_tokens"] == 800 and usage["output_tokens"] == 320
    assert usage["total_tokens"] == 1120 and usage["cost_usd"] is not None
    assert "reasoning_tokens" not in usage and "cached_input_tokens" not in usage
    policy = ReasonLanePolicy(FakeReasoner(lambda m: {"hypothesis": "done", "evidence": [], "action": "stop",
                                                   "arguments": {"status": "inconclusive"}, "expected_information": "none"}))
    original = policy.reasoner.complete
    def complete(*a, **kw):
        reply = original(*a, **kw)
        reply.usage = {"completion_tokens_details": {"reasoning_tokens": None}}
        return reply
    policy.reasoner.complete = complete
    view, _ = CASES["thermal"](0)
    assert Investigation(case_project(view), view.dataset, view.runner, policy=policy).run().status == "inconclusive"


@pytest.mark.parametrize("backend", ["memory", "jsonl", "workbook"])
def test_A5_local_playbook_blob(tmp_path, backend):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "logs"),
             "workbook": lambda: WorkbookStore(tmp_path / "p.ap-workbook")}[backend]()
    try:
        policy = ReasonLanePolicy(FakeReasoner(lambda m: "unused"))
        view, _ = CASES["thermal"](0)
        Investigation(case_project(view), view.dataset, view.runner, policy=policy, store=store)
        assert store.get_blob("sha256:" + policy.playbook.sha256) == (policy.playbook.data, "text/markdown")
        assert store.put_blob(policy.playbook.data, "text/plain") == "sha256:" + policy.playbook.sha256
        assert store.get_blob("sha256:" + policy.playbook.sha256)[1] == "text/markdown"
    finally:
        if hasattr(store, "close"):
            store.close()


def test_A5_http_blobs_and_reference_order():
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        policy = ReasonLanePolicy(FakeReasoner(lambda m: "unused"))
        view, _ = CASES["thermal"](0)
        inv = Investigation(case_project(view), view.dataset, view.runner, policy=policy, store=store)
        key = "sha256:" + policy.playbook.sha256
        assert store.get_blob(key) == (policy.playbook.data, "text/markdown")
        paths = [(m, p) for m, p, _ in server.requests]
        blob_path = f"/projects/{inv.project_id}/blobs/{policy.playbook.sha256}"
        assert paths.index(("PUT", blob_path)) < paths.index(("POST", "/investigations"))
        assert store.put_blob(policy.playbook.data, "text/markdown") == key
        before = len(server.requests)
        with pytest.raises(StoreError, match="16 MiB"):
            store.put_blob(b"x" * (16 * 1024 * 1024 + 1))
        assert len(server.requests) == before
        with pytest.raises(HttpError) as error:
            store.get_blob("0" * 64)
        assert error.value.status == 404
        def raw_put(data, digest, media_type="text/plain"):
            req = urllib.request.Request(server.url + "/api/v1" + blob_path.rsplit("/", 1)[0] + "/" + digest,
                                         data=data, method="PUT", headers={"Authorization": f"Bearer {store._key}",
                                                                           "Content-Type": media_type})
            return urllib.request.urlopen(req)
        digest = hashlib.sha256(b"hello").hexdigest()
        for status in (201, 200):
            with raw_put(b"hello", digest) as response:
                assert response.status == status
        for data, digest, status, code in [(b"bad", "0" * 64, 422, "hash_mismatch"),
                                           (b"x" * (16 * 1024 * 1024 + 1), "0" * 64, 413, "too_large")]:
            with pytest.raises(urllib.error.HTTPError) as error:
                raw_put(data, digest)
            assert error.value.code == status
            assert json.load(error.value)["error"] == code


@pytest.mark.parametrize("status", [422, 413])
def test_A5_http_blob_errors_are_sanitized(monkeypatch, status):
    store = HttpStore("http://127.0.0.1", "synthetic")
    store._project_id = "p"
    def fail(*a, **kw):
        raise urllib.error.HTTPError("unused", status, "SECRET", {}, io.BytesIO(b'SECRET'))
    monkeypatch.setattr(urllib.request, "urlopen", fail)
    with pytest.raises(StoreError) as error:
        store.put_blob(b"x")
    assert "SECRET" not in str(error.value)


def test_A6_resume_checks_playbook(tmp_path):
    view, _ = CASES["thermal"](0)
    project = case_project(view)
    store = MemoryStore()
    inv = Investigation(project, view.dataset, view.runner, store=store,
                        policy=ReasonLanePolicy(FakeReasoner(lambda m: "unused")))
    path = tmp_path / "SKILL.md"
    path.write_bytes(load_playbook().data + b"\nChanged strategy.\n")
    with pytest.raises(StoreError, match="playbook sha256"):
        Investigation.resume(project, store, inv.id,
                             policy=ReasonLanePolicy(FakeReasoner(lambda m: "unused"), playbook=path))
    Investigation.resume(project, store, inv.id, policy=ReasonLanePolicy(FakeReasoner(lambda m: "unused")))
    Investigation.resume(project, store, inv.id, policy=ScriptedPolicy())


def test_A7_cli_replay_configuration_identity(tmp_path):
    text = load_playbook().data.decode()
    spec = ModelSpec("researcher", "meta", "muse-wonder-1.0", "high")
    body = {"model": spec.model, "effort": spec.effort, "max_model_steps": 3, "prompt": proposal_prompt(text, {})}
    path = tmp_path / "cassette"
    path.write_text(json.dumps({"key": hashlib.sha256(canonical(body).encode()).hexdigest(), "playbook": text + "\nBetter.\n"}) + "\n")
    assert "Better." in MuseCLIResearcher(replay=path, spec=spec, max_model_steps=3).propose(text, {})
    for options in ({"spec": spec}, {"max_model_steps": 3},
                    {"spec": ModelSpec("researcher", "meta", "other", "high"), "max_model_steps": 3}):
        with pytest.raises(ReasonerError, match="replay miss"):
            MuseCLIResearcher(replay=path, **options).propose(text, {})


@pytest.mark.parametrize("error", [ReasonerError("cannot start"), ReasonerError("timeout"),
                                  ReasonerError("nonzero exit"), ReasonerError("terminal failed")])
def test_A8_researcher_operational_failure_aborts(tmp_path, error):
    calls = []
    class Researcher:
        def propose(self, *args):
            calls.append(1)
            raise error
    with pytest.raises(ReasonerError):
        research(researcher=Researcher(), output_dir=tmp_path / "out", policy="scripted", iterations=3,
                 evaluate_fn=lambda *a, **kw: {"score": {"correct": 0}})
    assert len(calls) == 1


def test_A9_bare_name_always_bundled(tmp_path, monkeypatch):
    expected = load_playbook().sha256
    (tmp_path / "default").mkdir()
    (tmp_path / "default/SKILL.md").write_bytes(load_playbook().data + b"\nWrong.\n")
    monkeypatch.chdir(tmp_path)
    assert load_playbook("default").sha256 == expected
    assert load_playbook("./default").sha256 != expected


def test_A10_export_evidence_prompt(tmp_path):
    path = tmp_path / "p.ap-workbook"
    with WorkbookStore(path) as store:
        inv = pinned(store)
        store.append(inv, "step", {"index": 1, "evidence_text": "user evidence", "raw_output": "reply"})
    [step] = trajectories(path)
    assert step["prompt"] == "user evidence" and step["messages"] is None


def test_B1_keepalives_do_not_extend_deadline():
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key(), stream_idle=2)
        inv = pinned(store)
        store.append(inv, "proposal", proposed())
        start = time.monotonic()
        with pytest.raises(TimeoutError):
            store.wait_for_approval(inv, "p1", timeout=1.2)
        assert 1.1 <= time.monotonic() - start < 2


@pytest.mark.parametrize("backend", ["memory", "jsonl", "workbook"])
def test_B2_batch_proposal_transitions(tmp_path, backend):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "logs"),
             "workbook": lambda: WorkbookStore(tmp_path / "p.ap-workbook")}[backend]()
    try:
        inv = pinned(store)
        store.append_batch(inv, [("proposal", proposed()),
                                 ("proposal", {"proposal_id": "p1", "event": "approved", "by": "test"})])
        attached = {"proposal_id": "p1", "event": "data_attached", "measurement_version": 1}
        before = len(store.records(inv))
        with pytest.raises(WorkbookError):
            store.append_batch(inv, [("proposal", attached), ("proposal", attached)])
        assert len(store.records(inv)) == before
        assert store.proposal_status(inv, "p1")["status"] == "approved"
    finally:
        if hasattr(store, "close"):
            store.close()


def test_B3_attach_failure_preserves_dataset(monkeypatch):
    inv, view, _ = pending()
    pid = inv.pending
    inv.approve(pid)
    obs = view.runner.run(inv.pending_experiment)
    before = inv.dataset.digest(), inv.dataset.version
    def fail(*args):
        raise StoreError("injected")
    monkeypatch.setattr(inv.store, "append_batch", fail)
    with pytest.raises(StoreError, match="injected"):
        inv.attach_data(pid, obs)
    assert (inv.dataset.digest(), inv.dataset.version) == before
    assert inv.pending == pid and inv.proposal(pid)["status"] == "approved"


@pytest.mark.parametrize("response_lost", [False, True])
def test_B3_http_partial_attach_retry(monkeypatch, response_lost):
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        inv, view, _ = pending(store)
        pid = inv.pending
        inv.approve(pid)
        obs = view.runner.run(inv.pending_experiment)
        before = len(store.records(inv.id, "measurement"))
        append = store.append
        fail = [True]
        def append_once(investigation, kind, payload, **kw):
            if kind == "proposal" and payload["event"] == "data_attached" and fail[0]:
                fail[0] = False
                if response_lost:
                    append(investigation, kind, payload, **kw)
                raise OSError("second POST failed")
            return append(investigation, kind, payload, **kw)
        monkeypatch.setattr(store, "append", append_once)
        with pytest.raises(OSError):
            inv.attach_data(pid, obs)
        inv.attach_data(pid, obs)
        assert len(store.records(inv.id, "measurement")) == before + 1
        assert inv.dataset.version == before + 1 and inv.pending is None


class OptimizeRequestStop:
    name = "review-stop"
    def decide(self, facts):
        if facts["fit"] is None:
            action, args = "optimize_parameters", {}
        elif facts["budget"]["experiments_requested"] == 0:
            action, args = "request_experiment", {"experiment": facts["catalog"][0]}
        else:
            action, args = "stop", {"status": "inconclusive"}
        return Decision("test", [], action, args, "test"), {}


def test_B4_resume_outcome_simulation_budget():
    values = []
    for resume in (False, True):
        inv, view, project = pending(policy=OptimizeRequestStop())
        paid = inv.simulations
        if resume:
            inv = Investigation.resume(project, inv.store, inv.id, policy=OptimizeRequestStop())
            assert inv.simulations == paid
        pid = inv.pending
        inv.approve(pid)
        inv.attach_data(pid, view.runner.run(inv.pending_experiment))
        outcome = inv.run()
        values.append((outcome.simulations, inv.facts()["budget"]["simulations_left"]))
    assert values[0] == values[1]


def test_B5_env_key_actor_has_no_placeholder(monkeypatch, tmp_path):
    from autophys.client import connect
    with FakeAutophys() as server:
        monkeypatch.setenv("AUTOPHYS_API_KEY", server.issue_key())
        monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path))
        inv, _, _ = pending(connect(server.url).store)
        inv.approve(inv.pending)
        actor = inv.records("proposal")[-1].payload
        assert "key_id" not in actor


@pytest.mark.parametrize("stream", [False, True])
def test_B6_wait_survives_server_restart(stream):
    server = FakeAutophys()
    server.__enter__()
    errors, result = [], []
    store = HttpStore(server.url, server.issue_key(), stream_idle=.3, timeout=.3)
    inv = pinned(store)
    store.append(inv, "proposal", proposed())
    port = server.httpd.server_address[1]
    def wait():
        try:
            result.append(store.wait_for_approval(inv, "p1", timeout=5, interval=.05, stream=stream))
        except BaseException as error:
            errors.append(error)
    thread = threading.Thread(target=wait)
    try:
        thread.start()
        time.sleep(.1)
        server.__exit__()
        time.sleep(.25)
        server.closing = False
        server.httpd = ThreadingHTTPServer(("127.0.0.1", port), server._handler())
        server.thread = threading.Thread(target=server.httpd.serve_forever, daemon=True)
        server.__enter__()
        server.approve_record(inv, "p1")
        thread.join(6)
        assert not thread.is_alive() and not errors
        assert result[0]["status"] == "approved"
    finally:
        server.__exit__()
        thread.join(6)


def test_B7_other_writer_attachment_clears_pending(tmp_path):
    path = tmp_path / "p.ap-workbook"
    with WorkbookStore(path) as first, WorkbookStore(path) as second:
        inv, view, project = pending(first)
        writer = Investigation.resume(project, second, inv.id, policy=ScriptedPolicy())
        pid = writer.pending
        writer.approve(pid)
        writer.attach_data(pid, view.runner.run(writer.pending_experiment))
        assert inv.wait_for_approval(timeout=1)["status"] == "data_attached"
        assert inv.pending is None and inv.dataset.digest() == writer.dataset.digest()
        assert inv.run().status == "validated"


def test_B8_commit_failure_rolls_back(tmp_path):
    with WorkbookStore(tmp_path / "p.ap-workbook") as store:
        connection = store._conn
        class FailingCommit:
            def execute(self, sql, *args):
                if sql == "COMMIT":
                    raise OSError("injected COMMIT failure")
                return connection.execute(sql, *args)
        store._conn = FailingCommit()
        try:
            with pytest.raises(OSError, match="COMMIT"):
                store.ensure_project("p")
        finally:
            store._conn = connection
        assert not connection.in_transaction
        assert store.projects() == []
        store.ensure_project("p")


@pytest.mark.parametrize("tail", [b'{"partial":', b'{"complete":true}', b'not-json\n'])
def test_B9_torn_final_line_recovered(tmp_path, tail):
    store = JsonlStore(tmp_path)
    inv = pinned(store)
    path = tmp_path / f"{inv}.jsonl"
    original = path.read_bytes()
    with path.open("ab") as stream:
        stream.write(tail)
    assert len(store.records(inv)) == 1
    store.append(inv, "proposal", proposed())
    assert path.read_bytes().startswith(original)
    assert len(store.records(inv)) == 2 and store.verify(inv)


def jsonl_writer(root, inv, prefix):
    store = JsonlStore(root)
    for i in range(20):
        store.append(inv, "proposal", proposed(prefix + str(i)))


def test_B9_multiprocess_append_lock(tmp_path):
    store = JsonlStore(tmp_path)
    inv = pinned(store)
    processes = [multiprocessing.get_context("fork").Process(target=jsonl_writer, args=(tmp_path, inv, str(i)))
                 for i in range(4)]
    for process in processes:
        process.start()
    for process in processes:
        process.join(10)
        assert process.exitcode == 0
    assert len(store.records(inv)) == 81 and store.verify(inv)


def test_B10_generator_detects_changed_inputs(monkeypatch):
    import copy
    import test_numerics_conformance as checks
    generated = list(checks.all_cases())
    name, case = generated[0]
    case = copy.deepcopy(case)
    case["inputs"]["review_unexpected_input"] = True
    generated[0] = name, case
    monkeypatch.setattr(checks, "all_cases", lambda: iter(generated))
    with pytest.raises((AssertionError, KeyError)):
        checks.test_numerics_generator_is_current()


def test_A5_missing_content_type_is_422():
    import http.client
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        pid = store.ensure_project("p")
        data = b"blob"
        digest = hashlib.sha256(data).hexdigest()
        connection = http.client.HTTPConnection(*server.httpd.server_address)
        try:
            connection.request("PUT", f"/api/v1/projects/{pid}/blobs/{digest}", body=data,
                               headers={"Authorization": "Bearer " + store._key})
            response = connection.getresponse()
            assert response.status == 422
            assert json.loads(response.read())["path"] == "Content-Type"
        finally:
            connection.close()


@pytest.mark.parametrize("route", ["lane", "meta"])
@pytest.mark.parametrize("status", [501, 505, 599])
def test_R1_other_5xx_are_not_retried(monkeypatch, route, status):
    import autophys.reasoner as module
    calls, delays = [], []
    def request(*args, **kwargs):
        calls.append(1)
        raise HttpError(status, "SECRET")
    monkeypatch.setattr(module, "request_json", request)
    reasoner = (HttpReasoner("http://127.0.0.1", sleep=delays.append) if route == "lane" else
                module.ChatReasoner("meta", api_key="synthetic", sleep=delays.append))
    with pytest.raises(ReasonerError) as error:
        reasoner.complete([])
    assert "SECRET" not in str(error.value) and len(calls) == 1 and delays == []


@pytest.mark.parametrize("backend", ["memory", "jsonl", "workbook"])
@pytest.mark.parametrize("value,valid", [(2**64, False), (-(2**63)-1, False),
                                        (2**64-1, True), (-(2**63), True)])
def test_R2_integer_range_at_depth(tmp_path, backend, value, valid):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "logs"),
             "workbook": lambda: WorkbookStore(tmp_path / "p.ap-workbook")}[backend]()
    try:
        inv = pinned(store)
        payload = {"nested": [{"value": value}], "boolean": True}
        if valid:
            assert store.append(inv, "run", payload).payload == payload
        else:
            with pytest.raises(WorkbookError) as error:
                store.append(inv, "run", payload)
            assert error.value.path == "payload.nested[0].value"
            assert "integer" in str(error.value)
            assert len(store.records(inv)) == 1
    finally:
        if hasattr(store, "close"):
            store.close()


def test_R3_playbook_line_endings_and_whitespace(tmp_path):
    path = tmp_path / "SKILL.md"
    text = "---\nname: test\ndescription: test\nversion: \x1c\n---\nStrategy.\n"
    path.write_bytes(text.encode())
    assert load_playbook(path).version == "\x1c"
    path.write_bytes(text.replace("\n", "\r\n").encode())
    crlf = load_playbook(path)
    assert crlf.version == "\x1c" and crlf.text == "Strategy.\n"
    path.write_bytes(text.replace("\n", "\r").encode())
    with pytest.raises(ValueError, match="frontmatter"):
        load_playbook(path)


def test_R3_project_name_uses_rust_whitespace(tmp_path):
    with WorkbookStore(tmp_path / "p.ap-workbook") as store:
        pid = store.ensure_project("\x1c")
        assert store.projects()[0]["name"] == "\x1c"
        assert store.ensure_project("\x1c") == pid
    with WorkbookStore(tmp_path / "q.ap-workbook") as store:
        with pytest.raises(WorkbookError):
            store.ensure_project("\u0085\u200a\u3000")


@pytest.mark.parametrize("mutation", ["payload", "records", "kinds"])
def test_R4_rust_golden_reader_checks_contract(tmp_path, mutation):
    import shutil
    import sqlite3
    import test_conformance as checks
    from autophys.store import GENESIS, chain_hash
    source = checks._goldens("rust")[0]
    path = tmp_path / "source.ap-workbook"
    shutil.copy(source, path)
    expected = json.loads(source.with_suffix(".json").read_text())
    if mutation == "payload":
        # Construct an intact chain containing an invalid trace field. Only
        # payload validation can reject it; hashes/projections still agree.
        connection = sqlite3.connect(path)
        try:
            connection.execute("DROP TRIGGER records_no_update")
            records = connection.execute("SELECT id, investigation, kind, payload FROM records ORDER BY gseq").fetchall()
            heads = {}
            for rid, inv, kind, raw in records:
                payload = json.loads(raw)
                if kind == "investigation":
                    payload["playbook"] = {"name": "test", "version": "1", "sha256": "invalid"}
                prev = heads.get(inv, GENESIS)
                digest = chain_hash(prev, rid, kind, payload)
                connection.execute("UPDATE records SET payload=?, prev_hash=?, hash=? WHERE id=?",
                                   (canonical(payload), prev, digest, rid))
                heads[inv] = digest
            connection.commit()
        finally:
            connection.close()
        with WorkbookStore(path, readonly=True) as store:
            assert store.check()["ok"]
            expected["heads"] = store.heads()
    elif mutation == "records":
        expected["records"] += 1
    else:
        expected["kinds"] = {"investigation": 999}
    path.with_suffix(".json").write_text(json.dumps(expected))
    reader = tmp_path / "reader"
    reader.mkdir()
    with pytest.raises(WorkbookError if mutation == "payload" else AssertionError):
        checks.test_rust_written_workbooks_verify(path, reader)


@pytest.mark.parametrize("value,valid", [(2**64, False), (-(2**63)-1, False),
                                        (2**64-1, True), (-(2**63), True)])
def test_R2_http_integer_range(tmp_path, value, valid):
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        inv = pinned(store)
        payload = {"nested": [{"value": value}], "boolean": True}
        if valid:
            assert store.append(inv, "run", payload).payload == payload
        else:
            requests = len(server.requests)
            with pytest.raises(WorkbookError) as error:
                store.append(inv, "run", payload)
            assert error.value.path == "payload.nested[0].value"
            assert len(server.requests) == requests


@pytest.mark.parametrize("route", ["lane", "meta"])
@pytest.mark.parametrize("failure", [503, "refused"])
def test_R1_shared_transient_retry(monkeypatch, route, failure):
    import socket
    import autophys.reasoner as module
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    calls, delays = [], []
    real_request = module.request_json
    def request(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            if failure == "refused":
                return real_request(*args, **kwargs)  # actual loopback connection refusal
            raise HttpError(503, "SECRET", retry_after="2")
        return 200, {"content": "ok", "choices": [{"message": {"content": "ok"}}]}
    monkeypatch.setattr(module, "request_json", request)
    options = {"sleep": delays.append, "jitter": lambda: 0, "timeout": .2}
    reasoner = (HttpReasoner(f"http://127.0.0.1:{port}", **options) if route == "lane" else
                module.ChatReasoner("meta", base_url=f"http://127.0.0.1:{port}", api_key="synthetic", **options))
    assert reasoner.complete([]).content == "ok"
    assert len(calls) == 2 and delays == ([2] if failure == 503 else [.5])


def test_R1_retry_after_http_date_and_cap(monkeypatch):
    from email.utils import formatdate
    import autophys.reasoner as module
    monkeypatch.setattr(module.time, "time", lambda: 1000000000)
    error = HttpError(503, "unavailable", retry_after=formatdate(1000000010, usegmt=True))
    assert module._retry_delay(error, jitter=lambda: 0) == 10
    assert module._retry_delay(HttpError(503, "unavailable", retry_after="invalid"), 10, lambda: 0) == 30


def test_bare_filename_playbook_still_loads_from_cwd(tmp_path, monkeypatch):
    from autophys.playbook import load_playbook
    source = load_playbook().data
    (tmp_path / "mine.md").write_bytes(source)
    monkeypatch.chdir(tmp_path)
    assert load_playbook("mine.md").sha256 == load_playbook().sha256
    with pytest.raises(ValueError):
        load_playbook("missing.md")


@pytest.mark.parametrize("use_stream", [True, False])
def test_wait_raises_a_permanent_http_error_at_once(monkeypatch, use_stream):
    """A 404 (mistyped or deleted proposal) is not transient: no waiting it out."""
    import contextlib, time as _time
    from autophys.http import HttpError, HttpStore, StreamUnavailable
    store = HttpStore("http://127.0.0.1:9", api_key="k")
    def missing(*args, **kwargs):
        raise HttpError(404, "not_found")
    monkeypatch.setattr(store, "proposal", missing)
    if use_stream:
        monkeypatch.setattr(store, "stream", lambda *a, **k: contextlib.nullcontext(object()))
    else:
        def no_stream(*a, **k):
            raise StreamUnavailable("none")
        monkeypatch.setattr(store, "stream", no_stream)
    started = _time.monotonic()
    with pytest.raises(HttpError) as info:
        store.wait_for_approval("inv", "prop_x", timeout=30, interval=0.01)
    assert info.value.status == 404 and _time.monotonic() - started < 2


def test_wait_retries_a_transient_http_error(monkeypatch):
    from autophys.http import HttpError, HttpStore, StreamUnavailable
    store = HttpStore("http://127.0.0.1:9", api_key="k")
    answers = [HttpError(503, "unavailable"), {"status": "approved"}]
    def proposal(*args, **kwargs):
        item = answers.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    monkeypatch.setattr(store, "proposal", proposal)
    def no_stream(*a, **k):
        raise StreamUnavailable("none")
    monkeypatch.setattr(store, "stream", no_stream)
    assert store.wait_for_approval("inv", "prop_x", timeout=10, interval=0.01, sleep=lambda s: None)["status"] == "approved"


def test_jsonl_blob_is_hash_checked_on_read(tmp_path):
    from autophys.store import JsonlStore, StoreError
    store = JsonlStore(tmp_path)
    key = store.put_blob(b"skill bytes", "text/markdown")
    assert store.get_blob(key) == (b"skill bytes", "text/markdown")
    assert not list((tmp_path / "blobs").glob("*.tmp"))
    (tmp_path / "blobs" / key.removeprefix("sha256:")).write_bytes(b"corrupt")
    with pytest.raises(StoreError):
        store.get_blob(key)
