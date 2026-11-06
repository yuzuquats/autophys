"""Real daemon cross-language attachment effects, failures, visibility and restart."""
import concurrent.futures
import copy
import http.client
import json
import os
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import pytest
import autophys as ap
from autophys.agent import Investigation, ToolError
from autophys.http import HttpStore, HttpError
from autophys.store import StoreError
from test_cross_writer import daemon, BIN
from test_review_regressions import pending

PEER = os.environ.get("AUTOPHYS_CORE_PEER")
pytestmark = pytest.mark.skipif(not BIN or not PEER, reason="requires identified daemon and Rust core peer")


def peer(daemon, inv=None, obs=None, *, target=None, action="attach"):
    body = {"target": target or daemon["url"], "key": daemon["key"], "action": action}
    if inv is not None: body.update(inv=inv.id, pid=inv.pending, observation=obs.to_dict())
    p = subprocess.run([PEER], input=json.dumps(body), text=True, capture_output=True, timeout=20)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def invariant(store, inv_id, initial):
    records = store.records(inv_id)
    measurements = [r for r in records if r.kind == "measurement"]
    events = [r for r in records if r.kind == "proposal" and r.payload["event"] == "data_attached"]
    assert len(measurements) == initial + len(events)
    assert len(events) <= 1
    if events:
        link = events[0].payload["measurement_version"]
        assert link in (measurements[-1].hash, measurements[-1].payload.get("version"))
    return records


def test_real_daemon_race_matrix_no_orphans_and_one_cost(daemon):
    store = HttpStore(daemon["url"], daemon["key"])
    for pair in [("python", "python"), ("rust", "rust"), ("python", "rust"), ("python", "local-python"), ("rust", "local-rust")]:
        inv, view, project = pending(store)
        pid = inv.pending; inv.approve(pid)
        original = view.runner.run(inv.pending_experiment); original.split = "train"
        alternate = copy.deepcopy(original)
        next(iter(alternate.y.values()))[0] += 1.
        initial = len(inv.records("measurement"))
        barrier = threading.Barrier(3); done = threading.Event(); observed = []; reader_errors = []
        def read():
            while not done.is_set():
                try: invariant(store, inv.id, initial); observed.append(1)
                except BaseException as e: reader_errors.append(e); return
                time.sleep(.002)
        reader = threading.Thread(target=read); reader.start()
        def run(language, obs):
            with ap.connect(daemon["coll"]) as local:
                if language in ("python", "local-python"):
                    selected = local.project(project).store if language == "local-python" else HttpStore(daemon["url"], daemon["key"])
                    current = Investigation.resume(project, selected, inv.id)
                barrier.wait(10)
                try:
                    if language in ("python", "local-python"):
                        current.attach_data(pid, obs); return True
                    return peer(daemon, inv, obs, target=str(daemon["coll"]) if language == "local-rust" else None)["ok"]
                except ToolError as error:
                    # The winner may commit before the losing client's precheck.
                    # Only the expected already-attached refusal is a valid loss.
                    assert " is data_attached; approve it before attaching data" in str(error)
                    return False
                except (StoreError, HttpError): return False
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                a = pool.submit(run, pair[0], original); b = pool.submit(run, pair[1], alternate)
                barrier.wait(10)
                results = [a.result(25), b.result(25)]
        finally:
            done.set(); reader.join(5)
        assert not reader.is_alive() and not reader_errors and observed, (pair,reader_errors)
        assert sorted(results) == [False,True], (pair,results)
        invariant(store, inv.id, initial)
        restored = Investigation.resume(project, store, inv.id)
        assert restored.experiments_used == 1 and restored.dataset.version == initial + 1 and restored.pending is None
        with ap.connect(daemon["coll"]) as local:
            assert local.project(project.name).verify()["ok"]


