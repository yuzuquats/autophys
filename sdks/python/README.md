# sdks/python: the autophys Python SDK

A Python SDK that calibrates an engineer's simulator against noisy
measurements, says which parameters those measurements actually determine,
and ranks the experiments that would determine the rest. An agent loop
drives the same tools through structured decisions and records every step.
Its records live in one workbook per project, `<project>.ap-workbook` (a
SQLite file), which the SDK writes directly or through an autophys daemon. A
reviewer approves or edits each proposed experiment in the browser viewer,
which writes into the same workbook.

```python
import autophys as ap

@ap.simulator(params={"C": ("J/K", 10, 1e5), "R": ("K/W", 0.01, 100)},
              experiments={"step": {"kind": "step", "power": 10, "duration": 120, "rate": 1}},
              outputs=("T",))
def block(params, experiment, options=ap.FIT_OPTIONS):
    ...  # return {"t": t, "T": temperature}

project = ap.Project("heated-block", block, budgets=ap.Budgets(max_experiments=2))
client = ap.connect("~/autophys")            # a directory, a .ap-workbook file, or a daemon URL
wb = client.project(project)                 # ~/autophys/heated-block.ap-workbook
inv = wb.investigate(measurements, ap.ProposalRunner(), policy=ap.ScriptedPolicy())
outcome = inv.run()                          # ends "awaiting_data" at the first proposal

# later, in any process:
inv = ap.connect("~/autophys").project(project).investigation(outcome.investigation)
inv.wait_for_approval()                      # the viewer's approve/edit lands in the file
inv.attach_data(outcome.proposal_id, observation)
inv.run()
```

## Muse Code plugin

Install the optional MCP dependency with `pip install -e 'sdks/python[mcp]'`
from the repository root, then `muse plugins install plugins/muse-autophys`.
The native bundle includes the canonical playbook and a stdio server.
`python -m autophys.cli mcp --project mypkg.module:project --workbook ~/autophys`
runs the server next to your simulator. Experiments are approved in the browser;
there is no approve or reject MCP tool. See the
[demo and verification guide](../../autophys.project.docs/content/muse-plugin.md)
for explicit venv configuration and the built-in battery CSV path.

## Offline benchmarks, research and trajectory export

In the activated contributor environment from [CONTRIBUTING.md](../../CONTRIBUTING.md),
use the SDK module entry point from the repository root (the Rust daemon also
uses the command name `autophys`):

```sh
PYTHONDONTWRITEBYTECODE=1 python -m autophys.cli bench --seeds 5 --jobs 4
```

`bench --jobs N` defaults to 1. Scripted/fake units use processes; model-bound
units use threads. Rows retain case/policy/seed order and match serial output
except wall time. Recording forces one worker with a warning.

`research` evaluates the initial playbook on train seeds, asks a researcher
for an edited strategy, validates it, evaluates it on the same train seeds,
and retains strict lexicographic improvements only. The final report compares
the initial and retained strategies on held-out seeds. Defaults are all cases,
train 0,1,2, held-out 3,4, Spark policy and Wonder API researcher.

```sh
autophys research --playbook default --iterations 2 --jobs 4   --replay policy-cassette.jsonl --researcher-replay researcher-cassette.jsonl   --output-dir ./research-result
autophys export-trajectories ./research-result --output ./decisions.jsonl
autophys export-trajectories ./collection
```

Replay cassettes must cover the chosen cases, seeds and strategies; the bundled
Spark cassette covers oscillator seed 0 with the default playbook only.
`--case` is repeatable; `--train-seeds 0,1,2`, `--heldout-seeds 3,4`,
`--policy scripted|fake-reasoner|reason`, `--model`, `--route`, `--effort`,
and the analogous `--researcher-model/route/effort` configure the two roles.
Training and held-out seeds must be disjoint and unique.

The new output directory holds every candidate's SKILL.md bytes and SHA-256,
one workbook per case/seed in each evaluation, per-run scores and failing
transcripts in `scores.json`, `iterations.json`, and `summary.json`.
The input playbook is never overwritten. Scoring first maximizes correct
status **and** diagnosis, then minimizes mean absolute log fitted/true error
over identifiable combinations, then total cost. Unknown cost cannot win a
cost tie; missing estimates score infinite error (written as null in JSON).
The contract stays in Python; researchers edit only strategy skills.

