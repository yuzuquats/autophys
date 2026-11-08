# autophys Python SDK

The Python SDK fits simulators to noisy measurements, analyzes identifiability,
ranks experiments and runs recorded investigations with human approval. The
analogous [Rust SDK](../rust/README.md) implements both science and local/remote
records. Its [capability table](../rust/README.md#rust-and-python-contracts-and-capabilities)
maps shared results, idiomatic API differences and remaining gaps.

## Install from this checkout

From the repository root, in an activated Python 3.10+ environment:

```sh
python -m pip install -e sdks/python
```

The [manifest](pyproject.toml) declares NumPy and SciPy as dependencies, plus
an optional `test` extra. See [contributor setup](../../CONTRIBUTING.md).
Installation from source is separate from qualification of an installed wheel.

## A local scientific calculation

This matches the Rust guide's synthetic thermal example. Direct numerical calls
create no workbook and make no network request. Generated data demonstrates API
use; it is not independent physical validation.

```python
import autophys as ap
from autophys.models import thermal_rc

settings = thermal_rc.experiment("step_long")
y = thermal_rc({"C": 500.0, "R": 2.0}, settings)
observation = ap.Observation("step_long", settings, y["t"], {"T": y["T"]}, {"T": 0.05})
observations = [observation]
result = ap.fit(thermal_rc, observations)
report, jacobian = ap.analyze(thermal_rc, result.params, observations)
ranking = ap.rank_experiments(thermal_rc, result.params, observations, {"T": 0.05}, J0=jacobian)
print(result.params, report.identified, len(ranking))
```

For a recorded investigation, continue with a workbook and proposal runner:

```python
project = ap.Project("heated-block", thermal_rc)
with ap.connect("~/autophys") as client:
    wb = client.project(project)  # creates/binds heated-block.ap-workbook
    inv = wb.investigate(ap.Dataset(observations), ap.ProposalRunner(),
                         policy=ap.ScriptedPolicy())
    outcome = inv.run()
    # If outcome.status == "awaiting_data", retain outcome.investigation
    # and outcome.proposal_id. After review, using the actual id/measurement:
    # inv.approve(proposal_id, by="reviewer")
    # inv.attach_data(proposal_id, measured_observation)
    # inv.run()

# Later, with the same Project declaration and executable simulator:
# with ap.connect("~/autophys") as client:
#     inv = client.project(project).investigation(investigation_id,
#         runner=ap.ProposalRunner(), policy=ap.ScriptedPolicy())
```

A run may finish without requesting more data. `ProposalRunner` waits for
approved external measurements; it does not acquire them. Use measured training
and separate validation observations for a scientific workflow.

## Use it in a project

The SDK is a library; it installs no command. The `autophys` command is the
Rust binary, which sets up a project that depends on this SDK and connects
the device to a server:

```sh
autophys new my-cell --lang python                  # battery-fit template, .venv installed
autophys new my-model --lang python --example blank
autophys connect https://your-server                # once per device; saves ~/.config/autophys/credentials
autophys whoami
```

The project's `pyproject.toml` depends on
`autophys @ git+https://github.com/yuzuquats/autophys@REV#subdirectory=sdks/python`,
pinned to the commit the `autophys` binary was built from (`--sdk-rev` picks
another). After `autophys connect`, `ap.connect("https://your-server")` finds
the saved key. Proposals are approved in the browser, or with
`autophys approve INVESTIGATION PROPOSAL`.

## Muse Code plugin

`muse plugins install plugins/muse-autophys` installs a native bundle with the
canonical playbook. Its stdio MCP server is the Rust `autophys mcp` command
(`autophys` on PATH, or a binary named with `build.py --autophys`). It serves
the built-in `battery_ecm` project, or your simulator with `--project
mypkg.module:project` (a `Project` or `@ap.simulator`): the binary starts this
SDK as a worker (`python -m autophys.worker`, internal) in the interpreter
named by `--python` and calls the simulator there.
Experiments are approved in the browser; there is no approve or reject MCP
tool. See the [demo and verification guide](../../autophys.project.docs/content/muse-plugin.md).

## Benchmarks, research and trajectory export

These are commands of the Rust `autophys` binary since phase B of the
[one-CLI plan](../../autophys.project.docs/content/cli.md): `autophys bench`,
`autophys research`, `autophys autoloop` and `autophys export-trajectories`,
with the flags, defaults and output files the former `python -m autophys.cli`
had (the [docs page](../../html/routes/docs.ts) lists them). Python is still
the numerical reference, and the library keeps the pieces a Python program or
harness needs:

| Call | What it does |
| --- | --- |
| `autophys.synthetic.run_case(case, policy, seed, **options)` | one benchmark investigation (`scripted`, `fake-reasoner`, or `reason` with `model_spec=` and `replay=`/`record=`), scored by the case's evaluator; returns a `BenchRow`. `autophys train eval` uses it. |
| `autophys.synthetic.case_project(view)`, `CASES`, `PLANTED_CASES`, `POLICIES` | the project a case runs under; the benchmark and planted cases; the policy factories |
| `autophys.heuristic.heuristic_responder`, `strategy_settings`, `set_setting` | the offline fake-reasoner brain and the typed playbook settings it reads |
| `autophys.measurements.read_csv(project, root, path, experiment, ...)` | lab CSV import checked against the declared experiment (sigma is never inferred) |
| `autophys.project.load_project("battery_ecm" or "mypkg.module:project")` | a trusted lab project by reference |

## Connections and workbooks (W-1..W-8)

The operator's decisions are in
[`workbook.md`](../../autophys.project.docs/content/workbook.md); the file
format both Rust and Python implement is
[`workbook-format.md`](../../autophys.project.docs/content/workbook-format.md).

New workbooks are format 1. `WorkbookStore.put_display(project_id, body)`
stores a display manifest and moves that workbook to format 2 in the same
transaction; SDK 0.1.x cannot open a format-2 workbook, so a workbook only
changes format when it first gets a display, never when it is opened.
`WorkbookStore.display(project_id)` reads it. Binding a project to a local
workbook does not write its display (an `HttpStore` uploads it to the daemon). An
`HttpStore` whose daemon has no `reveal` or `display` endpoint raises
`HttpError` saying the daemon is too old and should be upgraded.

| Call | What it does |
| --- | --- |
| `ap.connect(target=None, api_key=None)` | a directory (local collection; files created on project creation), a `*.ap-workbook` path, an `http(s)://` daemon URL, or nothing (`$AUTOPHYS_HOME`, default `~/autophys`) |
| `client.projects()` | `[{id, name}]` (plus `path` locally) |
| `client.project(project)` | bind a scientific Project, creating its workbook if needed; a name alone opens an existing workbook for review. |
| `client.open_project(name)`, `client.ensure_project(name)` | explicit open-only or create-if-absent record access; Rust has the same explicit names, but legacy Rust `project(name)` creates. |
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
through `PRAGMA data_version`. Resuming restores recorded measurements, counts, adopted model and warm start,
pending proposal and outcome. The next `run()` continues the policy; individual
scientific operations recompute results as needed.

## Effects and support boundaries

The SDK runs scientific calculations beside the simulator. Local workbooks use
SQLite; remote stores send records to the daemon through `/api/v1`, where
persistence and projection live. See the paired Rust guide for atomic attachment,
retry/idempotency, configuration pinning and credential-scoping contracts.

A3 remains open: run/approve/attach and resume check configuration pins, but
public scientific tool calls can bypass drift checks before effects. Python
MemoryStore/JsonlStore lack a public full-investigation Rust counterpart (A5),
and Rust visual policy/replay/resume is partial (A6). Total Python HTTP body/frame
bounds and transfer deadlines (PERF01), and repeated paired scientific resource
qualification (PERF02), remain open. The [SDK assessment](../../autophys.project.docs/content/productionize-sdks/README.md)
separates retained source, installed-wheel and native-artifact evidence. This
documentation refresh does not run examples or establish SDK readiness.

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
| `store.py`, `http.py` | append-only public `MemoryStore`/`JsonlStore` backends; `HttpStore` (`/api/v1`, record stream), pairing and credentials |
| `heuristic.py`, `measurements.py` | the offline fake-reasoner brain and typed playbook settings; lab CSV import |

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
| `POST /investigations/{id}/records` | `{records: [{id, kind, payload, hash_of?}]}`, 1 to 64 envelopes | `{records: [{record, gseq, created}], gseq}`: all appended in one transaction or none; each replays by id. `HttpStore.attach_data` and `append_batch` use it |
| `GET /stream?after={gseq}` | | `text/event-stream`: `id: <gseq>`, `event: record`, `data: <record>` |

A record is `{id, investigation, seq, kind, ts, payload, prev_hash, hash}`;
its global position `gseq` travels beside it (the stream's `id:`), never
inside. The client picks `id` (also sent as `Idempotency-Key`); replaying an
id returns the stored record. The server assigns `seq` and chains
`hash = sha256(prev_hash + canonical {id, kind, payload})`. Kinds:
`investigation`, `measurement`, `run`, `step`, `proposal`, `outcome`.
Credentials live in `~/.config/autophys/credentials` (JSON, mode 0600) or
`AUTOPHYS_API_KEY`; `autophys connect` writes the file, and neither the SDKs
nor the CLI print a key.

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

## Checking source and installed packages

Use the activated [contributor environment](../../CONTRIBUTING.md), from the
repository root, for `python -m pytest -q sdks/python/tests`. This checks source;
it does not establish that an installed wheel imports the same files/resources.
Wheel acceptance additionally needs an isolated install and checks with the
source path removed (pytest `-o pythonpath=`), identified package/resource hashes
and a recorded interpreter/dependency environment. The [SDK assessment](../../autophys.project.docs/content/productionize-sdks/README.md)
keeps those results separate. No tests or wheel builds ran for this docs update.

`test_conformance.py` consumes the [shared workbook/chain fixtures](../../tests/conformance/README.md).
`test_cross_writer.py` requires an identified existing Rust daemon artifact via
`AUTOPHYS_RUST_BIN` (and `AUTOPHYS_RUST_WEB_ROOT` unless bundled); live reasoner
smokes are separately opt-in. An unavailable optional prerequisite is not a pass.

The following benchmark is retained historical evidence from the earlier
migration, not a current-source, installed-wheel or current-artifact result.
It used five seeds per row (medians, evaluator view):

| Case | Status | Max rel. error | Requested |
| --- | --- | --- | --- |
| oscillator-free-only | inconclusive 5/5 | 1.52 % | none |
| oscillator | validated 5/5 | 0.19 % | sine_0.44Hz |
| thermal-short-only | inconclusive 5/5 | 0.45 % | none |
| thermal | validated 5/5 | 0.04 % | pulse |

Simulation counts and the free-only test RMSE differ slightly by CPU
(aarch64 rwc-dev-01: 308 / 644 / 133 / 336 calls, RMSE 0.194 m; x86_64
yuzuquats: 314 / 650 / 134 / 336, 0.190 m): the multistart fits take a
different number of steps under different floating-point libraries. These historical comparisons do not establish current-revision equivalence.
