# The Python SDK: moved from hacks-site, renamed autophys, speaking /api/v1

Status: SDK page, rev 2, 2026-11-04. MQ-5 battery cases and test-hour budgets are implemented in both SDKs; the Rust landing is independently reviewed. Python and Rust now share format-1 Display declarations and canonical bench manifest bytes; see [display-manifest.md](display-manifest.md) for the contract and scoped validation. Owner: autophys/api (thread 755eea02). It covers the SDK half of phase 5 in
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
| M-4 | Image input: fit and residual plots rendered, stored as blobs, referenced by hash; attached for Wonder (researcher) and for the policy only if the model is image-capable. The hacks reason lane stays text-only. | implemented (I5b9e2d7c0a4f18e3b6d2; see "M-4 image input") |
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
| MQ-5 | Who owns the battery case suite | autophys/py owns all of it: R0/R1/C1 cases, an experiment catalog costed in test hours, a short-data non-identifiable case, goldens and the experiment-cost budget in bench. | Operator, 2026-11-04. sdks/python keeps a single writer; a test-hour budget field is a new config version that autophys/rs mirrors. About 3-4 h agent time, after batch 2 and before M-4. | implemented in Python (7e20524) and Rust (f5ad648); reviewed, with null-cost validation fixed in 11f2787 |
| MQ-6 | 402 handling | Stop on the first 402 everywhere: no retry; the investigation records the step, ends `failed` with reason `billing: provider refused the call (HTTP 402)` and raises `BudgetError`; bench (including `--jobs` pools) and research stop the whole run. | Operator, 2026-11-04, choosing the recommendation over keeping the earlier behaviour, which made three 402 calls per investigation, reported "three unusable decisions in a row" and continued through every batch unit. Meta documents 402 as billing_not_configured, so waiting does not help. | implemented (batch 2 commit) |
| MQ-7 | One zero-token `muse exec` echo run to learn the event format | Allowed once. Run on macbookpro-laptop with isolated XDG dirs, `--provider echo --json --no-session-log`, shell/writes/web off; output kept as `sdks/python/tests/data/muse-exec-echo-1.4.14.jsonl`, temp dirs removed. | Operator, 2026-11-04. Exit 0, 14 events, zero tokens, SKILL.md unchanged (sha256 cd65c7b3...). Events are `{schema_version: 1, payload_type, payload}`; final text in `run.terminal.completed` payload.text, streamed text in `run.output.delta`, usage in `run.usage` payload.models[] (`input_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens`, `calls`). Real-model usage values remain unverified until a live run. | implemented: `parse_muse_events` reads this envelope; a non-completed terminal is an error |
| MQ-8 | Billing for the first live Muse run | The Muse coding plan, through the `muse exec` / Muse Code adapter; not metered API tokens. | Operator, 2026-11-04, relayed from the progress-review thread. MQ-6 still applies: stop at the first 402 or quota error. If the coding plan cannot reach the reasoning path the run needs (for example, MCP tools not starting under `muse exec`), ask the operator before any fallback to metered tokens; never fall back unasked. Supersedes MQ-2's replay-only rule for this run only. | done 2026-11-04: see "First live Muse smoke" |
| MQ-9 | Size of the first live run | Small: one case, one seed and a short step limit. It is a smoke test of the real reasoning path and the MCP tools, not a benchmark, and its numbers are not reported as Muse results. | Operator, 2026-11-04. | done 2026-11-04, with MQ-8 |
```

## Battery case suite (MQ-5, plan 2026-11-04)

The operator assigned the battery suite to autophys/py (MQ-5). The battery
model (`models/battery.py`: first-order Thevenin, R0, R1, C1) already existed
but had no benchmark case. Truth is R0 = 0.025 ohm, R1 = 0.045 ohm,
C1 = 1600 F (tau = 72 s). These choices are **agent-chosen, pending operator
review**; each is cheap to change until the Rust SDK mirrors it.

```review-table
| Id | Choice | Strongest alternative and tradeoff | Reverse |
| --- | --- | --- | --- |
| BT-1 | Two cases shaped like the thermal ones. `battery-short-only` starts from one short current pulse: R0 shows as the instant drop and C1 as the initial slope, but R1 needs the RC relaxation and is not identified, so the expected result is inconclusive with that diagnosis. `battery` starts from the same pulse and may request two experiments, and is expected to validate. | A single case with a larger budget. It is simpler, but it would not test the non-identifiability diagnosis on batteries. | edit `synthetic.py` and its tests |
| BT-2 | Catalog experiments may carry `cost_hours`: the test duration plus a fixed 1 h rest, since a cell must relax before a test. A new `Budgets.max_test_hours` (default unset) caps the total. Unset, it is omitted from the config, so every existing config hash is unchanged (as with `max_outlook_simulations`). | Charge cost through `max_experiments` only. That needs no new field, but it treats a 5 min pulse and a 10 h discharge alike. | drop the field (a new config version for projects that set it) |
| BT-3 | Ranking reports `cost_hours` only when the catalog defines costs, and leaves out unaffordable candidates. `request_experiment` refuses an experiment that would exceed the budget. | Rank by information per test hour. It favours cheap experiments, but it changes the default criterion (ML-9) for costed catalogs. | one filter in the ranking |
| BT-4 | No new record fields. Test hours used are recomputed from the experiments run, as resume already rebuilds experiment counts. Bench rows gain a `test_hours` column. | Record `test_hours` on outcomes. Readers would not need the catalog, but it is a format change both SDKs must validate. | add the field later as optional |
```

Implemented (I1f9b4d7e2c6a08e3b5d4). The short case is a 6 s, 2 A pulse
over 25 s at 32 Hz with 2 mV noise. `bench --seeds 5`, scripted and
fake-reasoner:

| Case | Status | Sims | Test RMSE | Diagnosis | Test hours |
| --- | --- | --- | --- | --- | --- |
| battery-short-only | inconclusive (R1) | 204 | 0.004077 V | 10/10 | 0 |
| battery | validated | 481 | 0.002067 V | 10/10 | 1.17 of 3 |

Depending on the seed, `battery` requests `discharge_1A` or `pulse_2A`. The
four existing cases, configs and goldens are unchanged. The numerics set
gains battery `analyze-short`, `rank-short` and `run-scripted`. There is no
battery `run-policy` case, because the case format has no catalog costs yet.

The Rust SDK landed in `f5ad648` (`I80eae9dd2c2e790f9b2c`) and mirrors:
- `Budgets.max_test_hours`, omitted from the config when unset;
- catalog `cost_hours` (finite and nonnegative; absent means 0);
- hours recomputed from measurements and `data_attached` links;
- unaffordable candidates excluded with a 1e-12 tolerance, and over-budget
  requests refused;
- costs in rankings and hours in facts only for costed catalogs;
- the three new numerics cases.

Independent Codex review fixed explicit JSON `cost_hours: null` acceptance in
`11f2787` (`I408586676b4150a403e6`); Python rejects that declared value.
The null-cost regression fails before the fix and all 12 Rust battery tests
pass afterward. The review checkpoint passes 93 Rust SDK tests (0 failed)
and 590 Python tests (6 skipped), including concurrent committed work; the
original battery implementation gate was 142 Rust workspace tests (2 ignored)
and 510 Python tests (6 skipped). The final commit is checked again from a
clean archive; see [the Rust landing](rust-sdk.md#battery-case-suite-mq-5-rust-landing-2026-11-04)
for scope, reference commits and the validation receipt location.

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
   accepts the event. The SDK call is `inv.withdraw` (Q-7, 8bd1316).
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
  Still open: the step `error` text is formatted differently in the two
  SDKs (free text, not validated; see "M-4 image input"); and the fold of a stored
  `overrides: null`, which no writer produces. Each SDK verifies the
  other's goldens and the 21 numerics cases.

## Publication

2026-11-04: the review fixes and this record were published to origin master
(github.com/yuzuquats/autophys) as 6038f8f (I9c4e1b7a3f6d20e85b47) and
5ca4c51 (I2d7b5f0e8a3c61b49e06), on base 63606eb. The pushed range had three
independent pre-push review rounds (Opus subagents, agent review only):
changes required, then ready, then ready. The receipt is
`~/.local/state/autophys/publication-receipts/py-sink-20261104-review.md` on
rwc-dev-01.

2026-11-04, later: the "How the loops nest" section, the landing docs and
their nested-loop figure were published as 5ca4c51..85ae558 (21 commits).
The range is this record's loop-section commits, the figure commits and,
as minimal prerequisites, the landing-docs and cookbook vendor commits
the figure needs. The deck slides (I533fa9fe7f673a4640ee,
I5d1e7b3a9c2f4068e4b7) and the battery, display and live-run drafts stayed
local. Two independent pre-push review rounds (Codex, agent review only):
changes required, then ready. The receipt is
`~/.local/state/autophys/publication-receipts/loops-docs-sink-20261104-review.md`
on rwc-dev-01.

## Remaining work

- First live Spark/Wonder runs, once the operator approves a token budget
  (MQ-2); until then no result may be labelled Muse.
- The plugin builder emits `["sh", "mcp-stdio.sh"]`, which Muse cannot
  start (see "First live Muse smoke"); the MCP integration's owner fixes
  `plugins/muse-autophys/build.py`.
- Retire the yuzuquats original and `~/.cache/modellab/venv` once the
  operator agrees.

## M-4 image input (Python), 2026-11-04

- **Opt-in only:** `ModelSpec(images=True)`, `bench --images`,
  `research --images` (policy) and `--researcher-images`. Without it every
  request is byte-identical to before, so cassettes and hashes are
  unchanged. Opting in asserts that the model accepts images: whether Muse
  Spark and Wonder do is not verified. Known text-only models and the
  `lane` route never receive images. The investigation's `model` field
  carries `images: true` only when opted in; Rust's validator must accept
  that key.
- **Plots:** after each adopted fit, one PNG per measurement and output
  channel, combining the fit (measured dots, fitted curve, dashed initial
  guess, from the run's `curves`) and the normalized residuals with a ±1
  band. `plots.py` renders them with numpy and zlib only: 640×400 indexed
  colour, filter 0, zlib level 9, deterministic bytes (2.4–5.0 KB on the
  benches). Each PNG is a blob written before the step that references it
  in `images [{sha256, media_type, caption}]`. Rendering costs no
  simulations and adds no facts text. Rust has to accept and store these
  images, but it doesn't have to produce identical bytes.
- **Requests:** images are `image_url` data-URI parts on the last user
  message, encoded exactly as `sdks/rust/src/reasoner/cassette.rs`, so the
  cassette keys agree. Both researcher adapters receive the plots.
- **Create idempotency:** `HttpStore.create_investigation(meta,
  idempotency_key=...)` reuses one key across retries of one logical
  create. Without a key, each call creates a new investigation, as in the
  daemon and Rust.
- **Step `error` text (left as is):** Python prefixes an unusable decision
  with the exception class (`ReasonerError: `, `DecisionError: `); Rust
  writes the bare message. It is free text and not validated, so neither
  SDK changes it.
- **Validation:** 603 passed, 6 skipped on a clean export of the commit.
  The bench is unchanged (308/644/133/336/204/481, 60/60 diagnoses) and
  identical at 1 and 4 jobs. The replay still costs $0.002360. The 46
  existing conformance files are unchanged.

## First real-data investigation: Onori lab M50T HPPC, 2026-11-04

Relayed as the operator's choice (autophys/master): the Stanford Onori lab
datasets, starting with Pozzato, Allam and Onori 2022.

- **Data:** Pozzato, Allam, Onori, "Lithium-ion battery aging dataset based
  on electric vehicle real-driving profiles", Data in Brief 41 (2022)
  107995, OSF `qsabn`. The license is CC BY 4.0 (the OSF node license; the
  lab page states none). The diagnostics include HPPC tests, so Catenaro &
  Onori 2021 was not needed.
- **What was downloaded:** one cell, V5: a Samsung INR21700-M50T (NMC,
  4.85 Ah) at 23 °C, first diagnostic, logged by an Arbin cycler at 1 s. It
  is kept with its source, hashes and scripts in
  `~/.local/state/autophys/evidence/onori-pozzato-2022/` on rwc-dev-01
  (`SOURCE.md`, `SHA256SUMS`), never in git.
- **Model:** a user project, `m50t_hppc`. It has R0 plus one R1‖C1 branch,
  solved exactly for piecewise-constant current, with the OCV and its slope
  known from the rest before each window. There are nine catalog windows,
  one per 10% of state of charge. Each covers the rest sample, a 10 s
  2.66 A discharge pulse, a 40 s rest, a 10 s 2.0 A charge pulse and a 40 s
  rest (105 samples). σ is the declared 1 mV voltage accuracy of the
  Arbin.
- **Path:** the MCP session's tools, the same ones Muse drives:
  `import_measurements` (train at 50% SOC, validation at 60%), `fit` (8
  starts), `identifiability`, `rank_experiments` and `report`. These ran
  against `/home/james/autophys`.
- **Result:** investigation `inv_239c73b12dfce244` in
  `m50t_hppc.ap-workbook` is **validated**:
  - R0 = 27.2 mΩ, R1 = 22.3 mΩ, C1 = 2,759 F (τ ≈ 62 s);
  - train χ²/N 1.05;
  - held-out window at 60% SOC: χ²/N 1.45, RMSE 1.2 mV;
  - all three parameters identified (condition number 13.7).

  The daemon serves the project, its records and both measurements'
  curves. In the live app the project appeared in the project list. I
  captured no screenshot of the investigation's views before a later
  daemon deploy put `/app` behind an email and password sign-in.

### Ingest findings (gaps in the measured-data path)

1. **The CSV grid must equal the declared grid.** A file must start at
   t = 0 and match `time_grid(settings)` to 1e-9. Real cycler logs jitter
   (here, 1.0006 s steps), so the only route is to put each measurement's
   own times in its catalog settings. Each measurement then becomes its own
   catalog experiment, and the catalog (and config version) grows with the
   data.
2. **Measured inputs can't be imported.** For a user project, `read_csv`
   maps only `t` and the output channels. The measured current has to be
   restated as a schedule in settings. The built-in battery path reads
   current only to check it against a synthetic waveform.
3. **`battery_ecm` can't describe a real cell.** Its OCV table (generic
   2.5 Ah NMC), capacity and three waveforms are fixed, so a real cell
   needs a user simulator.
4. **Every experiment needs a `kind`,** even a measured window with no
   generator.
5. **Size limits:** 1 MiB and 10,000 rows per CSV. The full HPPC (55,257
   rows) has to be windowed by hand.
6. **No vendor formats or conventions:** no reader for Arbin `.xlsx` (and
   no openpyxl or pandas in the environment), and no way to declare a sign
   convention. Arbin's negative-is-discharge current was flipped by hand.
7. **No display manifest for local workbooks:** the project shows
   `display: null`, so the UI has no labels or units for it.
8. **UI confirmation on rwc-dev-01:** the cached
   `chrome-headless-shell` is an x86-64 build on this ARM64 host. Only
   Playwright's Chromium with `--no-sandbox` runs. `/app` now requires a
   sign-in that agents have no account for.

## First live Muse smoke (MQ-8, MQ-9), 2026-11-04

A smoke test of the real reasoning path and the MCP tools, not a benchmark.
Its numbers are not Muse results (MQ-9).

- **Where and how billed:** `muse exec` 1.4.14 on rwc-dev-01, logged in by
  OAuth device code on the Muse Code Power Usage plan. The model was
  `muse-wonder-1.0`, Muse Code's default. No metered tokens were used and no
  quota or 402 error occurred; the 5-hour window went from 4% to 6%.
- **Setup:** an isolated Muse plugin store with a local stdio bundle that
  runs a clean export of 3c71f29. Shell, file writes, web tools and approval
  prompts were disabled, with at most 16 model steps. The synthetic
  `pulse_2A` CSV came from R0=0.025, R1=0.045, C1=1600.
- **First run:** Muse loaded the plugin's skill, but the autophys MCP server
  was "skipped during startup: the transport closed unexpectedly", and
  `describe_project` was an unknown tool. Muse starts stdio servers in the
  workspace directory, so the builder's `["sh", "mcp-stdio.sh"]` cannot
  find its script. `${PLUGIN_ROOT}` is refused for native plugins.
  `["./mcp-stdio.sh"]` (executable) validates and starts.
- **Third run, with that command:** Muse called `describe_project`,
  `import_measurements` (601 samples, train), `fit` (converged at the true
  values), `identifiability` (all three identified), `rank_experiments`
  (`pulse_train` first by min_eig) and `propose_experiment`, then stopped
  without approving. It used 8 model calls: 215,934 input tokens (187,436
  cached), 891 output and 134 reasoning.
- **Result:** investigation `inv_2652c5ab86b662d0`, proposal
  `prop_280a77c38538` (`pulse_train`, proposed), in
  `/home/james/autophys/battery_ecm.ap-workbook`, with 4 valid steps.
- **Evidence:** the event streams, launch log, MCP stderr and both
  manifests are in `~/.local/state/autophys/evidence/muse-smoke-20261104/`
  on rwc-dev-01 (SHA256SUMS).

## Flaky-test search (Python), 2026-11-04

The operator asked for the suspected flaky Python test to be found and fixed.
No record names the test or a failing run, so the search tried to reproduce one
on frozen `git archive` exports of master, run from the venv with no bytecode
or pytest cache. Every run passed.

| Pass | Revision | Runs | Result |
| --- | --- | --- | --- |
| Full suite, serial | 717980d | 10 | 606 passed, 6 skipped each |
| Cross-writer tests against the installed daemon (`106c35c-20261104`) | 2814d07 | 20 | 5 passed each |
| 4 full suites at once (cross-writer included), twice | 2814d07 | 8 | 617 passed, 1 skipped each |
| Shuffled order (seeds 1, 2, 3) and reversed order | 36ed4d5 | 4 | 625 passed, 1 skipped each |

So no fix was made: without a failure there is no root cause, and the operator
ruled out retries and skips. The windows most likely to fail under heavier load
are kept in [improvements.md](improvements.md) item 13:
`test_review_regressions.py:279` (`1.1 <= elapsed < 2`), the cross-writer
`test_B1_real_daemon_wait_deadline` (`2.9 <= elapsed < 4`) and the 0.2 s Muse
timeout in `test_research.py:159`. Under 4x load none of them failed. If a
failure is seen, keep its pytest output and reopen item 12 with it. Logs:
`~/.local/state/autophys/evidence/flaky-20261104/` on rwc-dev-01.

## How the loops nest (research and investigation)

Added 2026-11-04 at the operator's request, to show how `autophys research`
(M-9) relates to one investigation. It describes the code as of 2026-11-04;
the last diagram and table mark proposals that are not built.

The two loops do not run side by side. The outer loop **calls** the inner
one: research scores a playbook by running complete investigations, one per
case and seed, and waits for all of them before it decides whether to keep
an edit (`research.py`, `research()`).

```review-flow
flowchart TB
  subgraph OUTER["outer: autophys research (research.py)"]
    B["baseline: evaluate playbook-000<br/>on train seeds"] --> INC["incumbent playbook<br/>and its training report"]
    INC --> LIM{"iterations left?"}
    LIM -->|yes| RS["researcher proposes an edit<br/>from incumbent + training report<br/>API or muse exec"]
    RS --> VAL{"validate_edit passes?"}
    VAL -->|no: logged, iteration used| LIM
    VAL -->|yes| EV["evaluate candidate on train seeds<br/>cases x seeds investigations, pool of --jobs"]
    EV --> IMP{"improves, MQ-4?<br/>correct, then mean log error, then cost"}
    IMP -->|yes: candidate becomes incumbent| INC
    IMP -->|no: incumbent kept| LIM
  end
  LIM -->|no| HO["held-out seeds: evaluate initial<br/>and final playbook (both always run)<br/>summary.json"]
