# The Python SDK: moved from hacks-site, renamed autophys, speaking /api/v1

Status: SDK page, rev 2, 2026-11-04. Owner: autophys/api (thread 755eea02). It covers the SDK half of phase 5 in
tento's `projects/autophys.project.docs/content/architecture.md` ("SDK
retargeted to `/api/v1` (renamed to autophys)"). That means the package at
`autophys/sdks/python`, what changed in the move, the decisions it carries,
and the contract points the daemon's store has to settle. It changes neither
that page nor the cover. The location follows the operator's S-1..S-3
rulings (tento `repo.md`): the SDK lives in this repo. It passed through
tento as `tento-autophys-py` (tento commit `74361a921`, Change-Id
`Ic96fa28b3efe4b1f9c2b`, the copy and rename), and that copy is for the
orchestrator to remove.


## What moved and what changed

The SDK was written as ModelLab in `yuzuquats:~/workspace/hacks-site/exp/modellab/python`
(hacks-site commits `1c47d7c4`, `38e8da90`, `e3bc5fcd`, `f788194b`,
`Project: modellab`). Its record, with decisions ML-1..ML-14, is
`hacks-site/projects/modellab.project.docs/content/{README.md,implementation.md}`.
The yuzuquats original and its venv `~/.cache/modellab/venv` are untouched.