`--researcher muse` selects the Muse Code adapter. `--muse-binary`,
`--timeout`, and `--max-model-steps` configure it. Its isolated temporary
workspace contains SKILL.md, failing transcripts and a prompt file; it disables
shell, web tools, user questions, reminders and session logs. Keys are read from
`MODEL_API_KEY` and passed through stdin with `--api-key-stdin`, never argv.
No Muse installation or model run is needed for tests. The JSONL event schema
has not been verified against a live run: the defensive parser ignores unknown
events/non-JSON lines and retains recognized assistant/final text and usage.

Both roles refuse live calls unless `AUTOPHYS_ALLOW_LIVE_REASON=1`.
`--record` records policy API replies; `--researcher-record` records API
replies or CLI edited-skill JSONL cassettes, depending on the adapter.
CLI `--researcher-replay` reads these cassettes (or one saved edited SKILL.md)
without starting Muse. Researcher request keys omit volatile IDs/timings.
**MQ-2 remains replay-only: live API and real Muse runs await operator budget
authorization.** The environment override is a gate, not that authorization.

Trajectory export reads workbooks through the store API in read-only mode,
including collections and research directories. It emits one JSONL line per
reasoner decision: investigation/step, contract hash, playbook identity, model,
recorded messages (null when absent), raw response, parsed decision, validity,
normalized usage, replay flag and known research score components. Legacy
provider usage is emitted as null. Output files are created exclusively.

## Connections and workbooks (W-1..W-8)

The operator's decisions are in
[`workbook.md`](../../autophys.project.docs/content/workbook.md); the file
format both Rust and Python implement is
[`workbook-format.md`](../../autophys.project.docs/content/workbook-format.md).

| Call | What it does |
| --- | --- |
| `ap.connect(target=None, api_key=None)` | a directory (local collection, created if missing), a `*.ap-workbook` path, an `http(s)://` daemon URL, or nothing (`$AUTOPHYS_HOME`, default `~/autophys`) |
| `client.projects()` | `[{id, name}]` (plus `path` locally) |
| `client.project(project)` | the project's `Workbook`, created if new. Pass the `Project` to run investigations, or its name to read, review and approve only. |
| `wb.investigate(dataset, runner, **kw)` | a new recorded `Investigation`; `.run()` runs the loop |
| `wb.investigations()` | the projection rows: `id, status, budget_used, overrides, …` |
| `wb.investigation(id, runner=None, policy=None)` | resume from the records (`Investigation.resume`) |
| `wb.config_versions()`, `wb.verify()` | stored config versions; chain and projection check |
| `inv.records(kind=None)`, `inv.proposal(pid)` | this investigation's records; a proposal's folded state |
| `inv.approve(pid, by=, settings=)`, `inv.reject(pid, by=, reason=)`, `inv.attach_data(pid, obs)`, `inv.wait_for_approval(timeout=)` | the proposal verbs |

Locally, `WorkbookStore` opens the file with the standard library's
`sqlite3` in WAL mode and appends each record in one `BEGIN IMMEDIATE`
transaction with the daemon's rules: payload validation with field paths,
idempotent client ids, the proposal state machine, edit limits on outlook
axes, the hash chain and the projection fold. Another process (the viewer, a
second SDK) may write the same file; `wait_for_approval` notices its commit
through `PRAGMA data_version`. Resuming restores the measurements, counts,
adopted model variant, pending proposal and last outcome. Fits, sensitivities
and rankings are recomputed by the next `run()`.

## Where this came from

This package was written as **ModelLab** on yuzuquats, in
`yuzuquats:~/workspace/hacks-site/exp/modellab/python/` (package `modellab`),
and moved on 2026-11-04. It went first to tento as `tento-autophys-py`
(tento commit `74361a921`, Change-Id `Ic96fa28b3efe4b1f9c2b`, the copy and
rename) and was retargeted there, uncommitted. Then it came here, to
`autophys/sdks/python`, after the operator's S-1..S-3 rulings put autophys in
its own repo (`tento/projects/autophys.project.docs/content/repo.md`). The
source tree was copied from hacks-site `f788194b`. The original and its
virtual environment on yuzuquats are untouched. Its history is these
hacks-site commits (`Project: modellab`):

| Commit | Subject |
| --- | --- |
| `1c47d7c4` | Plan ModelLab, an SDK that calibrates simulators and picks the next experiment |
| `38e8da90` | Add the modellab simulator contract, ODE models and calibration numerics |
| `e3bc5fcd` | Add modellab projects, the investigation loop, recording and pairing CLI |
| `f788194b` | Record the ModelLab first version, its benchmark and open choices |

Its design record (decisions ML-1..ML-14) is
`hacks-site/projects/modellab.project.docs/content/{README.md,implementation.md}`;
ML-8..ML-14 are carried forward in
[`autophys.project.docs/content/sdk.md`](../../autophys.project.docs/content/sdk.md).