```

Each "evaluate" box is a batch of independent investigations, each one the
inner loop below. The inner loop is not a fixed cycle: at each step the
policy picks one action from the fixed contract
(`sdks/rust/src/agent/actions.json`) until it stops or a budget runs out.
The order is policy-dependent. The diagram shows the actions and the
scripted policy's typical order (`agent.py`, `ScriptedPolicy._choose`):
fit first, compare the base and sensor-bias variants when the misfit is high (which refits and adopts
the winner), then sensitivity, ranking and requests. `inspect_data` is
available but optional; the scripted policy does not use it.

```review-flow
flowchart LR
  I["inspect_data<br/>(optional)"] -.-> F
  F["optimize_parameters"] --> M["compare_models<br/>BIC over the base and sensor-bias<br/>variants the noise config enables,<br/>then fits and adopts the winner"]
  M --> S
  F --> S["analyze_sensitivity<br/>log-Jacobian SVD"] --> R["rank_experiments<br/>Fisher, min_eig or d_opt"]
  R --> Q["request_experiment<br/>budget-checked"]
  Q -->|new train data| F
  S --> V["validate_predictions"] --> X["stop<br/>guardrail checks the claim"]
  X --> O["outcome recorded in the configured store<br/>(research writes .ap-workbook files)"]
