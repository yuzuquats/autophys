# Future Autophys judges must review the same supported investigation loop

Status: **future campaign brief, revision 1; not launched.** Preparation findings and checked identities are in [productionize-prep.md](productionize-prep.md). This brief confers no implementation or publication authority.

The user asked to prepare to productionize Autophys, **but not yet**. A future campaign needs a new instruction to start. Its objective is a reliable general physics investigation workbench: measurements -> fit/identifiability -> ranked experiment -> human approval -> attach/refit/outcome, with synthetic truth isolated until evaluation.

## The packet to freeze before judging

Use owner rwc-dev-01:/home/james/workspace/autophys on master and Project: autophys. Read workspace AGENTS.md and current decisions.md, sdk.md, rust-sdk.md, store.md, workbook-format.md, display-manifest.md, fit-curves-and-truth.md and html/COOKBOOK-CONTRACT.md. Preserve existing operator decisions and peer ownership.

Start with existing battery, oscillator and thermal examples; Python and Rust SDKs, .ap-workbook durability/hash/idempotency contracts, /api/v1 + SSE cursors, generic browser displays and proposal approvals. Include the Muse launcher as an actual consumer. The offline training/research tools are dependency/consumer inspection scope; GPU runs, provider quality/spend and new data formats are deferred unless explicitly added.

Before substantial campaign investment, settle access mode (local/private lab or invited-account public-proxy service), required native platforms, representative collection sizes and resource/latency budgets. Suggested sizing questions: 1/3/10 projects, 100/1,000/10,000 total records, typical 1–32 KiB payloads with curve-heavy outliers, and 1/4 concurrent browser streams. These are candidates for choosing a workload, **not adopted limits or measured capacity**. Include an existing small built-in numerical case, declared CSV boundaries and failure/restart behavior.

Create a fresh external campaign directory under ~/.local/state/productionize/. The retained prep evidence is at ~/.local/state/productionize/autophys-prep-20261104/. Record HEAD plus scoped content digests for tracked, staged/dirty and relevant untracked inputs, local vendored dependencies, lock/config/test inputs and runtime resources. Capture toolchain/environment, writer agreement, task IDs/fallback and before/after manifest checks. Quiesce target writers while judging; no feature branch/worktree or substitute source line.

The prep's stable checked state was HEAD 3e7f1c2e5fc84d000adc3a82fbc2c42af2f2cbab + manifest 268003ec750c9bde2612ec991c89fe494e58425975d919e51d58cec3f75aa68c; source advanced during preparation. This is a resumption locator, not the future baseline.

## Existing verification to qualify

Inspect every command and fixture before execution. Use external temporary state and approved build storage; never point a test at the live collection, keys database, service port or installed current release. Do not use deploy.sh to run gates.

```sh
# Repository root. Explicit approved external CARGO_TARGET_DIR is required.
cargo test --workspace --locked
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/sdks/python/src" \
  "$HOME/.cache/autophys/venv/bin/python" -m pytest -q sdks/python/tests
"$HOME/.deno/bin/deno" test --cached-only --allow-read --config html/deno.json html/
"$HOME/.deno/bin/deno" check --cached-only --config html/deno.json html/routes/index.root.ts
```

These are existing gates, not results for a future revision. Preserve the exact Python interpreter/dependency identity or qualify its replacement without silently installing packages. Inspect skips and optional environments: cross-writer tests require AUTOPHYS_RUST_BIN and AUTOPHYS_RUST_WEB_ROOT (test_cross_writer.py:26); supplying no binary silently leaves that contract untested. Browser scripts under e2e/ and html/e2e/ need a temporary collection and distinct loopback port plus the required headless-browser workflow. Read that skill before launching any browser and verify cleanup. Some drivers seed data/start servers, so inspect/configure them before running.

The prep ran only 106 selected Python contracts, 89 Deno tests and the root type-check; all passed. Rust, packaging, browser and workload performance remain unverified at its identity. No product CI workflow is tracked; inspect any actual external CI separately rather than treating vendor workflows or historical logs as current qualification.

## Orchestration when the user starts the campaign

The central orchestrator coordinates only. Delegate all source work, substantive docs, checks, evidence and scoped commits to an executor; the executor is the sole target writer. Discover live provider/model capabilities and retain every task ID. Do not launch top-level threads as child work.

Commission **five distinct judges**, one per quality, architecture, testing, folder structure and performance. Give each the same source/workload/manifest/evidence packet, its own rubric from the productionize skill, the original objective and the report schema from references/packets.md. Judges read code and evidence, make no target changes, never judge their own implementation and do not see other initial scores. Target is **at least 9/10 in each dimension**, not an average. Unknown evidence stays unverified.

Each report needs identity, score/confidence/verification, scope/workload, file:line and command evidence, findings with severity/acceptance criteria, missing proof, blockers, regressions and rationale. Keep raw reports outside the checkout. Use findings R1–R8 in the prep as leads, not predetermined verdicts or scores. In particular, verify whether existing peer work already closes R1/R4 and whether declared workload makes R3/R5 material.

Default budget: one baseline and at most three justified remediation/rejudge rounds. After each bounded batch an executor runs relevant checks and refreezes; all five judges independently rejudge that same identity. Use new delegated review tasks/IDs each round. Stop when all five verified dimensions meet target with no blocker, or when proof is unavailable, progress stalls, authorization/ownership would be exceeded or cost is disproportionate. Do not start training, cloud spend, new services, deployment, push, deletion or adoption of another session's changes under this brief.

On an eventual completed campaign, commit only the durable summary/brief/final five reports in existing project docs, with decisive outcomes inline and scoped Project/Change-Id commits; then apply the productionize skill's evidence lifecycle under the authority actually granted. Until then retain resumable evidence and distinguish completed preparation from an unfinished or unstarted campaign.