What changed in the move:

- **Name (AX-6).** `modellab` became `autophys` everywhere: the package,
  the `autophys` CLI (`pair`, `whoami`, `bench`), `AUTOPHYS_API_KEY`,
  `AUTOPHYS_SERVER`, `AUTOPHYS_CONFIG_DIR`, `~/.config/autophys/credentials`,
  `AUTOPHYS_LIVE_REASON_URL`, and the test fake `FakeAutophys`.
- **Contract.** The client speaks the daemon's `/api/v1` (below) instead of
  the draft `/api/modellab` on hacks.lona.so; the default server is the
  loopback daemon, `http://127.0.0.1:4794`.
- **Approval waits** consume the daemon's record stream instead of polling.
- **Outlook (E-1).** Every proposal carries a precomputed grid so the
  browser can re-score an edited proposal without running a simulation.

Numerics, the benchmark, `ScriptedPolicy` and the reasoner are unchanged; the
benchmark reproduces the source's table (see Test).

## Boundary

- **This package** runs on the user's machine next to their simulator:
  fits, diagnostics, the agent loop, the outlook grids and local recording.
  All numerics live here, and this package is their reference: AX-2 (revised 2026-11-04) has autophys-rs port them in phase 2.
- **The daemon** is this repo's `autophys serve` (loopback
  `127.0.0.1:4794`). Its record store is being built from
  `tento-autophys-store`. It stores and projects records and never computes
  from them.

- **Language model calls** go through hacks-site's reason lane,
  `POST /api/inference/reason` (text only), unchanged by the move. The policy
  sends compact text diagnostics, never raw arrays, the evaluator or the test
  split.

## What is in the package