```

Where the loops run:

```review-table
| Mode | Loops | Where decisions and new data come from |
| ---- | ----- | -------------------------------------- |
| research (offline) | outer, calling many inner investigations | the policy decides; data comes from the synthetic case's hidden truth (`synthetic.CASES`), with no person in the loop. Reasoner calls are replay-only until a budget is approved (MQ-2). |
| bench | inner investigations across the selected policies, cases and seeds; no playbook optimization | the same synthetic truth; scripted and fake-reasoner policies by default, in a `MemoryStore` unless a store or workbook is given |
| lab (Muse Code / MCP) | an investigation workflow that Muse drives through individual MCP tools; `MCPPolicy` never decides (`mcp/session.py`) | the bundled canonical playbook, or a research result passed explicitly with `build.py --playbook`. A person approves the proposal in the browser and runs it on hardware (MQ-1), then `attach_data`. The MCP tool surface differs from the action contract (no `compare_models`); see [muse-plugin.md](muse-plugin.md). Live Muse runs follow MQ-2 and any later operator ruling that relaxes it for a specific run. |
```

Cost follows from the nesting. With the defaults (every case in
`synthetic.CASES`, train seeds 0-2, held-out seeds 3-4), a run that
completes needs three investigations per case for the baseline and for
each valid proposal, and four per case on the held-out seeds (two seeds,
initial and final playbook), even when the two playbooks are the same. An invalid proposal
uses an iteration but no training evaluation. Under a reasoner policy, evaluation typically accounts for many more model
calls than proposing an edit; the dollar cost depends on the models chosen
for each role, token volumes (the researcher reads failing transcripts) and
replay use.

### Offline end-to-end check: a planted fix (2026-11-04)

Offline, a playbook edit used to change nothing, because the scripted policy and
the fake reasoner both ignored SKILL.md. So the research loop had only been tested
with test doubles and had never been seen to improve a playbook. This check closes
that gap without a model or network.

- **Planted case.** `battery-biased` (`synthetic.PLANTED_CASES`) is the battery
  case with a voltage sensor that reads 10 mV high. Comparing the sensor-bias
  variant when the fit is poor validates it (max parameter error under 1%).
  Never comparing ends inconclusive (about 250%). Without the offset both
  strategies validate. Planted cases are kept out of `CASES`, so the benchmark
  suite and its Rust mirror are unchanged.
- **Playbook-sensitive fake reasoner.** It reads typed settings from the
  playbook text, as lines such as `- compare_variants: never` or
  `- experiments: none` (`bench.STRATEGY_SETTINGS`). The defaults reproduce the
  scripted baseline, so existing benchmark rows are unchanged. A real model
  reads the prose instead.
- **Scripted researcher.** `autophys research --researcher scripted --edit
  A.md --edit B.md` proposes the given SKILL.md files in order, one per iteration,
  and then has nothing further to propose, which ends the run early.
- **The test** (`tests/test_research_planted.py`, about 2.5 minutes). It starts
  from a playbook that never compares, on `battery-biased` and `battery` with
  train seeds 0-1 and held-out seeds 2-3. It proposes the fix, then the fix plus
  `experiments: none`. The loop keeps the fix, so training goes from 2/4 to 4/4
  correct. It rejects the regression, and held-out goes from 2/4 to 4/4. The
  same run passes through the CLI.

What it proves is the outer loop's mechanics with a strategy that really changes
behaviour. It does not show that a model proposes good edits or follows them;
that needs a recorded or live run with real models (MQ-2).

### The autoloop (implemented 2026-11-04)

`autophys autoloop` (`autoloop.py`) runs the research loop unattended until a
stop condition. Each iteration asks the researcher for one playbook edit, scores
it on the training seeds, and keeps it only if it beats the incumbent
(`research.improves`). Held-out seeds are scored once, at the end, and are never
shown to the researcher.

- **Journal (AR-1).** `journal.jsonl` has one entry per iteration. Each records
  the hypothesis and prediction (when the researcher states them), the unified
  diff, the training score before and after, whether the edit was kept and why,
  and the researcher's usage. The last 20 entries are passed to the next
  proposal. The API and Muse researchers add them to their prompt only when
  there are any, so existing cassettes keep their keys.
- **Stop conditions and resume (AR-6).** It stops on `--max-iterations`, on
  `--patience` rejections in a row, on `--max-usd` (researcher plus policy
  spend), on `--max-wall-s`, when a `STOP` file appears in the run directory, or
  when the researcher has no further proposal. `state.json`, the numbered
  playbooks and the training reports make `--resume` continue a run without
  re-scoring its baseline. State is saved before the baseline and after each
  iteration. On resume, a partial evaluation directory is moved aside as
  `NNN.interrupted-<time>` and redone, and journal lines that `state.json` never
  recorded go to `journal.orphaned.jsonl` and their iteration is redone. A
  `reason` run keeps its policy model (`model_spec`): resume refuses a different
  one, and refuses runs that do not record one. Every charge is appended to
  `spend.jsonl` when it is incurred and resume recomputes spend from it, so a
  crash loses no spend. `--max-usd` is checked before each proposal, so one
  iteration's researcher call and candidate evaluation, and the closing held-out
  evaluations, can take spending past it.
- **Acceptance (AR-3).** `--acceptance lexicographic` keeps any MQ-4 gain
  (`research.improves`). `--acceptance bootstrap` (`research.paired_bootstrap`)
  pairs candidate and incumbent on the same (case, seed) units, averages
  `--repeats` runs per unit, and keeps the edit only when the mean paired gain
  in correctness is positive in at least 1 - `--alpha` (default 0.95) of 2000
  unit resamples. When no unit's correctness changed it compares mean log
  error (capped at 50); cost-only gains are not accepted. `auto`, the default,
  uses the bootstrap for `--policy reason` and lexicographic for the
  deterministic offline policies. The rule's statistics go into the journal and
  the researcher's history, and the summary adds the same paired comparison on
  held-out seeds. Over 21 units one lucky unit is rejected (P about 0.64); the
  planted fix's three units are accepted (P about 0.96).
- **Researchers.** `api` and `muse` are the model researchers; live calls stay
  gated by MQ-2. `scripted` replays given edits. `heuristic` is an offline
  stand-in, like the fake reasoner. It diagnoses failing transcripts and edits
  the typed settings (`compare_variants`, `experiments`) with a stated
  hypothesis, or proposes nothing.

Verified offline, with no model or network. From the never-compare playbook,
over all six benchmark cases plus `battery-biased` (train seeds 0-2, held-out
3-4, `--jobs 4`, 41 s), the heuristic researcher saw three failing runs ending
on the base model at chi2/N 6.3-6.5 with an uncompared sensor-bias variant. It
proposed `compare_variants: on_misfit`, which was kept. Training went from 18 to
21 of 21 correct and held-out from 12 to 14 of 14, and then it stopped with
nothing further to propose. `tests/test_autoloop.py` covers that run, the CLI,
patience, invalid edits (including invalid setting values), the stop file, the
budget, history, resume, and the bootstrap rule and repeats.

The closed offline loop proves the machinery, not research skill: the heuristic
researcher only knows two failure patterns. The first live run below replaces it
with a model.

### Spark on the coding plan: route `muse` (2026-11-04)

`--route muse` runs the policy reasoner through `muse exec`, so Muse Spark can
investigate on the Muse coding plan instead of the metered Meta API (the
operator chose this over a metered run on 2026-11-04). `MuseExecReasoner`
(`reasoner.py`) makes one headless call per decision: the system and user
messages and the decision JSON schema become one prompt, with shell, writes,
web tools and approval prompts off and at most two model steps. No API key is
passed and `MODEL_API_KEY` is removed from its environment, so a call cannot
fall back to metered tokens. Usage records Muse's token counts with
`cost_usd: null`, because plan usage is not priced per token; `--max-usd` does
not see it. `--record`/`--replay` cassettes work as for the other routes; the
route is text-only. One live decision took 6.8 s and about 24k input tokens,
most of them Muse's own system prompt.

`tests/test_muse_route.py` checks the CLI arguments, environment and prompt with
a fake `muse`, the failure modes, cassette replay, and a full autoloop through
the route, in which the fake `muse` answers with the playbook-sensitive
heuristic brain and the heuristic researcher finds the planted fix.

### First live autoloop run: Muse as researcher, 2026-11-04

The operator approved a small, capped live run on 2026-11-04 ("go ahead" to the
proposal to build AR-3 and then run one). It was billed on MQ-8's terms: the
Muse coding plan through `muse exec`, with no metered API tokens. For that
reason the inner investigations used the offline `fake-reasoner` policy; the
live `reason` policy calls the metered Meta API and was not used.

- **Setup:** `muse-wonder-1.0` as the researcher (at most 16 model steps per
  proposal), cases `battery-biased` and `battery`, train seeds 0-2, held-out
  3-4, `--acceptance bootstrap`, at most 3 iterations. The starting playbook is
  the default one plus a `Settings:` block (`compare_variants: never`,
  `experiments: as_needed`) and one sentence listing each setting's allowed
  values. It says nothing about which value is right or what the failures are.
- **First attempt:** Muse completed but left SKILL.md unchanged, which crashed
  the loop. The Muse adapter shared the API researcher's prompt ("return the
  complete SKILL.md"), so a reply in text was discarded. Fixed: the adapter now
  tells Muse to edit the file (outside the cassette key), uses a reply that is a
  full SKILL.md when the file is unchanged, and an unusable proposal is a
  journalled rejection rather than a crash. The run resumed without re-scoring
  its baseline.
- **Iteration 1, kept:** from the failing transcripts Muse rewrote the strategy
  prose around one diagnosis, "treat residual misfit as a model problem before
  treating it as an information problem ... an experiment cannot fix a missing
  effect such as a sensor bias", and changed `compare_variants: never` to
  `on_misfit`. Training went from 3 to 6 of 6 correct (mean log error 0.29 to
  0.006). The paired bootstrap found 3 units improved and none worse, P(better)
  0.982. 3 model calls, 861k input tokens (573k cached), 2.5k output.
- **Iterations 2 and 3, rejected:** further prose about experiment choice and
  stopping, with no setting change. No unit changed, so they were not kept.
- **Held-out:** 2 to 4 of 4 correct (mean log error 0.31 to 0.006). The held-out
  paired bootstrap gives P(better) 0.931; four units are too few to reach 0.95,
  and that number is reported, not used to decide.
- **Cost:** about 186 s of loop time and 7% of the 5-hour coding-plan window
  (6% to 13%) across all four proposals.
- **Evidence:** journal, state, summary, every proposed playbook, the
  researcher cassette, logs, the code revision and working diffs, in
  `~/.local/state/autophys/evidence/autoloop-live-20261104/` on rwc-dev-01
  (SHA256SUMS).

What this shows: a model researcher, given only failing transcripts and the
setting vocabulary, diagnosed the sensor-bias misfit and chose the right
setting, and the gain held on held-out seeds. What it does not show: the bug
was planted, the allowed values were listed, and the fake reasoner reads only
the typed settings, so prose edits cannot change any score. Iterations 2 and 3
were rejected because the scorer cannot see prose, not because the prose was
judged wrong. Testing prose edits needs the live `reason` policy, which needs
metered tokens and a new operator decision. Per MQ-9's spirit these numbers are
a capability check on a planted case, not a Muse benchmark.

### Proposed extensions (agent-proposed, not built, pending operator review)

```review-flow
flowchart TB
  J["research journal: hypothesis,<br/>predicted effect, diff, score, kept"]:::new
  RS["researcher"] --> J
  J -->|read before the next edit| RS
  VF["validation fails"] --> RM["propose rival model structures<br/>2RC, SoC-dependent R, hysteresis"]:::new
  RM --> DD["rank experiments that discriminate<br/>between rivals, not only by Fisher"]:::new
  DD --> SEL["choose the model on held-out validation"]:::new
