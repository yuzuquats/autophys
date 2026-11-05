# SDK baseline proves shared core behavior and exposes parity questions

Status: preparation complete for `autophys-sdks-20261105`; five independent judges have not run. No SDK implementation changed. The target remains at least 9 in each dimension, with baseline plus at most three remediation/rejudge rounds. This campaign is unfinished.

The operator requires Rust and Python to be analogous. [brief.md](brief.md) maps corresponding capabilities, concepts, formats, defaults, validation/errors and effects, while allowing idiomatic APIs. It also distinguishes intentional API shape differences from unexplained behavior and Python-only tooling. Judge that contract before proposing repairs.

| Dimension | Baseline | Final |
| --- | --- | --- |
| Quality | pending | pending |
| Architecture | pending | pending |
| Testing | pending | pending |
| Folder structure | pending | pending |
| Performance | pending | pending |

On yuzuquats Linux x86_64 (i7-12700K, Python 3.12.3, NumPy 1.26.4, SciPy 1.11.4, Rust/Cargo 1.98 nightly), the fresh SDK-only native build ran offline with a locked dependency graph. Ten Rust artifacts passed **109 tests**, and rustdoc passed **1 doctest**; every result reported zero failed/ignored. These include numerical/vector/workbook conformance, investigation loops, remote transport, battery, display and curves/reveal checks.

Python collected **688 cases**. The broad run stopped under its 600-second cap with **424 passed, 1 skipped in 590.75s**, at a SciPy integration inside research tooling. It is an incomplete suite result. Exact unexecuted-case selection then passed **255** critical cases, and separately **5 cross-writer** cases passed against the identified existing daemon: concurrent writes and verification, wait deadlines, restart recovery and blobs. The combined source account is **684 unique passed, 1 intentional live-provider smoke skipped, 3 unexecuted research cases**; there are no observed failures among completed cases. Four warnings concern Python 3.12 fork from the multi-threaded cross-writer test harness. No full-suite pass or universal concurrency/platform qualification is claimed.

A wheel was built through the declared setuptools backend with generated files directed outside source, installed into a fresh external target without global installs, and imported from that installed target. Its resource smoke passed; **173 installed-package workbook/conformance/replay/SDK-contract tests passed**. This is separate distribution proof, not 173 additional unique source cases. A coarse fallback run was superseded after 28.8 seconds by exact remaining-case selection; it is excluded from combined accounting. Initial storage-monitor and benchmark-harness mistakes are retained as failed harness attempts, not product failures or passing results.

Budgets were set before measurement: each language's 1,000 record appends plus complete chain/projection verification under 10 seconds, each new Python process import under 3 seconds, and one scripted oscillator seed under 120 seconds. All met those budgets on this host, with warm filesystem caches and fresh databases:

| Workload | Rust | Python |
| --- | --- | --- |
| 1,000 appends + verify; 3 repetitions | 0.265 / 0.239 / 0.243 seconds | 0.160 / 0.157 / 0.147 seconds |
| Verified result on every repetition | 1,001 records; one investigation; no chain errors; projections match | same five report fields and outcome |
| Peak RSS of measured process | 9,120 KiB | 88,224 KiB including imports and child import workload |
| Five new-process imports | not applicable | 0.254 / 0.259 / 0.258 / 0.257 / 0.248 seconds |
| Scripted oscillator, seed 0 | shared numerical tests passed; no matching standalone benchmark measured | validated; correct diagnosis; `sine_0.44Hz`; 691 simulations; 8 steps; 3.235 seconds |

These are representative local measurements, not peak-scale benchmarks or evidence that one implementation is intrinsically faster. Numerical solvers may take different paths; shared fixtures apply explicit numeric tolerances, sign equivalence and set comparisons.

Fresh probes confirm two unexplained parity gaps: Python accepts positive-infinite noise sigma at construction while Rust validation rejects it, and Python HTTP errors discard a supplied 422 `path` while Rust preserves it (the Rust remote test checks `payload.x`). Source inspection also finds different empty-target/URL normalization. Python's memory/JSONL stores, plots, CLI research/export and optional MCP/Muse adapters have no identified dedicated Rust counterparts. Judges must assess materiality and rationale rather than silently waive these differences. Rust `Result`/traits/RAII versus Python exceptions/decorators/context managers, and split Rust project/resume methods, are idiomatic differences already explained by the API shape.

Remaining proof includes the three research tests (`test_cli_runs_the_research_loop_offline`, `test_research_keeps_the_planted_fix_and_rejects_a_regression`, `test_scripted_researcher_runs_out_cleanly`), other declared Python versions and native platforms, live providers and sustained/large-scale workloads. The existing daemon is reused by digest; all compared native SDK/API/dependency inputs match the assessed source except login-page CSS/autofocus presentation. Cross-writer tests run without login and with a fixed existing web root. This certifies that SDK/daemon contract, not current login rendering or a fresh daemon rebuild. Rust formatting check exits 1 with existing formatting diffs; no formatting repair was made. Cargo declares UNLICENSED/publish=false while Python declares Apache-2.0; release/redistribution remains a material review question.

The executable baseline began at `5e31b9347a1e26ec8569fd66cf4e328abb3a10d6`. Before/after manifests agree on SDK/direct-contract content digest **`10b5300e2cbff60ac9aa063140ed232753882b8d4cbbe49a39e0c5cc86c344b6`** and native dependency-source digest **`b7dbbdda8cb38c78ebc11b1f5f9360ed4c8f6eea0f197a142fd0c307c8b88ad1`**. An unrelated tutorial-halo commit advanced master during verification; these inputs did not change. The final handoff records current HEAD and hashes of external harnesses/dependencies. There is no repository-wide freeze.

Conservative aggregate storage peaked at **7,244,431,360 bytes** including the entire unchanged previous campaign; minimum sampled free space was **16,675,655,680 bytes**. Both remain inside the approved 8 GiB allocation and 12 GiB free-space limits. No old cache/evidence was deleted or modified, no target symlink changed, and no push, deployment, service, branch, worktree, stash, product repair or live provider/training call occurred. Workspace/home layout checks retain pre-existing findings (including unpublished Autophys layout divergence); preparation does not authorize their repair.

Raw evidence, exact commands, XML/node accounting, failures, manifests and resumable fallback tasks are retained outside Git at `~/.local/state/productionize/autophys-sdks-20261105` on yuzuquats. The installed task launchers cannot expose a working task command, so `tasks.json` is the documented fallback; no board update or SQLite write is claimed. The parent takes task/evidence custody, launches five independent judges against the same identity, and chooses any bounded remediation. Judges write their own external reports only. Delete working evidence only after the campaign finishes and its final summary/reports are committed.
