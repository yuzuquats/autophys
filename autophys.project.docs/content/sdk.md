# The Python SDK: moved from hacks-site, renamed autophys, speaking /api/v1

Status: SDK page, rev 1, 2026-11-04. It covers the SDK half of phase 5 in
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

- Run the SDK against the real daemon once `/api/v1` is served, and settle
  questions 1-13.
- SDK withdraw (question 7). Resume an investigation from its records in a
  new process (architecture D2).
- Retire the yuzuquats original and `~/.cache/modellab/venv`, once the
  operator approves.