```

```review-table
| Id | Proposal | Loop | Why | Cost to try |
| -- | -------- | ---- | --- | ----------- |
| AR-1 | Extend the existing `iterations.json` sidecar with each edit's hypothesis and predicted effect, and feed that history into later proposals (**implemented as the autoloop journal**) | outer | the researcher receives the incumbent playbook, per-run training results, the aggregate score and failing transcripts (`proposal_prompt`), but no history of rejected edits, so it can propose them again | small: sidecar fields and a prompt section |
| AR-2 | Extend the fixed cases with sampled truths, structural mismatch (truth 2RC, model 1RC) and more demanding cost trade-offs, building on the battery suite planned in MQ-5 | both | the leading MQ-4 component, the correctness count, has only one more possible value than there are training investigations (cases times train seeds). Whether greedy Fisher ranking is hard to beat on the current well-specified cases is a hypothesis to test | moderate: `synthetic.py` and goldens |
| AR-3 | Paired, repeated evaluation with a bootstrap acceptance rule (**implemented as `--acceptance bootstrap --repeats N`**) | outer | `improves` accepts any lexicographic gain, which a single noisy reasoner run can produce | small in code, multiplies reasoner cost |
| AR-4 | Typed strategy settings the researcher may edit alongside the prose: stop thresholds and cost weighting (criterion and fit starts are already per-action arguments) | outer | the prose strategy (M-2) already allows departures from the Fisher ranking; typed settings would make chosen behaviour explicit, reproducible and directly searchable | moderate: the contract and validators |
| AR-5 | Model discovery: propose rival structures and rank discriminating experiments when validation fails | inner | `compare_models` today compares the base model with generated sensor-bias variants; proposing and evaluating rival physical structures would extend it, and is the part only a model can add | large: numerics in both SDKs |
| AR-6 | `research --forever` with dollar and test-hour caps, a stop file and resumable state (**implemented as `autophys autoloop`; dollar and wall-time caps, no test-hour cap yet**) | outer | needed to run unattended once MQ-2 allows live calls | moderate |
```

None of these changes the workbook format. AR-5 and further live runs need
operator decisions before dependent work starts.
