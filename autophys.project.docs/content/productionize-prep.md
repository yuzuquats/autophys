# Establish one reproducible investigation loop before expanding Autophys

Status: **preparation complete, revision 1, 2026-11-04; productionization unstarted.** No product code was changed, no remediation or independent judging ran, and no readiness scores are assigned.

Autophys already has numerical SDKs, append-only workbooks and a generic browser workbench. The highest-value first work is to qualify these together at one owner-approved revision. Individual green checks currently sit beside substantial peer drafts and older clean-export failures. That is an evidence and integration problem before it is a reason to redesign the product.

Read this page for the evidence and starting order; [productionize-brief.md](productionize-brief.md) supplies the future executor/judge handoff.

## The product and the state actually inspected

The canonical owner is **rwc-dev-01**, root **/home/james/workspace/autophys**, on **master**, with its Git directory in the workspace submodule store. S-1 and PURPOSE in [decisions.md](decisions.md), S-1 at decisions.md:19, establish the product repository and general physics-investigation purpose. Battery is an example alongside oscillator and thermal_rc; it must not become a battery-only hardening exercise.

The owner workspace AGENTS.md applies, including scoped local commits, source ownership, no worktrees, preservation of peers, external evidence and build storage. No product/nested AGENTS.md was found in maintained Autophys files. The productionize skill plus its packets/rubrics, design-spec and task-board skills govern this preparation. Vendored Tento is a dependency input, not writable product scope.

The core flow is:

```text
Python or Rust SDK -> config + measurement -> fit + sensitivity + ranked experiment
                    -> .ap-workbook record log <-> Rust daemon /api/v1 + SSE
                    -> generic browser presentation -> human approve/edit/reject
                    -> attach measured/synthetic data -> refit -> outcome
Synthetic evaluator only -> reveal after outcome; subsequent continuation refused
```

Public contracts are the Python autophys API/CLI and @ap.simulator interface; Rust crate autophys and daemon binary autophys; .ap-workbook SQLite schema, canonical record hashes, idempotency and proposal transitions; /api/v1 and collection/scoped SSE cursors; display manifests outside configuration hashes; and the Cookbook composition contract. Consumers include examples/battery_fit, Muse's MCP plugin, local and HTTP SDK clients, the served browser, and train/research tooling. These contracts span src/, sdks/, html/, plugins/ and the existing conformance fixtures.

Preserve AX-2 (numerics in SDKs, browser presentation/interpolation), AX-4 (resumable SSE), DM-1 (generic product metadata), human approval, and truth isolation. The browser's built-in run starter is specifically a synthetic thermal investigation (src/http/workbench.rs:1,189), not evidence that arbitrary uploaded simulators execute in the daemon. The real-data battery example has its own measured-model entry point.

Python declares >=3.10 (sdks/python/pyproject.toml:10). Native packaging has Linux and macOS implementations (src/embedded.rs:1); B1-M1 explicitly still requires a real macOS section/signature/hydration check (decisions.md:80). This prep exercised Linux ARM64 only, with Python 3.12.3, NumPy 2.5.4, SciPy 1.18.1, pytest 9.2.0, Deno 2.9.8 and TypeScript 6.0.3. It establishes no Windows, macOS or other architecture qualification.

Recent work includes generic display metadata, fit curves/reveal, Rust remote access, candidate uncertainty columns, read-only accounts, autoloop recovery/accounting, and training CLI work. Existing FC-1/GT-1 choices remain agent-chosen pending review; FC-1r2's numerical tolerances are operator-confirmed. Their current status is preserved, not promoted by this plan.

## Identity and decisive checks

Assessment/check identity at 22:46:08–22:47:30 UTC:

- HEAD **3e7f1c2e5fc84d000adc3a82fbc2c42af2f2cbab**.
- Content manifest SHA-256 **268003ec750c9bde2612ec991c89fe494e58425975d919e51d58cec3f75aa68c**; **2,825 paths / 24,559,697 file bytes**.
- The manifest before and after the runnable checks was identical, with zero unstable individual reads. This is a working-content identity, not a claim that HEAD alone contains the tested state.
- The baseline inventory recorded 54 staged paths, 49 unstaged paths and 22 nonignored untracked paths (categories overlap). The recorded index contains staged edits/deletions alongside unstaged changes and untracked replacement paths. Do not interpret staged-delete plus untracked replacement as permission to remove or adopt those files. All peer staging is preserved.

