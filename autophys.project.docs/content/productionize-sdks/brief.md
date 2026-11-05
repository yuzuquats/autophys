# Qualify the two SDKs against their shared scientific and workbook contracts

Status: preparation for `autophys-sdks-20261105`; implementation unchanged. The baseline starts at `760c050b320a7b3e7ad5ae6d199f8721d99ea7b6`. Scores have not been assigned.

The operator asked, “let's review our rust and python sdks and $productionize”. Both exist: Cargo names `sdks/rust`'s library `autophys`; Python packages `sdks/python/src/autophys`. The daemon depends on that Rust crate directly. This campaign asks whether local scientific applications and cooperating workbook writers can rely on these libraries, their HTTP adapter, and their packaged public entry points.

The Python root exports simulator/configuration objects, datasets, fit/analyze/rank functions, local/remote clients and workbook investigation objects, scripted/reasoner policies, replay/recording, stores and display. Rust's `src/lib.rs` exports the corresponding record/client/workbook APIs and numerical, agent, model, usage, reasoner and remote modules. Its introductory phase-1 prose is older than its implemented module surface; judge actual code. Python also exposes CLI bench/research/export and optional MCP integrations. The daemon's `/api/v1` implementation is the direct integration consumer; examples, shared conformance fixtures and numerical vectors are other consumers.

The contract to preserve is scientific behavior, including parameter ordering, bounds, identifiability, evaluator-only truth, uncounted previews, fit/design budgets and deterministic seeded checks. Preserve workbook format 1, canonical JSON/hash chains, config versions, idempotent record writes, atomic attachment, proposal approval transitions, cross-writer verification, replay exact-request checking and spend accounting. API auth/retries/SSE cancellation are SDK integration contracts. Neither a “cleanup” nor a score target permits changing those meanings.

```review-table
| Boundary | Included qualification | Explicit limit |
| --- | --- | --- |
| Rust library | `sdks/rust/**`, public exports, unit/integration/doc checks | No claim of macOS or ARM qualification from Linux runs |
| Python package | `sdks/python/**`, examples, CLI resources and offline scientific/record workflows | Optional MCP may be unavailable; no live model or Muse execution |
| Shared contracts | root Cargo manifests/lock, numerical/vector/workbook fixtures, direct daemon API source/tests and its native dependency closure | Frontend, deck/drawer, deployment, training and provider campaigns are outside scope |
| Environments | Linux x86_64 owner, observed Python 3.12 and installed Rust edition-2024 toolchain | Python metadata's >=3.10 and native platform portability require separate evidence |
```

The normal workload is a single engineer's local project: small oscillator/thermal/battery calibration, bounded investigation iterations, SQLite workbooks with hundreds to thousands of records, and two local/HTTP writers. Provider-free fake/replay tests exercise reasoner boundaries. Public packaging and offline dependency identity are evaluated without redistributing or publishing. Existing contradictory license declarations are relevant to release claims, not a reason to rerun app-wide publication.

Before measuring, set modest warm-runtime budgets on the existing owner: 1,000 record append+verify operations within 10 seconds per language, five cold Python imports each within 3 seconds, and one-seed scripted oscillator benchmark within 120 seconds. Record all repetitions and RSS where available; no peak-scale claim. Scientific suite runs get 600 seconds for Python, 300 seconds per native artifact; a fresh SDK-only compile gets 900 seconds. A timeout is a result, not permission for unbounded retries. Acquisition/packaging checks get 180 seconds. At most one native build runs at once.

The boot-disk exception permits at most 8 GiB aggregate task-owned allocation across the prior retained campaign and this one, and requires stopping before free space reaches 12 GiB. Count the entire prior campaign conservatively, inspect caches without deleting them, use only new external campaign paths for writes, and sample storage during verification. Proactively stop at 7.5 GiB aggregate or 13 GiB free. Existing artifacts may execute only after source correspondence and artifact digests are recorded; fresh results must be recorded here. Do not mutate old evidence or change target symlinks.

The target is >=9 separately in quality, architecture, testing, folder structure and performance. Preparation freezes HEAD plus a source/dependency/test/config manifest including relevant dirty and untracked inputs. The parent then assigns five independent judges; findings drive at most three bounded remediation/rejudge rounds, all five dimensions each round. Stop honestly for unresolved contracts, exhausted rounds, storage/capacity limits or disproportionate work. No implementation repair is authorized in preparation.

The SDK-specific summary belongs in this directory under the existing `Project: autophys`. Working logs and task fallback live only at `~/.local/state/productionize/autophys-sdks-20261105` on yuzuquats. The task CLI is currently unusable (the installed launcher cannot resolve `lona`, and installed console lacks `task`); `tasks.json` is the documented external fallback, to reconcile when a supported CLI is available. The parent takes custody at the ready-for-judges handoff; the campaign remains unfinished and evidence retained.

Preparation may write this SDK subrecord and its external evidence only. Preserve all peer drafts, staged/untracked inputs and previous campaign evidence. Work on owner master over SSH; no branches, worktrees, stashes, pushes, deployments, services, deletions, paid/provider/training calls, or contact with rwc-dev-01. Unrelated source may advance; only changed scoped inputs invalidate dependent evidence.

```review-callout
kind: risk
title: Evidence defines the supported claim
The previous app campaign stopped below target. Its historical timeout, SIGSEGV, replay and platform findings are leads to inspect, never fresh failures or automatic SDK blockers. This campaign needs its own bounded results. No judge scores or production-readiness claim exist yet.
```