| Module | Contents |
| --- | --- |
| `simulator.py` | `@simulator` contract: parameter schema (unit, bounds), experiment catalog, bounds validation, source hash, seed for stochastic models, `with_fixed`, `with_bias` |
| `models/` | SciPy ODE simulators: `oscillator` (m x'' + c x' + k x = F), `thermal_rc` (C dT/dt = P - (T-Ta)/R), `battery_ecm` (first-order Thevenin, OCV/capacity/SOC0 known) |
| `data.py` | `Observation` (channels, sigma, split, NaN = missing), `Dataset` (the versioned measurement set; the test split is refused) |
| `synthetic.py` | hidden-truth cases, `SyntheticRunner`, `Evaluator` (truth and held-out test, never given to an agent); data generated at rtol 1e-11 versus 1e-8 for fitting |
| `fit.py` | weighted multistart `least_squares` in log/scaled coordinates, robust losses; status, nfev, loss, chi2/N |
| `sensitivity.py` | log-parameter Jacobian, SVD, condition number and the identifiability rule |
| `design.py` | experiment ranking by min eigenvalue (default) and D-optimality of the stacked Fisher information; the E-1 outlook grid |
| `project.py` | `Project`: the declared configuration and its content-hashed config version |
| `agent.py` | `Investigation`, tools, decision schema, `ScriptedPolicy`, `ReasonLanePolicy`, guardrail |
| `reasoner.py` | `ChatReasoner` (Muse or Baseten chat completions), `reasoner_from_env`, `HttpReasoner` (reason lane), `FakeReasoner` |
| `workbook.py` | `WorkbookStore`: the `.ap-workbook` file (format, validation, state machine, projections, `check()`) |
| `client.py` | `connect`, `LocalClient`, `RemoteClient`, `Workbook` |
| `store.py`, `http.py` | append-only `MemoryStore`/`JsonlStore` (tests); `HttpStore` (`/api/v1`, record stream), pairing and credentials |

| `bench.py`, `cli.py` | benchmark runner; `autophys pair`, `whoami`, `bench` |

**Identifiability rule.** With weighted residuals and log-parameter
coordinates, `1/s_i` for a Jacobian singular value is the one-sigma
uncertainty of `log prod(theta_j ** v_ij)`. A direction is non-identifiable
when `s_i < 1e-3 * s_max` (structural) or `1/s_i > 0.1` (practical, worse
than about ±10 %). A parameter is uniquely identified only when every such
direction loads on it by at most 0.2 and its marginal log-std is at most 0.1.
The outcome never lists a parameter as identified when this rule says
otherwise, whatever the policy claims.

**Projects.** Workspace (the account a key belongs to) → project →
investigation. A project is one simulator plus its configuration: parameter
schema with initial values and free/fixed, experiment catalog with
`max_runs`, noise model (declared sigma, `estimate` a common scale, sensor
bias `off`/`fit`/`compare`), budgets and stop rules, and the policy. It is
declared in code and uploaded; the server never edits it. Each distinct
declaration is an immutable config version, `sha256:` of its canonical JSON
(which includes the simulator source hash). Every investigation pins one;
its only override is which parameters are free, recorded on the
investigation.

**Outlook (E-1, operator-decided 2026-11-04).** A catalog entry may declare
the settings a reviewer may edit and their limits,
`catalog={"sine_0.44Hz": {"max_runs": None, "edit": {"freq": [0.1, 2.0]}}}`
(at most three; only declared settings are editable). Every `proposed`
payload then carries `criterion`, its own `score` and
`outlook = {axes: [{name, values}], score: [...], after: {param: [...]}}`:
12 evenly spaced values per editable setting plus the proposed value itself,
the ranking score at every grid cell and each parameter's expected one-sigma
uncertainty after the experiment (relative for log parameters, a fraction of
the range for linear ones), row-major over the axes. With nothing editable
the grid is the single proposed point. The browser interpolates it; the grid's
simulations are not charged to the investigation's simulation budget.

## Model routes for `ReasonLanePolicy` (R-1)

`reasoner_from_env()` picks the route from `AUTOPHYS_REASON_ROUTE`:

| Route | Endpoint | Model | Key |
| --- | --- | --- | --- |
| `meta` (default) | `https://api.meta.ai/v1` | `muse-spark-1.3` | `MODEL_API_KEY` |
| `baseten` | `https://inference.baseten.co/v1` or a deployment URL | operator-chosen (`AUTOPHYS_REASON_MODEL`) | `BASETEN_API_KEY` |
| `lane` | `AUTOPHYS_REASON_URL` (`HttpReasoner`) | the lane's | the lane's |

`AUTOPHYS_REASON_URL` and `AUTOPHYS_REASON_MODEL` override a route's defaults.
Keys come from the argument, the environment, or the 0600
`reason.json` in the autophys config directory, and are never logged. On
`meta`, `max_tokens` is at least 1800, 402 is terminal and 429 is retried up to
three times after `Retry-After` (at most 30 s). Baseten cannot serve Muse, so
its decisions come from the open model you deploy.

## REST contract (`/api/v1` on the autophys daemon)

The route table is owned by
`tento/projects/autophys.project.docs/content/architecture.md` ("API: the SDK's
draft contract, rehomed"): the SDK's draft routes, moved from `/api/modellab`
to `/api/v1`, plus `GET /workspace` and `GET /stream`. All bodies are JSON.
Every route except `pair/*` needs `Authorization: Bearer <api key>`. Errors
are `{error, message}`.

| Request | Body | Response |
| --- | --- | --- |
| `POST /pair/start` | `{device_name, client}` | `{device_code, user_code, verification_url, interval, expires_in}` |
| `POST /pair/poll` | `{device_code}` | `200 {api_key, key_id, account, workspace}`; `400 {error}` with `authorization_pending`, `slow_down`, `access_denied` or `expired_token` |
| `GET /whoami` | | `{account, workspace, key_id, device_name}` |
| `GET /projects`, `POST /projects` | `{name}` | `{projects}`; `{project}` (idempotent by name, 200 existing, 201 new) |
| `GET /projects/{pid}/config_versions` | | `{config_versions: [{version, config}]}` |
| `PUT /projects/{pid}/config_versions/{version}` | the canonical config JSON | `{version}`; 422 `hash_mismatch` unless `sha256(body bytes) == version` |
| `GET /investigations`, `POST /investigations` | `{project_id, config_version, overrides: {free, fixed}, meta}` | `{id}`; 409 `unknown_config_version` |
| `POST /investigations/{id}/measurements` · `/runs` · `/steps` · `/outcome` | record envelope `{id, kind, payload}` | `{record}` |
| `POST /investigations/{id}/proposals` | envelope, `payload.event = proposed` (with E-1's `outlook`) | `{record}` |
| `GET /investigations/{id}/proposals/{pid}` | | `{proposal_id, status, experiment, settings}` |
| `POST /investigations/{id}/proposals/{pid}/approvals` | envelope, event `approved`, `edited` (with `settings`) or `rejected` | `{record}`; 409 unless `proposed` |
| `POST /investigations/{id}/proposals/{pid}/data` | envelope, event `data_attached` with `measurement_version` | `{record}`; 409 unless approved or edited |
| `GET /investigations/{id}/records?kind=` | | `{records}` |
| `GET /stream?after={gseq}` | | `text/event-stream`: `id: <gseq>`, `event: record`, `data: <record>` |

A record is `{id, investigation, seq, kind, ts, payload, prev_hash, hash}`;
its global position `gseq` travels beside it (the stream's `id:`), never
inside. The client picks `id` (also sent as `Idempotency-Key`); replaying an
id returns the stored record. The server assigns `seq` and chains
`hash = sha256(prev_hash + canonical {id, kind, payload})`. Kinds:
`investigation`, `measurement`, `run`, `step`, `proposal`, `outcome`.
Credentials live in `~/.config/autophys/credentials` (JSON, mode 0600) or
`AUTOPHYS_API_KEY`; the CLI never prints a key.

**Waiting for an approval.** `Investigation.run()` never blocks: a proposal
ends the run with status `awaiting_data`. `Investigation.wait_for_approval()`
then waits. Over `HttpStore` it consumes `GET /stream?after=<cursor>`: it
subscribes, reads the proposal once (a decision made before the cursor),
then returns on the first `approved`, `edited` or `rejected` record of that
proposal. An idle or dropped stream reconnects from the last `id:` seen. If
the stream is missing (404, wrong content type, connection refused), or with
`stream=False`, it polls `GET .../proposals/{pid}` every `interval` seconds.
`HttpStore.last_wait` reports which one served the last wait. Memory and
JSON-lines stores poll their own records.

## Test

The environment lives outside the checkout:

```sh
python3 -m venv ~/.cache/autophys/venv
~/.cache/autophys/venv/bin/pip install numpy scipy pytest
cd sdks/python  # from the repository root

PYTHONDONTWRITEBYTECODE=1 ~/.cache/autophys/venv/bin/python -m pytest -q
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src ~/.cache/autophys/venv/bin/python -c 'from autophys.cli import main; import sys; sys.exit(main(sys.argv[1:]))' bench --seeds 5
```

On rwc-dev-01 (Python 3.12.3, SQLite 3.45.1, NumPy 2.5.4, SciPy 1.18.1,
aarch64) the suite is 382 passed, 2 skipped, in about 112 s with no network (Muse batch 2).
HTTP code is tested against an in-process fake of `/api/v1`
(`tests/fake_server.py`), including the stream. Workbook tests include a
second process approving while the SDK waits. The two skips are opt-in:

- a smoke that sends one decision through a running reason lane
  (`AUTOPHYS_LIVE_REASON_URL=http://127.0.0.1:4861 pytest -k live`);
- `tests/test_cross_writer.py`, which starts the Rust daemon on a free port
  over a private collection, pairs a key, and has the daemon (through
  `HttpStore`) and a local `WorkbookStore` write one workbook at once; both
  verifiers must agree. Point `AUTOPHYS_RUST_BIN` at a built `autophys`
  (`AUTOPHYS_RUST_WEB_ROOT` too unless it is a deployed bundle).

`tests/test_conformance.py` is the shared suite (W-4): the hash-chain vectors
in `tests/vectors/chain.json` and the golden workbooks in
`tests/conformance/` (see its README; regenerate the Python ones with
`tests/conformance_cases.py`).

Build the wheel and test the installed package in a clean environment:

```sh
~/.cache/autophys/venv/bin/python -m pip wheel --no-deps -w ~/.cache/autophys/dist .
rm -rf build src/autophys.egg-info               # setuptools' build leftovers
python3 -m venv ~/.cache/autophys/venv-check
~/.cache/autophys/venv-check/bin/pip install ~/.cache/autophys/dist/autophys-0.1.0-py3-none-any.whl pytest
PYTHONDONTWRITEBYTECODE=1 ~/.cache/autophys/venv-check/bin/python -m pytest -q -o pythonpath=
~/.cache/autophys/venv-check/bin/autophys bench --seeds 5
```

`-o pythonpath=` drops `src` from the path, so the tests import the installed
wheel.

The benchmark (5 seeds per row, medians, evaluator view) reproduces the
source's statuses, errors and requests on both policies:

| Case | Status | Max rel. error | Requested |
| --- | --- | --- | --- |
| oscillator-free-only | inconclusive 5/5 | 1.52 % | none |
| oscillator | validated 5/5 | 0.19 % | sine_0.44Hz |
| thermal-short-only | inconclusive 5/5 | 0.45 % | none |
| thermal | validated 5/5 | 0.04 % | pulse |

Simulation counts and the free-only test RMSE differ slightly by CPU
(aarch64 rwc-dev-01: 308 / 644 / 133 / 336 calls, RMSE 0.194 m; x86_64
yuzuquats: 314 / 650 / 134 / 336, 0.190 m): the multistart fits take a
different number of steps under different floating-point libraries. The
rename-only tree and this tree give identical rows on the same host.