A later handoff sample at 22:49:04 UTC was HEAD **61d12e9651827db85eafff7812736739856ea9bf**, manifest **238b5f535c7d745a9922e3020e03992cc5047e8f827577b9b2d7b76a29c4d495**, **2,826 paths / 24,569,112 bytes**. Only html/routes/muse-peek.ts and a new train/sft/GAPS-real.md differed from the checked content: mascot alignment code and a training gaps note. The mascot source was inspected; no campaign baseline is being frozen. Recheck on resumption rather than assuming either sample is current.

Manifests hash tracked plus nonignored untracked files, including dirty working bytes, tracked training inputs, vendored Rust/TypeScript dependencies, lock/config inputs and test fixtures. No maintained symlink was found. Each path records size/type/hash and read stability; index listings are separate. They exclude ignored build/runtime state, credentials, external toolchain/cache contents and these new prep pages. This is not an atomic filesystem snapshot; installs, ignored dependencies, environment and later writes remain limitations.

Full commands, manifests, environment receipts and logs live only at **~/.local/state/productionize/autophys-prep-20261104/** on the owner. They are retained for resumption because the campaign has not run.

```review-table
| Existing check | Decisive outcome | What it establishes |
| --- | --- | --- |
| Existing SDK venv: python -m pytest -q sdks/python/tests/{test_workbook,test_conformance,test_candidate_outlook,test_display,test_curves_reveal}.py | 106 passed in 11.89s; exit 0; 12.13s wall | Selected workbook, idempotency, projections, display, curve/reveal and candidate contracts in Python working bytes |
| ~/.deno/bin/deno test --cached-only --allow-read --config html/deno.json html/ | 89 passed, 0 failed; exit 0; 9.04s wall | Existing pure UI/client, boundaries, fixtures and flow tests in working bytes |
| ~/.deno/bin/deno check --cached-only --config html/deno.json html/routes/index.root.ts | exit 0; Check html/routes/index.root.ts | Composition root type-check at 61d12e9; experimentalDecorators deprecation warning remains |
| GET http://127.0.0.1:4794/api/healthz (read only) | ok:true, version:0.1.0, commit:1bf1a57593b4501519353358149a40f285f451c3 | Installed service answers health; it is a separate revision from source under assessment |
```

Python used ~/.cache/autophys/venv/bin/python, PYTHONPATH=$repo/sdks/python/src, PYTHONDONTWRITEBYTECODE=1, PYTEST_DISABLE_PLUGIN_AUTOLOAD=1, an external TMPDIR, and --basetemp in the evidence directory. The system Python lacked NumPy; no dependencies were installed. The command arrays and exact environment overrides are in the external receipts.

These suite times are not product performance measurements. No Rust compilation/test run, production bundle build, lint campaign, real browser flow, cross-writer daemon test, external provider, training, GPU or cloud job ran. Cached-only Deno prevented dependency downloads. There is no product-owned CI workflow tracked in this repository; vendor workflows do not qualify Autophys, and external CI status was not queried. Historical Rust/Python pass counts in fit-curves-and-truth.md and deploy-gate-tests.md are prior evidence, not this revision's test result.

## Evidence that changes the starting order

```review-table
| Finding | Evidence and mechanism | Consequence / confidence |
| --- | --- | --- |
| R1: committed integration proof is missing | deploy-gate-tests.md:3 records 10 clean-export Deno failures and explains that passing live-tree tests depended on owner drafts; this prep's status/index manifests again show overlapping staged and unstaged changes across SDK/API/UI | Proven evidence gap; this does not assert those historical failures still occur at current HEAD. A coherent committed cross-language baseline comes first |
| R2: release gate omits Python and the real approval flow | ops/deploy.sh:36 runs Rust workspace tests and Deno tests, then builds/packages; no Python or browser/cross-writer gate is called there | Proven gate coverage gap for a product whose SDK writes the authoritative format. Existing separate manual checks must be reconciled before adding another runner |
| R3: document sessions accumulate until process exit | src/app.rs:111,188 mints a cookie per successful document load; src/http/auth.rs:37,41 inserts every token in a HashSet with no eviction/expiry/removal in that type | Proven unbounded retention mechanism, including landing loads in login mode. Operational severity needs a declared traffic budget; no memory exhaustion was reproduced |
| R4: plugin SSH launch has a known path failure | plugins/muse-autophys/build.py:52 writes command = ["sh", "mcp-stdio.sh"]; improvements.md item 8 records Muse launching from the workspace directory and the wrapper not being found | Existing reproduced integration defect in the project record, confirmed mechanism in source; not re-run against Muse in this prep |
| R5: workspace/stream costs grow with retained data | src/http.rs:362,379 gathers snapshots and all records; src/http/sse.rs:233 reads each workbook, up to PAGE=500 records per workbook per refill, with a 1s poll per stream | Performance hypothesis with a concrete path, not a measured latency failure. Page size is per workbook, not a total collection bound |
| R6: platform claim exceeds current proof | decisions.md:80 requires macOS section/signature/serve verification; src/embedded.rs:464 has a separate macOS packing path | Proven missing qualification; Linux checks cannot establish the macOS packaging contract |
| R7: measured ingest scope is narrower than arbitrary lab logs | sdks/python/src/autophys/mcp/measurements.py:26,42,55 caps CSVs at 1 MiB / 10,000 rows and checks the declared time grid | Proven boundary, not inherently a defect. Bigger/irregular logs require a product decision before importer expansion |
| R8: discovery and artifact boundaries need a small correction | README.md:54 still says no browser fit curves, while current wire/tests and fit-curves-and-truth.md describe them; the owner root target is a real directory, contrary to workspace build-output rules | Proven stale entry-point wording and observed layout issue. Neither justifies broad folder moves, cleanup, or deleting peer artifacts |
```

The architecture already has useful boundaries: generic display metadata, SDK-owned numerics, workbook transactions, API admission and pure presentation tests. Folder structure separates daemon, SDKs, UI/client, examples, ops and training; there is no demonstrated reason to reorganize it. Existing resource limits also matter: 1 MiB records, 16 MiB HTTP blobs (src/http.rs:48), four concurrent daemon starters and per-project leases (src/http/workbench.rs:30), plus an approval deadline (workbench.rs:221). The deadline is checked while awaiting approval, not an independently proven cap on a blocking numerical call. The future performance judge should inspect that failure path without claiming there are no limits today.

## Proposed first four batches

**All batches below are proposed and unstarted.** Effort is relative: S = a narrow change/check, M = several cross-language contracts, L = new behavior or platform investment. Each batch can be committed and reviewed independently; no mass rewrite or folder move is proposed.

```review-table
| Order | Bounded outcome and affected paths | Acceptance and validation | Dependency / effort |
| --- | --- | --- | --- |
| 1. Qualify one committed investigation loop | Existing peers finish/reconcile their own SDK/API/UI drafts; a single verified gate uses tests/, sdks/*/tests, html/client + ui tests, html/e2e/daemon-flow.ts, e2e/approve.ts and ops/ documentation as needed | One HEAD+manifest; Rust workspace, full offline Python, Deno and root type-check pass on the same inputs. A temporary collection proves SDK write -> daemon snapshot/SSE -> browser approve/edit/reject -> attach/refit, restart/reconnect, idempotent conflict and reveal/no-resume. Record enabled/skipped cross-writer tests and Python/Rust numerical tolerance/exact-replay outcomes. No claim based solely on mocks or a different served release | Requires writer coordination and existing draft ownership reconciliation, not adoption by this prep. M; highest value because it makes later fixes and judge findings attributable |
| 2. Close demonstrated session/plugin failure paths | src/http/auth.rs, src/app.rs, src/login.rs, tests/ auth cases; plugins/muse-autophys/build.py and existing test_muse.py | Bound document-session retention while retaining live-session semantics; repeated page loads and expiration/sign-out/restart tests demonstrate the bound. Keep login, bearer keys, read-only accounts and CSRF behavior. Plugin starts from a different cwd with its canonical playbook. Run focused Rust HTTP/account tests and Python test_muse.py; no external model call is needed for the launcher contract | Needs chosen access mode; test boundary chosen in batch 1. Two separable S/M subchanges |
| 3. Measure the declared small-lab workload | tests/ workload fixtures, src/http.rs, src/http/sse.rs, SDK workbook snapshot paths, html/client/store.ts and existing e2e drivers only if evidence warrants | Repeat cold/warm snapshot, first render and resumed SSE at agreed project/record/payload sizes; report median, p95/range, peak RSS, response bytes, polling work and failure/reconnect cost. Measure curve serialization/storage and one deterministic built-in fit. Optimize only demonstrated budget violations and preserve hashes/cursors/approval behavior | Needs workload and latency/storage budgets plus a stable batch-1 identity. M; this prep sets no invented SLO |
| 4. Qualify distribution and clarify the entry point | src/embedded.rs, tests/ packing checks, ops/, README.md and existing project docs | Linux pack/hydrate/concurrency gates and matching runtime web identity; if macOS is supported, real Mach-O section, codesign --verify and serve/hydrate checks on its authorized build host. Document supported platforms, current generic behavior, one command per gate, and external build-output locations. Resolve the real target directory with its owner and explicit move/deletion authorization before changing it | Needs platform choice and build/resource ownership. S for docs/Linux evidence; M for macOS qualification. No release or deployment is implied |
```

Future baseline commands are in the brief. Do not run ops/deploy.sh as a verification shortcut: it builds, changes the current symlink and restarts the service. The four proposed batches are a starting sequence, not permission to perform all work or a promise that exactly four batches will reach the target.

Deferred from these batches: irregular/large lab-log import, new simulator domains, training/provider quality campaigns, GPU/cloud spend, universal platform support and visual redesign. The existing improvements.md and train.md/GAPS-real.md remain their records; this plan neither closes those items nor creates parallel implementation tasks.

## Decisions before future investment

**PP-1 — agent-chosen, pending operator review:** start with a general small-lab workbench and the existing three model domains, preserving both SDKs and browser approval. Use current local/HTTP contracts as the baseline; do not grow arbitrary simulator execution, broad measured-ingest support or training into the first batch. This is only a planning recommendation, with no implementation. Reversal is editing the future brief before a campaign starts, at negligible cost.

Before paying for platform qualification or a broad five-judge baseline, the operator must choose which success contract to qualify: local/private single-lab operation, or the current invited-account service through a public proxy; whether macOS is a supported delivery target now; and the representative project/record/data sizes and acceptable response/memory budgets. The recommended first batch can prepare the existing offline gates while those answers are pending. Training needs a separate explicit scope and spend budget.

FC-1/GT-1 decisions are already pending in decisions.md:105 and should be reviewed before increasing dependence on that persisted format. Do not invent an unresolved decision about generality, vendor placement, numerics ownership or human approval; the operator has already ruled on those.

## Resumption and stop boundary

Reuse Project: autophys. Parent session is 2cc3ffde-2d92-46aa-8c1d-dd97dfa2909e. Owner task CLI discovery found no tsh.lona/lona-console on PATH. The managed Loaf-1.0.96-dev console was tested from ~/.tento-tasks and returned **error: no command task** (exit 1). Per the task-board skill, external tasks.json holds prep-root, prep-inventory, prep-readiness and prep-plan; reconcile them through a supported CLI if one later becomes available. No board update or direct SQLite mutation is claimed.

On resumption, compare source/index state and linked/dependency inputs to the manifests, then coordinate one writer and refreeze. Source changes invalidate affected check claims; unrelated changes do not. This preparation remains useful even when the exact source has advanced, because its evidence dates and mechanisms are explicit.

Stop preparation here. A future authorized campaign starts with five distinct independent judges, default target **>=9 in each** of quality, architecture, testing, folder structure and performance. No average, no waived dimension, and no score is inferred from this single research pass. Default future budget is baseline plus at most three bounded remediation/rejudge rounds; stop sooner for stalled progress, unavailable proof, scope/ownership limits or disproportionate cost.

```review-callout risk What this preparation does not prove
Passing working-tree tests do not certify committed master, the installed release, real-browser behavior, Rust/Python cross-writer parity, native packaging or workload performance. If the future frozen integration gate already passes without remediation, batch 1 becomes evidence capture rather than a rewrite. If real workload measurements meet the chosen budgets, preserve the current architecture. Keep the external prep directory until a later completed campaign has committed its durable summary; no cleanup is authorized here.
```
