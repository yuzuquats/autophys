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

The operator fixed the shape. The details below were agent-chosen. Operator-reviewed on 2026-11-04; outcomes are in "Operator decisions on the SDK" below. Each is cheap to reverse inside the SDK.

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
Agent-chosen, then confirmed by the operator on 2026-11-04 (SD-1 below). Before: poll the proposal every 5 s.
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

Each was agent-chosen. Operator-reviewed on 2026-11-04; outcomes are in "Operator decisions on the SDK" below. They were made on
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
| R-1 | Where `ReasonLanePolicy`'s model calls go (contract question 13) | Two switchable routes over plain HTTP, both OpenAI chat completions: `meta` (Muse Spark, `https://api.meta.ai/v1`, model `muse-spark-1.3`, the default) and `baseten` (hosted `https://inference.baseten.co/v1` or a dedicated deploy URL). Selected by `AUTOPHYS_REASON_ROUTE`; URL, model and key per route; keys from the environment (`MODEL_API_KEY` for Meta, as Meta's docs use) or a 0600 credentials file, never logged. No hacks-site dependency and no client package: Meta publishes no SDK of its own (dev.meta.ai/docs/sdks) and Rust would do plain HTTP anyway. | Operator, 2026-11-04 ("specific to muse for now", then "switch between plain http and baseten"). Muse reasons before answering: keep `max_tokens` at least 1800, treat 402 `billing_not_configured` as terminal, honour 429 `Retry-After` (hacks-site providers.md). Baseten cannot serve Muse (weights are not public), so that route runs an operator-chosen open model and its decisions are not Muse's. Rust phase 2 mirrors it. | implemented: `ChatReasoner`, `reasoner_from_env` (4009e65); `Retry-After` via `HttpError.retry_after` (2c67e9f) |
| WB-1 | Resume restores the last fit | Keep resume as implemented, and also rebuild the last `FitResult` from the latest `run` record of the adopted model, so the next fit warm-starts as in an uninterrupted run. Sensitivities, rankings and validation stay recomputed. | Operator, 2026-11-04, reversing the agent choice WB-1 below. Resume must equal the uninterrupted run exactly; a test asserts equality; Rust phase 2 mirrors it. | implemented (8bd1316): `FitResult.from_dict`; a fresh-interpreter resume test asserts exact equality |
| ML-8 | Identifiability rule | Confirmed: keep the linearised SVD rule with defaults structural `1e-3`, practical `0.1`, loading `0.2`. Profile likelihood only as a possible later opt-in. | Operator, 2026-11-04. Cheap per step, 5/5 correct on the benchmark, simple to match in Rust. | implemented |
| ML-10 | When an investigation is `validated` | Confirmed: all-or-nothing. Every free parameter identified, a converged fit, and the validation split passing at that fit; otherwise `inconclusive` with reasons. | Operator, 2026-11-04. `validated` never needs a footnote; parameters nobody cares about are marked fixed. | implemented |
| ML-9 | Default experiment ranking | Confirmed: E-optimal (`min_eig`); D-optimal recorded beside it and selectable per call. | Operator, 2026-11-04. It targets the weakest direction, which is what blocks `validated` (ML-10). | implemented |
| E-1a | Who declares editable settings | Confirmed: declared per catalog experiment, `edit: {setting: [lo, hi]}`, numeric, limits contain the value, at most 3; nothing else is editable. | Operator, 2026-11-04. Approved experiments run on real hardware, so bounds come from the engineer. | implemented |
| E-1b | Outlook axis sampling | Confirmed: 12 evenly spaced values over `[lo, hi]`, with the proposed value inserted (12-13 points), so the proposal's own cell is exact. | Operator, 2026-11-04. | implemented |
| E-1c | Meaning of `after` and unresolved parameters | Keep `after` finite (floored at the D-optimal ridge), and add `after_resolved_max` (default 1.0) to the outlook; above it the UI shows "not determined". No `null`s, so the outlook validator and goldens are unchanged. | Operator, 2026-11-04. | implemented (8bd1316) |
| E-1d | `criterion` and `score` on proposals | Confirmed: keep both. | Operator, 2026-11-04. Stored proposals are self-describing if the ranking default changes. | implemented |
| E-1e | Outlook simulations and the budget | Uncharged to `max_simulations` (recorded as `outlook_simulations`), under a new `Budgets.max_outlook_simulations` (default 50,000). Exceeding it, or the 1 MiB payload limit, reduces points per axis instead of failing. Closes Q-12. | Operator, 2026-11-04. An outlook informs the reviewer and must not end an investigation. New budget field: a new config version for projects that set it. | implemented (8bd1316): omitted from the config at its default, so existing config hashes are unchanged; steps record `outlook_points`; a cap below the 2-point grid's cost is refused before simulating |
| E-1f | Outlook before any fit | Keep computing at the initial values (bound midpoints otherwise), and mark the outlook with `at: "initial"` or `"fit"`. | Operator, 2026-11-04. Investigations may start without usable data; the UI says "based on prior guess". | implemented (8bd1316) |
| SD-1 | How a remote SDK waits for an approval | Confirmed: the SSE stream, falling back to 5 s polling. Remote connections only; local workbooks use `data_version` (WB-4). | Operator, 2026-11-04. | implemented |
| WB-2..6 | Workbook details | Keep WB-2 (register on open), WB-3 (open by name is review-only), WB-4 (0.1 s `data_version` checks) and WB-6 (random-id goldens). Change WB-5: the base `Store` enforces the full workbook rules, so `MemoryStore` and `JsonlStore` behave like a workbook. | Operator, 2026-11-04 ("go ahead" on the agent's recommendations). | implemented (8bd1316); `Store.append_batch` commits `attach_data` atomically in every local store (6d0d8fe) |
| Q-6 | SDK approvals with a key | Allowed. SDK approvals and rejections record `by` and `via: "sdk"`, plus the key id on a remote connection. | Operator, 2026-11-04. Browser-only cannot be enforced on local workbooks. | implemented (8bd1316); `key_id` only when known from saved credentials |
| Q-7 | SDK withdraw | Add `inv.withdraw(pid, reason=)`: event `withdrawn`, only from `proposed`; clears the pending proposal. | Operator, 2026-11-04. | implemented (8bd1316); posted to `/proposals` over HTTP |
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
shipped. These details were agent-chosen. Operator-reviewed on 2026-11-04; outcomes are in "Operator decisions on the SDK" below.

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

## Muse first-class (plan, 2026-11-04)

Requested by the operator through autophys/pitch: Muse Spark investigates
(inner loop), Muse Wonder edits a playbook skill (outer loop), batteries
first. What exists already: `ChatReasoner` (meta/baseten routes), steps that
carry the reasoner's `model`, raw `usage` and `elapsed_ms`, and an
investigation record pinning `system_prompt_sha256`. No published number
comes from a Meta model yet, and the system prompt hard-codes the
"request the top-ranked experiment" strategy that ScriptedPolicy also uses.

```review-table
| Id  | What lands | Est. |
| --- | --- | --- |
| M-1 | `ModelSpec(route, model, effort, max_tokens)` per role (`policy`, `researcher`); `reasoner_for(spec)`; known models `muse-spark-1.3`, `muse-wonder-1.0` with token floors and a dated price table. `bench --policy reason --model ID [--effort E]`. | 1.5 h |
| M-2 | Playbook skill: the prompt splits into a fixed contract (JSON shape, action list, the identified-claim rule; not editable) and a strategy loaded from `playbooks/<name>/SKILL.md` in Muse skill format. The default strategy is rewritten to reason about information rather than follow the ranking. Pinned on the investigation as `playbook`. | 2 h |
| M-3 | Usage per step and totals per outcome, normalised across providers, with estimated cost from the price table snapshot pinned on the investigation. | 1 h |
| M-6 | Retry with jittered backoff on 429, 5xx and timeouts (402 stays terminal: it means billing is not configured). `RecordingReasoner` / `ReplayReasoner` cassettes keyed by the sha256 of the canonical request; replay is the offline demo and the deterministic tests. | 1.5 h |
| M-7 | `bench --jobs N`: cases × seeds × policies in a bounded pool (threads for model-bound runs, processes for scripted ones). | implemented (Python batch 2; offline tests) |
| M-9 | Outer loop `autophys research`: frozen train / held-out split, scalar score (diagnosis and status correct first, then error, cost as tiebreak), propose an edit, re-evaluate on train, keep only on improvement, report held-out. Researcher protocol with an API adapter (`ChatReasoner` on Wonder). | implemented (Python batch 2; offline tests) |
| M-5 | Muse Code CLI researcher adapter: workspace with the skill and failed transcripts, prompt file, `muse exec --json --model muse-wonder-1.0 --workspace DIR`, JSONL events parsed, edited SKILL.md read back and validated. Tested with a fake `muse`. | implemented (Python batch 2; offline tests) |
| M-8 | `autophys export-trajectories`: JSONL of each decision's contract hash, playbook hash, prompt, raw response, parsed decision, validity and the run's evaluator score. Export only. | implemented (Python batch 2; offline tests) |
| M-4 | Image input: fit and residual plots rendered (optional `plots` extra), stored as blobs, referenced by hash; attached for Wonder (researcher) and for the policy only if the model is image-capable. The hacks reason lane stays text-only. | 2.5 h |
```

Order: M-1, M-2, M-3, M-6 first (they unblock a first Spark number),
then M-7, M-9, M-5, M-8, then M-4. Estimates are agent time.

Deferred: live Spark/Wonder runs and the live `muse` path until the operator
approves a token budget (estimate below); fine-tuning; the Rust mirror
(autophys/rs, from `workbook-format.md`).

Rough cost per live run, to be replaced by measured usage from M-3: about 24
decisions × ~3k input / ~1.5k output tokens is ~$0.25 per investigation on
Spark 1.3, so ~$5 for a 4-case × 5-seed bench. One Wonder iteration (~200k in,
~20k out) is ~$1.2 plus a train re-evaluation; ten iterations ≈ $60.

Record fields, agreed with autophys/rs on 2026-11-04. All are optional
and additive in format v1, and both validators accept them before either SDK
writes them:

- reasoner API: `complete(..., images=[{media_type, data}])` (base64 data,
  sent as `image_url` data URIs); constants `MUSE_SPARK = "muse-spark-1.3"`,
  `MUSE_WONDER = "muse-wonder-1.0"`. Retries 429/5xx with backoff and
  Retry-After; 402 fails fast as a budget error.
- replay: `AUTOPHYS_REASON_RECORD=<file>` / `AUTOPHYS_REASON_REPLAY=<file>`;
  JSONL `{key, reply: {content, model, usage, route, elapsed_ms}}`, key =
  sha256 of the canonical request body without auth; shared cassettes in
  `tests/conformance/reasoner/`.
- investigation: `playbook {name, version, sha256}` (sha256 of the SKILL.md
  bytes, stored as a blob); `model {role, route, model, effort, max_tokens}`;
  `price {model, input_per_mtok, output_per_mtok, as_of}`. The shared price
  table is `tests/conformance/reasoner/prices.json`; each SDK embeds a copy
  checked against it. `system_prompt_sha256` stays.
- step: `usage {route, model, input_tokens, output_tokens, total_tokens,
  reasoning_tokens?, cached_input_tokens?, latency_ms, cost_usd}`, with
  `cost_usd` null for an unknown model. The key used to hold the raw
  provider dict, so validators type-check known keys when present and older
  records stay valid. `images [{sha256, media_type, caption}]` (bytes in
  `blobs`, never inline); `replayed: true` for cassette replies.
- outcome: `usage_total {calls, input_tokens, output_tokens, cost_usd}`.
- blobs over HTTP (agreed with autophys/rs 2026-11-04; daemon a70b0ec):
  `PUT /api/v1/projects/{pid}/blobs/{sha256}` with a bare lowercase 64-hex
  path, the raw body and a required `Content-Type` (its media type), at
  most 16 MiB (413). The server hashes the body: 422 `hash_mismatch` on a
  mismatch, 422 with path `Content-Type` when it is missing; 201 on create,
  200 when the same bytes exist. `GET` on the path returns the bytes with
  the stored media type, or 404. Clients PUT every blob before the record
  that references it. `HttpStore.put_blob`/`get_blob` implement it; every
  local store has the same pair.
- projections: unchanged in v1 (they are fixed SQL columns). Read APIs derive
  `playbook` from the seq-0 record and `usage_total` from the outcome.

Settled: the skill frontmatter (MQ-3, `muse skills validate` on 1.4.14) and the `muse exec --json`
event envelope (MQ-7, echo run). The CLI researcher runs where `muse` and its key are; it is not on rwc-dev-01.

Implemented: M-1, M-2, M-3 and M-6 (I7d2e5a9c3f1b84e06a51). The offline replay
of `bench --policy reason --model muse-spark-1.3 --case oscillator --seeds 1`
uses the shared cassette: 8 calls, 800 input and 320 output tokens, $0.002360.
That replay is a recorded fixture, not a Muse run. Next: M-7, M-9, M-5, M-8,
then M-4.

### Operator decisions on Muse (open-questions, 2026-11-04)

```review-table
| Id  | Question | Decision | Reason and constraints | Implementation |
| --- | -------- | -------- | ---------------------- | -------------- |
| MQ-1 | Can the MCP server approve, edit or reject proposals? | No. Approval stays out of MCP; Muse Code sessions may propose and attach data only. | Operator, 2026-11-04. Approved experiments run on real hardware, so approval stays with a person in the UI (or the SDK under Q-6). | MCP agent to be told; nothing to change in sdks/python |
| MQ-2 | Live Spark/Wonder token budget | Replay-only for now. No live Meta API or `muse exec` calls; the budget question is deferred. | Operator, 2026-11-04. No number or transcript may be labelled Spark or Wonder until a live run happens under an approved budget. | enforced: `bench --policy reason` refuses live calls without `--replay` or `AUTOPHYS_ALLOW_LIVE_REASON=1` |
| MQ-3 | Probe the `muse` CLI on the laptop | Allowed, once, over ssh on macbookpro-laptop: `muse --version`, `muse exec --help`, `muse skills --help`, and `muse skills validate` on a temporary copy of our SKILL.md. | Operator, 2026-11-04. No installs, settings changes or real `muse exec`; stop if validate needs the network or the account. | SKILL.md format settled: the MCP agent ran the probe and recorded it in muse-plugin.md. `skills validate` on Muse Code 1.4.14 is valid with no diagnostics for sha256 `cd65c7b3...e0e35a`, which is the committed `playbooks/default/SKILL.md`, so the probe is not repeated. Still open for M-5: the `muse exec --json` event schema from a real model. The echo provider (`--provider echo`, zero tokens) could capture it, but an echo `muse exec` is outside MQ-3's authorization, so M-5 starts against a fake `muse` built from `exec --help`. |
| MQ-4 | Research-loop score (M-9) | Lexicographic: the count of correct status-and-diagnosis results first, then lower mean log parameter error, then lower cost as the tiebreak. Every component is logged so runs can be re-scored. | Operator, 2026-11-04. | to implement in M-9 |
| MQ-5 | Who owns the battery case suite | autophys/py owns all of it: R0/R1/C1 cases, an experiment catalog costed in test hours, a short-data non-identifiable case, goldens and the experiment-cost budget in bench. | Operator, 2026-11-04. sdks/python keeps a single writer; a test-hour budget field is a new config version that autophys/rs mirrors. About 3-4 h agent time, after batch 2 and before M-4. | planned |
| MQ-6 | 402 handling | Stop on the first 402 everywhere: no retry; the investigation records the step, ends `failed` with reason `billing: provider refused the call (HTTP 402)` and raises `BudgetError`; bench (including `--jobs` pools) and research stop the whole run. | Operator, 2026-11-04, choosing the recommendation over keeping the earlier behaviour, which made three 402 calls per investigation, reported "three unusable decisions in a row" and continued through every batch unit. Meta documents 402 as billing_not_configured, so waiting does not help. | implemented (batch 2 commit) |
| MQ-7 | One zero-token `muse exec` echo run to learn the event format | Allowed once. Run on macbookpro-laptop with isolated XDG dirs, `--provider echo --json --no-session-log`, shell/writes/web off; output kept as `sdks/python/tests/data/muse-exec-echo-1.4.14.jsonl`, temp dirs removed. | Operator, 2026-11-04. Exit 0, 14 events, zero tokens, SKILL.md unchanged (sha256 cd65c7b3...). Events are `{schema_version: 1, payload_type, payload}`; final text in `run.terminal.completed` payload.text, streamed text in `run.output.delta`, usage in `run.usage` payload.models[] (`input_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens`, `calls`). Real-model usage values remain unverified until a live run. | implemented: `parse_muse_events` reads this envelope; a non-completed terminal is an error |
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
`~/.cache/autophys/venv`), 2026-11-04 after the review fixes:

- `PYTHONDONTWRITEBYTECODE=1 ~/.cache/autophys/venv/bin/python -m pytest -q`:
  471 passed, 6 skipped (the opt-in real-daemon tests and the live
  reason-lane smoke).
- With `AUTOPHYS_RUST_BIN` set to a daemon built from current master: 476
  passed, 1 skipped (the live smoke). A deployed bundle carries its web app;
  a bare `cargo build` binary also needs `AUTOPHYS_RUST_WEB_ROOT` (a built
  web tree), or the daemon exits at startup and the cross-writer tests error. This covers cross-writer appends, blob
  routes, approval waits across keep-alives and a daemon restart.
- `bench --seeds 5`: oscillator-free-only inconclusive, 308 simulations, RMSE
  0.1939; oscillator validated, 644; thermal-short-only inconclusive, 133;
  thermal validated, 336. Diagnosis is correct in every run. `--jobs 1` and
  `--jobs 4` give identical rows except wall time.
- Offline replay of `tests/conformance/reasoner/spark-oscillator.jsonl`: 8
  calls, 800 input and 320 output tokens, $0.002360. It is a recorded
  fixture, not a Muse run; no live model call has been made (MQ-2).
- Two independent Opus reviews of this range found 20 defects, and a
  Python↔Rust alignment check found 10 divergences. All 20 defects and the
  material divergences are fixed (Python in this project, Rust in 0b03671 and a70b0ec).
  Still open: image input in Python (M-4); the step `error` text is
  formatted differently in the two SDKs (free text, not validated);
  `HttpStore.create_investigation` sends a random Idempotency-Key, so a
  retried create is not idempotent; and the fold of a stored
  `overrides: null`, which no writer produces. Each SDK verifies the
  other's goldens and the 21 numerics cases.

## Remaining work

- Battery case suite (MQ-5, owned here): cases, an experiment catalog costed
  in test hours, a short-data case, goldens and the experiment-cost budget.
- M-4 image input (the Rust reasoner already accepts `images`).
- First live Spark/Wonder runs, once the operator approves a token budget
  (MQ-2); until then no result may be labelled Muse.
- Muse Code to MCP dispatch is still unverified (the echo provider does not
  start MCP servers).
- Retire the yuzuquats original and `~/.cache/modellab/venv` once the
  operator agrees.
