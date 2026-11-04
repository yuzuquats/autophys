"""Seed a scratch autophys daemon through the real /api/v1 with the repo's Python SDK.

usage: seed.py <base-url> <server-db> <autophys-binary>
Pairs a device (approving it with `autophys pair approve --server-db`), then runs the oscillator
case with a ProposalRunner so the investigation stops at a proposal awaiting approval.
"""
import json, subprocess, sys, urllib.request
sys.path.insert(0, sys.argv[4] if len(sys.argv) > 4 else "sdks/python/src")
base, db, binary = sys.argv[1:4]
from urllib.parse import urlparse
url = urlparse(base)
if url.hostname != "127.0.0.1" or url.scheme != "http" or url.port not in range(47950, 48000):
    raise SystemExit("scratch loopback daemon on ports 47950..47999 required")

def post(path, body):
    req = urllib.request.Request(base + "/api/v1" + path, json.dumps(body).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

start = post("/pair/start", {"device_name": "ui-seed", "client": "seed.py"})
subprocess.run([binary, "pair", "approve", start["user_code"], "--server-db", db], check=True, stdout=subprocess.DEVNULL)
key = post("/pair/poll", {"device_code": start["device_code"]})["api_key"]

from autophys.agent import Investigation, ProposalRunner
from autophys.bench import CASES, POLICIES
from autophys.http import HttpStore
from autophys.project import Budgets, Project

view, _ = CASES["oscillator"](0)
sim = view.simulator
catalog = {n: {"max_runs": None} for n in sim.experiments}
catalog["sine_0.44Hz"] = {"max_runs": None, "edit": {"amplitude": [0.5, 4.0], "freq": [0.2, 1.0]}}
project = Project(name="bench oscillators", simulator=sim, budgets=Budgets(max_experiments=view.max_experiments), catalog=catalog)
store = HttpStore(base, key)
inv = Investigation(project, view.dataset, ProposalRunner(), policy=POLICIES["scripted"](), store=store, seed=0, title="bench A")
out = inv.run()
print(json.dumps({"investigation": inv.id, "status": out.status, "pending": inv.pending}))