```review-table
| Area              | Before (hacks-site ModelLab)                        | After (autophys sdks/python)                                 |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Package, CLI      | `modellab`, `modellab pair/whoami/bench`             | `autophys`, `autophys pair/whoami/bench` (AX-6)               |
| Server            | draft `/api/modellab` on `https://hacks.lona.so`     | daemon `/api/v1`, default `http://127.0.0.1:4794`             |
| Credentials       | `~/.config/modellab/credentials`, `MODELLAB_API_KEY` | `~/.config/autophys/credentials` (0600), `AUTOPHYS_API_KEY`   |
| Approval wait     | poll `GET …/proposals/{pid}` every 5 s               | consume `GET /stream?after=<gseq>`; poll as the fallback (SD-1) |
| Proposal payload  | experiment, settings, rationale                      | plus `criterion`, `score`, `outlook` (E-1)                    |
| Numerics, bench   | —                                                    | unchanged; same statuses, errors and requests                 |
```

`Investigation.run()` itself never waits: a proposal ends the run with
`awaiting_data`, as before. The wait is `Investigation.wait_for_approval()`,
which now hands off to `HttpStore.wait_for_approval()`. That method uses the
stream when the daemon serves one and records which path served it in
`HttpStore.last_wait` (`"stream"` or `"poll"`). Today's batch-1 daemon on
rwc-dev-01 answers 404 on `/api/v1/stream`, so against it the SDK polls.

## Decisions

```review-callout
kind: decision
title: E-1 — the browser re-scores an edited proposal from a grid the SDK precomputes
Operator-decided, 2026-11-04. Nothing re-runs a simulation in the browser.
Every `proposed` payload carries `outlook: {axes: [{name, values}], score,
after: {param: values}}`, row-major over the axes. The axes cover each
editable setting within its catalog limits, 12 points per axis by default,
at most 3 axes. `score` is the ranking score and `after[param]` the expected
one-sigma relative uncertainty after the experiment, both from the existing
Fisher code (`design.settings_score`, `design.outlook`). Implemented in the
working tree; a test checks that the grid value at the proposed settings
equals the proposal's own score.
```

The operator fixed the shape. The details below are agent-chosen, pending
operator review. Each is cheap to reverse inside the SDK.

```review-table
| Id    | Choice                                                         | Strongest alternative and tradeoff                             | Reverse                                  |
| ----- | -------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| E-1a  | Editable settings are declared per catalog entry: `catalog[name]["edit"] = {setting: [lo, hi]}`. Nothing is editable unless declared. A declared `edit` enters the config hash; configs without it keep their old hash. | Infer limits from the settings (for example ×0.25..×4). That needs no declaration, but it invents limits the engineer never approved. | drop the field and its validation |
| E-1b  | Each axis has 12 evenly spaced values over `[lo, hi]`. The proposed value is inserted if it is not already on the grid, so an axis may have 13. | Snap the proposed value onto the grid. That gives exactly 12 points, but the proposal's own cell is then not its own settings. | one helper, `design._axis` |
| E-1c  | `after` is `sqrt(diag(F⁻¹))` in fitting coordinates: relative for log parameters, a fraction of the range for linear ones. Eigenvalues below the `d_opt` ridge are floored, so values stay finite (the store refuses non-finite numbers). | Report `null` for an unresolved parameter. That is more honest, but the store's finite-array rule would refuse it. | `design.settings_score` |
| E-1d  | The payload also carries `criterion` (the latest ranking's, default `min_eig`) and `score`, the proposal's own value. | Leave the UI to read the cell at the proposed settings. That needs no new field, but the UI must also know which criterion the scores use. | two payload fields |
| E-1e  | The grid's simulations are not charged to `max_simulations`. Their count is recorded on the step as `outlook_simulations`. A 3-axis grid of 13³ ≈ 2,200 cells × (2p + 1) runs, about 15,000 for three parameters, would otherwise take most of the default 20,000-call budget.
 | Charge them. Then the budget bounds all compute, but an outlook can end the investigation as `budget_exhausted`. | one try/finally in `Investigation.proposal_outlook` |
| E-1f  | With no fit yet, the outlook is taken at the project's initial values (bound midpoints otherwise). | Refuse a proposal before a fit. That is safer, but it changes which policies may propose. | one branch |
```

```review-callout
kind: decision
title: SD-1 — wait on the record stream, poll when it is missing
Agent-chosen, pending operator review. Before: poll the proposal every 5 s.
After: subscribe to `GET /stream?after=<cursor>`, read the proposal once
(a decision made before the cursor), then return on the first `approved`,
`edited` or `rejected` record for it. An idle or dropped stream reconnects
from the last `id:` seen. A 404, a non-`text/event-stream` answer or a
refused connection falls back to polling, and a bad key raises. This puts
the approval round trip in `architecture.md` on one push instead of up to
5 s of latency, at the cost of one long-lived connection per waiting SDK.
The strongest alternative is to keep polling only, which is simpler and has
no reconnect logic, but needs one request per interval and never sees an
approval sooner. Reverse: pass `stream=False`, or delete `_wait_streaming`
(about 40 lines). Implemented in the working tree, with tests for stream,
resume after idle, fallback and bad key.
```

### Carried forward from ModelLab (ML-8..ML-14)

Each is **agent-chosen, pending operator review**. They were made on
yuzuquats and are unchanged by the move. Each is reversible in the SDK at
low cost unless stated.

```review-table
| Id    | Before → after                                                  | Strongest alternative and tradeoff                               | Reverse                                    |
| ----- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| ML-8  | no rule → identifiability thresholds: structural `s_i < 1e-3 s_max`, practical `1/s_i > 0.1` (about ±10 % one-sigma), loading 0.2 | profile likelihood; more faithful for nonlinear models, 10-50× the simulations | `IdentifiabilityRule` defaults (part of the config hash, so a new config version) |
| ML-9  | ranking default is E-optimal (min eigenvalue): it matches the prototype and scores a repeated ambiguous experiment at zero; D-optimality is reported beside it | D-optimal default; prefers overall volume shrink and gives the repeat a positive score | one default argument (E-1's outlook follows the ranking's criterion) |
| ML-10 | `validated` requires every free parameter identified, a converged fit and a passing validation split (chi2/N ≤ 2) | `validated` with a partial-identification note | one condition in `_finish` |
| ML-11 | contract shape: per-kind POST routes, client-chosen record ids (idempotency), server-assigned hash chain, config versions PUT by raw-body hash. `architecture.md` adopted it as `/api/v1` | one generic `/records` route | cost rises now that `tento-autophys-store` implements it |
| ML-12 | project configuration: sensor bias `off`/`fit`/`compare` (default `compare`, a BIC model variant); noise `estimate` as one common scale `sqrt(chi2/N)`; catalog `max_runs`; fixed parameters need an `initial` value | (E-1a adds the catalog's optional `edit`) | per field, each a new config version |
| ML-13 | user-facing "measurements": record kind `measurement`, route `/measurements`, diagnostics line `MEASUREMENTS:`; the Python class stays `Dataset` | "data" or "observations" | rename at the route and record kind, now a daemon change too |
| ML-14 | catalog constants: free response x0 = 0.1 m; impulse 0.5 N s; thermal truth C = 500 J/K, R = 2 K/W; the 120 s short step leaves R practically non-identifiable (log-std 0.29) | other constants; the benchmark table would change | the model and synthetic modules |
```

## Operator decisions on the SDK (open-questions, 2026-11-04)

```review-table
| Id  | Question | Decision | Reason and constraints | Implementation |
| --- | -------- | -------- | ---------------------- | -------------- |
| R-1 | Where `ReasonLanePolicy`'s model calls go (contract question 13) | Two switchable routes over plain HTTP, both OpenAI chat completions: `meta` (Muse Spark, `https://api.meta.ai/v1`, model `muse-spark-1.3`, the default) and `baseten` (hosted `https://inference.baseten.co/v1` or a dedicated deploy URL). Selected by `AUTOPHYS_REASON_ROUTE`; URL, model and key per route; keys from the environment (`MODEL_API_KEY` for Meta, as Meta's docs use) or a 0600 credentials file, never logged. No hacks-site dependency and no client package: Meta publishes no SDK of its own (dev.meta.ai/docs/sdks) and Rust would do plain HTTP anyway. | Operator, 2026-11-04 ("specific to muse for now", then "switch between plain http and baseten"). Muse reasons before answering: keep `max_tokens` at least 1800, treat 402 `billing_not_configured` as terminal, honour 429 `Retry-After` (hacks-site providers.md). Baseten cannot serve Muse (weights are not public), so that route runs an operator-chosen open model and its decisions are not Muse's. Rust phase 2 mirrors it. | not started |
| WB-1 | Resume restores the last fit | Keep resume as implemented, and also rebuild the last `FitResult` from the latest `run` record of the adopted model, so the next fit warm-starts as in an uninterrupted run. Sensitivities, rankings and validation stay recomputed. | Operator, 2026-11-04, reversing the agent choice WB-1 below. Resume must equal the uninterrupted run exactly; a test asserts equality; Rust phase 2 mirrors it. | pending (ea53428 recomputes) |
| ML-8 | Identifiability rule | Confirmed: keep the linearised SVD rule with defaults structural `1e-3`, practical `0.1`, loading `0.2`. Profile likelihood only as a possible later opt-in. | Operator, 2026-11-04. Cheap per step, 5/5 correct on the benchmark, simple to match in Rust. | implemented |
| ML-10 | When an investigation is `validated` | Confirmed: all-or-nothing. Every free parameter identified, a converged fit, and the validation split passing at that fit; otherwise `inconclusive` with reasons. | Operator, 2026-11-04. `validated` never needs a footnote; parameters nobody cares about are marked fixed. | implemented |
| ML-9 | Default experiment ranking | Confirmed: E-optimal (`min_eig`); D-optimal recorded beside it and selectable per call. | Operator, 2026-11-04. It targets the weakest direction, which is what blocks `validated` (ML-10). | implemented |
| E-1a | Who declares editable settings | Confirmed: declared per catalog experiment, `edit: {setting: [lo, hi]}`, numeric, limits contain the value, at most 3; nothing else is editable. | Operator, 2026-11-04. Approved experiments run on real hardware, so bounds come from the engineer. | implemented |
| E-1b | Outlook axis sampling | Confirmed: 12 evenly spaced values over `[lo, hi]`, with the proposed value inserted (12-13 points), so the proposal's own cell is exact. | Operator, 2026-11-04. | implemented |
| E-1c | Meaning of `after` and unresolved parameters | Keep `after` finite (floored at the D-optimal ridge), and add `after_resolved_max` (default 1.0) to the outlook; above it the UI shows "not determined". No `null`s, so the outlook validator and goldens are unchanged. | Operator, 2026-11-04. | pending: add the field |
| E-1d | `criterion` and `score` on proposals | Confirmed: keep both. | Operator, 2026-11-04. Stored proposals are self-describing if the ranking default changes. | implemented |
| E-1e | Outlook simulations and the budget | Uncharged to `max_simulations` (recorded as `outlook_simulations`), under a new `Budgets.max_outlook_simulations` (default 50,000). Exceeding it, or the 1 MiB payload limit, reduces points per axis instead of failing. Closes Q-12. | Operator, 2026-11-04. An outlook informs the reviewer and must not end an investigation. New budget field: a new config version for projects that set it. | pending: the cap |
| E-1f | Outlook before any fit | Keep computing at the initial values (bound midpoints otherwise), and mark the outlook with `at: "initial"` or `"fit"`. | Operator, 2026-11-04. Investigations may start without usable data; the UI says "based on prior guess". | pending: the marker |
| SD-1 | How a remote SDK waits for an approval | Confirmed: the SSE stream, falling back to 5 s polling. Remote connections only; local workbooks use `data_version` (WB-4). | Operator, 2026-11-04. | implemented |
| WB-2..6 | Workbook details | Keep WB-2 (register on open), WB-3 (open by name is review-only), WB-4 (0.1 s `data_version` checks) and WB-6 (random-id goldens). Change WB-5: the base `Store` enforces the full workbook rules, so `MemoryStore` and `JsonlStore` behave like a workbook. | Operator, 2026-11-04 ("go ahead" on the agent's recommendations). | WB-5 pending |
| Q-6 | SDK approvals with a key | Allowed. SDK approvals and rejections record `by` and `via: "sdk"`, plus the key id on a remote connection. | Operator, 2026-11-04. Browser-only cannot be enforced on local workbooks. | pending: the `via` stamp |
| Q-7 | SDK withdraw | Add `inv.withdraw(pid, reason=)`: event `withdrawn`, only from `proposed`; clears the pending proposal. | Operator, 2026-11-04. | pending |
| ML-11 | `/api/v1` contract shape | Confirmed: per-kind POST routes, client-chosen record ids as `Idempotency-Key`, server-assigned `seq` and hash chain, config versions PUT by the hash of their exact bytes. | Operator, 2026-11-04. The daemon, the Rust plan and `HttpStore` are built on it. | implemented |
| ML-12 | Project configuration defaults | Confirmed: sensor bias `compare` (offset variants adopted only by BIC), declared or observed sigma with an opt-in `estimate`, catalog `max_runs`, fixed parameters need `initial`. | Operator, 2026-11-04. | implemented |
| ML-13 | The data's name | Confirmed: "measurements" (record kind `measurement`); the Python classes stay `Dataset` and `Observation`. | Operator, 2026-11-04. | implemented |
| ML-14 | Benchmark constants | Confirmed: keep the oscillator and thermal truths and settings; add cases rather than change these. | Operator, 2026-11-04. They also seed the Rust numeric goldens. | implemented |
```

## Workbooks in the SDK (rev 2)

The operator's W-1..W-8 (`workbook.md`) are implemented in the SDK:
`workbook.py` (`WorkbookStore`, the format in `workbook-format.md`),
`client.py` (`connect`, `LocalClient`, `RemoteClient`, `Workbook`),
`Investigation.resume`, `inv.records`, `inv.proposal`, the proposal event
`withdrawn`, and the shared suite `tests/test_conformance.py` with goldens in
`tests/conformance/`. The Python names in `rust-sdk.md`'s table are the ones
shipped. These details are **agent-chosen, pending operator review**:

```review-table
| Id   | Choice | Strongest alternative and tradeoff | Reverse |
| ---- | ------ | ---------------------------------- | ------- |
| WB-1 | Resume restores measurements, step/simulation/experiment counts, the adopted model variant, the fit counter, the pending proposal and the last outcome. Fits, sensitivities and rankings are recomputed by the next `run()`. | Rebuild the last `FitResult` from its `run` record, so a resumed run can skip one fit. That saves simulations, but adds a second source of fit state. | add `FitResult.from_dict` and restore in `_replay` |
| WB-2 | `client.project(Project)` records the project in its workbook at once, so a slug collision (`Thermal` vs `thermal`) is refused when it is opened. | Record it at the first `investigate`. That means no write on open, but the collision surfaces later. | one line in `LocalClient.project` |
| WB-3 | Opening by name (`client.project("heated-block")`) is review-only: `investigate` and `investigation(id)` need the `Project`, because resuming checks the pinned config version and runs the simulator. | Allow record-only reads of an investigation by name through a separate handle. That costs a second investigation type. | a small read-only class |
| WB-4 | A local `wait_for_approval` checks `PRAGMA data_version` every 0.1 s and re-reads the proposal only when the file changed. | Use OS file notifications. That avoids polling, but differs per OS and isn't reliable for WAL commits. | `WorkbookStore.watch_interval` |
| WB-5 | `MemoryStore` and `JsonlStore` stay as test backends with their older, looser checks. Only `WorkbookStore` and the daemon enforce the full rules. | Port the rules into the base `Store`. That gives one behaviour everywhere, but breaks tests that write partial payloads. | move `payload_shape` and the transition check into `Store.append` |
| WB-6 | The goldens are committed SQLite files (about 360 KB) with a JSON expectation each. Ids and timestamps are random, so regenerating changes the bytes. | Deterministic generation (seeded ids, fixed clock). That gives reproducible bytes, but needs hooks into the store for ids and time. | inject an id/clock factory |
```

## Contract questions

These are for the owner of `tento-autophys-store` and `architecture.md`. The
SDK's assumption is stated each time. Some were checked against the store
crate's working tree (read only, in progress), and those say so.

1. **GET routes the table omits.** The SDK calls `GET /projects/{pid}/config_versions`,
   `GET /investigations`, `GET /investigations/{id}/records?kind=` (used by
   `verify()`) and `GET /investigations/{id}/proposals/{pid}` (used by the
   poll fallback). The store's router has all four. `architecture.md`'s table
   should list them.
2. **No `gseq` in POST responses.** The store keeps `gseq` out of record
   JSON and returns `{record}`, so the SDK's cursor only advances from stream
   `id:`s. An SDK's first wait therefore subscribes with `after=0` and
   replays the whole workspace log. The proposal is to return `{record, gseq}`.
   The SDK already reads a top-level `gseq`.
3. **SSE framing.** `architecture.md` says only "SSE of records". The SDK
   assumes the store's framing: `id: <gseq>`, `event: record` (or none),
   `data:` the 8-field record, `:` keep-alives. It reconnects after
   `stream_idle` (30 s; the store sends a keep-alive every 15 s). Please write
   the framing into the table.
4. **Stream scope.** The stream is workspace-wide, and the SDK filters by
   investigation and proposal on the client. Should there be an
   `?investigation=` filter, given many concurrent investigations?
5. **Proposal fields beyond E-1.** The SDK also sends `criterion` and `score`
   (E-1d), which the store passes through. Should the daemon refuse an
   `edited` whose settings fall outside the outlook's axes or the config's
   `edit` limits? `architecture.md` is silent, and the SDK does not check it
   either (`Simulator.experiment` validates the shape only).
6. **SDK approvals.** The table lists the UI as the caller of `…/approvals`.
   `Investigation.approve/reject` over `HttpStore` posts there with a key,
   and the store accepts keys. Is that intended?
7. **`withdrawn`.** The state diagram has "SDK withdraw", and the store
   accepts the event. The SDK has no withdraw call yet (remaining work).
8. **Canonical JSON across languages.** `Store.verify()` recomputes
   `sha256(prev_hash + canonical {id, kind, payload})` with Python's
   canonical form: sorted keys, `(",", ":")` separators, NaN and infinity as
   `null`, and Python's float repr (`1e-05`, `1e+16`). The store's
   `canonical.rs` must produce the same bytes or `verify()` fails on real
   logs. This has not been checked; a shared set of test vectors would
   settle it.
9. **`seq` and `ts`.** The SDK numbers an investigation's records from 0
   (`verify()` requires it) and uses `ts` as float epoch seconds. The store
   does both. `architecture.md`'s pseudo-code (`head.seq + 1` from
   `(0, GENESIS)`) would start at 1, and its schema says `ts TEXT`; it
   should say 0 and REAL.
10. **Reaching a loopback daemon from a laptop.** The default server
    assumes the SDK runs on the daemon host. `architecture.md` puts the SDK
    on the user's laptop and the daemon on loopback, reached through
    tento.localhost (AX-5). Which base URL should a laptop SDK use? Does the
    proxy pass `Authorization` through? What should `pair/start`'s
    `verification_url` be?
11. **`whoami` fields.** The SDK prints `account`, `workspace`, `key_id`
    and `device_name`. For a single-user daemon, what are `account` and
    `workspace`?
12. **Payload size.** The store accepts up to 1 MiB inline. A 3-axis
    outlook (13³ = 2,197 cells × (1 + parameters) numbers) is about
    200-400 KB of canonical JSON for up to about 10 parameters. A larger
    model could exceed the limit, so the SDK may need to cap points per axis
    by parameter count.
13. **Reason lane.** `ReasonLanePolicy` still needs hacks-site's
    `/api/inference/reason`. The daemon has no reason route. Is one planned,
    or does the SDK keep a hacks-site URL?

## Validation

On rwc-dev-01 (Python 3.12.3, NumPy 2.5.4, SciPy 1.18.1, venv
`~/.cache/autophys/venv`):
`PYTHONDONTWRITEBYTECODE=1 ~/.cache/autophys/venv/bin/python -m pytest -q`
gives 65 passed, 1 skipped (the opt-in live reason-lane smoke). The 55 tests
from the source all still pass, and 10 are new: 3 for E-1 and 7 for the
`/api/v1` stream, the fallback and the parser. The benchmark (`bench --seeds 5`)
reproduces the source table's statuses, maximum errors and requests:
oscillator-free-only inconclusive 5/5, 1.52 %; oscillator validated 5/5,
0.19 %, sine_0.44Hz; thermal-short-only inconclusive 5/5, 0.45 %; thermal
validated 5/5, 0.04 %, pulse. Simulation counts differ by a few calls
between aarch64 and x86_64. The rename-only tree and the retargeted tree
give identical benchmark rows on the same host.

## Remaining work

- Question 8 is settled: the Python suite checks the shared vectors
  (`tests/vectors/chain.json`), and the Rust crate is to verify
  `tests/conformance/python/` and write `tests/conformance/rust/`.
- Run `HttpStore` and `RemoteClient` against the real daemon (it serves
  `/api/v1` since d82deaa), and settle the open contract questions.
- SDK withdraw (question 7): the store accepts `withdrawn`, but there is no
  `inv.withdraw` yet.
- Phase 2 of autophys-rs (AX-2 revised): numeric golden cases in
  `tests/conformance/numerics/`, format to be drafted in `rust-sdk.md`.
- Retire the yuzuquats original and `~/.cache/modellab/venv`, once the
  operator approves.