def test_real_atomic_second_insert_failure_and_response_loss_restart(daemon, monkeypatch):
    store = HttpStore(daemon["url"], daemon["key"])
    for language in ["python", "rust"]:
        inv, view, project = pending(store); pid=inv.pending; inv.approve(pid)
        obs=view.runner.run(inv.pending_experiment);obs.split="train"
        initial=len(inv.records("measurement"))
        book=None
        for candidate in daemon["coll"].glob("*.ap-workbook"):
            with sqlite3.connect(candidate) as db:
                if db.execute("select 1 from investigations where id=?",(inv.id,)).fetchone(): book=candidate
        assert book is not None
        with sqlite3.connect(book) as db:
            db.execute("CREATE TRIGGER test_atomic_abort BEFORE INSERT ON records WHEN NEW.kind='proposal' AND json_extract(NEW.payload,'$.event')='data_attached' BEGIN SELECT RAISE(ABORT,'injected second insert failure'); END")
        try:
            if language=="python":
                with pytest.raises(HttpError): inv.attach_data(pid,obs)
            else: assert not peer(daemon,inv,obs)["ok"]
            assert len(invariant(store,inv.id,initial)) == len(inv.records())
            assert len(inv.records("measurement"))==initial and inv.proposal(pid)["status"]=="approved"
        finally:
            with sqlite3.connect(book) as db: db.execute("DROP TRIGGER test_atomic_abort")
        daemon["stop"]();daemon["restart"]()
        if language=="python": inv.attach_data(pid,obs)
        else: assert peer(daemon,inv,obs)["ok"]
        invariant(store,inv.id,initial)
        assert Investigation.resume(project,store,inv.id).experiments_used==1
    # Both transports: a request dropped before forwarding, or a committed
    # response dropped on a real temporary TCP proxy. No daemon failpoint exists.
    for language in ["python","rust"]:
      for after_commit in [False,True]:
        inv,view,project=pending(store);pid=inv.pending;inv.approve(pid)
        obs=view.runner.run(inv.pending_experiment);obs.split="train";initial=len(inv.records("measurement"))
        upstream=urlsplit(daemon["url"]); dropped=[]
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self,*a): pass
            def do_GET(self): self.forward()
            def do_POST(self): self.forward()
            def forward(self):
                body=self.rfile.read(int(self.headers.get("Content-Length",0)))
                attachment=self.path.endswith("/attachment") and not dropped
                if attachment: dropped.append(True)
                if not attachment or after_commit:
                    conn=http.client.HTTPConnection(upstream.hostname,upstream.port,timeout=5)
                    try:
                        conn.request(self.command,self.path,body,dict(self.headers))
                        response=conn.getresponse(); data=response.read();status=response.status
                    finally: conn.close()
                if attachment:
                    self.close_connection=True;return
                self.send_response(status);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
        proxy=ThreadingHTTPServer(("127.0.0.1",0),Proxy); thread=threading.Thread(target=proxy.serve_forever);thread.start()
        target=f"http://127.0.0.1:{proxy.server_port}"
        try:
            if language=="python":
                inv.store=HttpStore(target,daemon["key"])
                with pytest.raises(OSError): inv.attach_data(pid,obs)
            else: assert not peer(daemon,inv,obs,target=target)["ok"]
            assert dropped and len(store.records(inv.id,"measurement"))==initial+int(after_commit)
            invariant(store,inv.id,initial)
        finally:
            proxy.shutdown();proxy.server_close();thread.join(5)
        daemon["stop"]();daemon["restart"]()
        if language=="python":
            inv.store=store;inv.attach_data(pid,obs)
        else:
            assert peer(daemon,inv,obs)["ok"]
            assert peer(daemon,inv,obs)["ok"] # idempotent public retry
        invariant(store,inv.id,initial)
        restored=Investigation.resume(project,store,inv.id)
        assert restored.experiments_used==1 and restored.dataset.version==initial+1
        different=copy.deepcopy(obs);next(iter(different.y.values()))[0]+=2
        if language=="python":
            # Use a pre-effect stale handle; conflict must occur at the daemon.
            measurement={"version":initial+1,"digest":"different","observation":different.to_dict()}
            with pytest.raises(HttpError):store.attach_data(inv.id,pid,measurement,{"proposal_id":pid,"event":"data_attached","measurement_version":initial+1,"digest":different.digest()})
        else: assert not peer(daemon,inv,different)["ok"]
        invariant(store,inv.id,initial)


def test_real_retained_blob_handles_and_record_references(daemon):
    from test_core_boundaries import inputs
    c=ap.connect(daemon["url"],api_key=daemon["key"])
    p,ds=inputs();p.name="A";a=c.project(p)
    q,_=inputs();q.name="B";b=c.project(q)
    ka=a.store.put_blob(b"A image","image/png");kb=b.store.put_blob(b"B playbook","text/markdown")
    class ImagePolicy:
        name="stored-image-test"
        images_enabled=True
    inv=a.investigate(ds,None,policy=ImagePolicy())
    inv._record("step",{"images":[{"sha256":ka,"media_type":"image/png"}]})
    assert c.project("A").store.get_blob(ka)==(b"A image","image/png")
    assert c.project("B").store.get_blob(kb)==(b"B playbook","text/markdown")
    with pytest.raises(HttpError):a.store.get_blob(kb)
    resumed=a.investigation(inv.id,policy=ImagePolicy())
    assert resumed.store.get_blob(ka)[0]==b"A image"
    import base64
    assert base64.b64decode(resumed.plot_images[0]["data"])==b"A image"
    assert peer(daemon,action="blobs")["ok"]
    assert a.verify()["ok"] and b.verify()["ok"]


def test_real_paired_explicit_open_and_create_effects(daemon):
    def books():
        return {p.name: p.read_bytes() for p in daemon["coll"].glob("*.ap-workbook")}
    def rust(target, action, name):
        body = {"target": target, "key": daemon["key"], "action": action, "name": name}
        p = subprocess.run([PEER], input=json.dumps(body), text=True, capture_output=True, timeout=20)
        assert p.returncode == 0, p.stderr
        return json.loads(p.stdout)
    for remote in [False, True]:
        target = daemon["url"] if remote else str(daemon["coll"])
        for language in ["python", "rust"]:
            name = f"explicit-{language}-{remote}"
            before = books()
            with ap.connect(target, **({"api_key": daemon["key"]} if remote else {})) as c:
                if language == "python":
                    with pytest.raises(StoreError): c.open_project(name)
                else:
                    missing = rust(target, "open", name)
                    assert not missing["ok"] and missing["status"] == 404
                assert books() == before, (remote, language, "missing open wrote workbook")
                if language == "python":
                    a = c.ensure_project(name); b = c.ensure_project(name)
                    assert a.project_id == b.project_id == c.open_project(name).project_id
                else:
                    a = rust(target, "ensure", name); b = rust(target, "ensure", name)
                    opened = rust(target, "open", name)
                    assert a["ok"] and b["ok"] and opened["ok"]
                    assert a["result"]["created"] and not b["result"]["created"]
                    assert a["result"]["id"] == b["result"]["id"] == opened["result"]["id"]
                assert len(books()) == len(before) + 1
