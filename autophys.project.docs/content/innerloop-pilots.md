# Pilots test the scientific mechanism before confirmation

Status: pilot preparation, 2026-11-06. The source-alignment pin is 132bd8f7; current owner descendants and uncommitted peer UI edits are outside this scientific Python scope. No confirmation run is authorized in this phase.

The immutable scientific schedule and thresholds remain in [innerloop-experiments.md](innerloop-experiments.md). Only seeds 11 and 12 may execute here. The harness uses product Investigation, synthetic observations, fitting, sensitivity, ranking, validation, workbook, resume and research APIs; it does not implement their algorithms. Three matched catalogue cases use diagnostic, no-update and uniform-random arms with one acquired experiment. Missing data, missing validation, short-only ambiguity and independent two-timescale thermal responses challenge honest stopping. All outcomes, including failures and deadline exits, remain evidence.

```review-table
| Surface | Evidence sought | Limit |
| --- | --- | --- |
| Python science | recovery, weighted unseen prediction error, actual counters | pilot catalogue only; no population claim |
| Laboratory handoff | four fresh interpreters, approval, attachment, reopen and matched reference | local workbook; daemon parity needs matching native artifact |
| Outer research | useful scripted edit retained, harmful edit rejected; post-selection audit | no autonomous discovery, no heldout rollback |
| Offline lifecycle | existing lifecycle/assets/provider-facade tests | no provider, GPU or live training |
```

**Decision PILOT-01: keep filtered feedback.**

**Review status: operator-confirmed.** In the invoked `/open-questions` walkthrough, the operator explicitly answered **"Keep filtered feedback (Recommended)"**. The researcher/proposer receives training scores and action evidence, but no synthetic evaluator truth, reveal records or final-test diagnostics. Full evaluator reports remain available for analysis. This is a cooperative data boundary, not a sandbox.

**Implementation status: implemented** in `sdks/python/src/autophys/research.py` and `sdks/python/src/autophys/autoloop.py`. **Real-path/resume qualification remains open.** This documentation-only decision record adds no test evidence or readiness claim and grants no confirmation-run approval.

**Historical agent choice and reason (initially pending operator review):** replace raw proposer feedback with a copied report excluding reveal records and evaluator-only fields. Training aggregate score feedback is retained by design; final audit never influences candidate selection. The observed default passed post-outcome reveals into a researcher. Keeping that path would expose hidden physical parameters. Raw evaluator sidecars/workbooks remain unchanged for analysis; this is a cooperative structural boundary, not a hostile-code sandbox. Reverse by reverting the scoped Python change before any confirmation; expected cost one small forward commit, then new review and pilot.

**Decision PILOT-02: use aligned checkout.**

**Review status: operator-confirmed.** The operator explicitly answered **"Use aligned checkout (Recommended)"**. Future experiments, when separately authorized, use the rwc-dev-01 checkout aligned to a reviewed owner-master revision, with exact source and environment identities frozen per run. Existing snapshot pilot evidence remains historical, capsule-scoped evidence; it does not qualify a future checkout or environment.

**Implementation status: pending checkout alignment/environment qualification.** This documentation-only recording authorizes no checkout alignment, new experiments, tests, confirmation-seed use or readiness claim.

**Historical agent choice and reason (initially pending operator review):** execute a hashed, read-only owner-produced Python source capsule on rwc-dev-01, without moving its consumer refs while the parent finalizer uses them. This qualifies the recorded capsule, not an arbitrary checkout HEAD. The alternative is to wait for consumer-ref custody to transfer. Reversal costs only selecting the same committed source after safe fast-forward; no data migration.

Resource ceiling: no native build on any host, no owner cache/install, <=2 MiB new owner source/Git, <=512 MiB experiment output, <=4 CPU threads, <=45 minutes this phase; checks <=300 s except one 600 s research pilot. Seccomp denies Internet sockets in each Python runner and descendants. Existing scientific dependencies only, no installs/downloads. Native x86_64 retained artifacts cannot run on ARM64 rwc-dev-01 and current training/login source is newer. Q1/Q2/G1 remain distinct gates. Confirmatory 101..105, selection 201..205 and final 901..905 remain untouched.

External evidence: rwc-dev-01:~/.local/state/productionize/autophys-innerloop-20261106/pilot-executor; mirrored short manifests on rwc-01 under the same workstream. Local task fallback only; no task-board SQLite writes. Parent owns independent experimental review before confirmation.

## Scoped checkpoint for the parent's native window

Execution stopped at operator request on 2026-11-06. No further checks or pilots follow this checkpoint. Consumers remain at 132bd8f7; owner closure 89e6ead changes its record only. Peer UI commits and staged edits remain peer-owned.

The six matched catalogue pilot units (three cases, seeds 11/12) all meet <=10% maximum physical error and <=1.5 normalized unseen RMSE. Diagnostic RMSE ranges 0.9564–1.0172. Median paired reduction versus no update is 92.545%; versus uniform random it is -0.00346%, so the predeclared 10% random-control usefulness target is NOT demonstrated. Two seeds are not confirmation and no significance or generalization claim follows.

The real offline research CLI accepted the prechosen useful edit and rejected the harmful edit on seed11. Final audit on pilot seed12 improved correct outcomes from 1/2 to 2/2; the rejected edit scored 0/2 in its separately labeled post-selection audit. This checks scripted orchestration, not autonomous discovery or held-out rollback. Four local proposal investigations (oscillator/thermal, seeds11/12) passed approval/attachment/fresh-interpreter resume, public workbook verification and post-reveal refusal; estimates (rtol1e-9/atol1e-11), action sequences and counters match uninterrupted references. Immediate Investigation attachment retry refused without extra records; no HTTP idempotency or cross-language proof is claimed.

Fresh bounded checks: 31 offline consolidated-training/lifecycle tests and 2 proposer-boundary tests passed. Asset and Modal-binding files had 2 collection errors because installed tokenizers is absent; no skip/pass credit. An overlapping core shard was deliberately terminated (exit-15) and gets no pass credit. Raw failed training reports contain reveal records; the now-tested proposer boundary removes those and evaluator-only diagnostics while keeping training score feedback.

The initial negative-control harness retained 16 completed rows across seeds11/12: short-only ambiguity and unavailable validation remained inconclusive; 50% MCAR oscillator/thermal rows met recovery targets. Both full negative-control commands then failed in reporting with KeyError C when empty training produced no estimate. Empty training was accepted by Investigation and wrote a failed outcome instead of refusing before persistence. That product behavior remains a concrete uncorrected negative-control finding. Train-all-missing and independent two-timescale controls were not reached. The committed harness now records absent estimates and asserts all negative-control results after retaining rows; this small reporting/assertion revision was AST-checked but NOT rerun after the resource-release request. The first executed capsule remains frozen separately. No thresholds, seeds or scientific goldens changed.

No native/Deno/browser test or build ran. The retained native receipts match all current SDK Rust/test/golden inputs, but daemon compiler inputs differ at src/login.rs, src/scripts.rs, src/server.rs, src/train.rs and login/system-boundary tests. Existing x86_64 artifacts cannot qualify changed code on ARM64 rwc-dev-01. Q1 native training lifecycle, Q2 Deno/current-tour lifecycle, G1 login/deep-link/access-poll qualification and actual paired daemon/cross-writer experiments remain. No complete E2E or SDK campaign closure is claimed.

Evidence is about 20.7 MB on rwc-dev-01, with attempts, logs, workbooks, noisy held-out trajectories, candidate digests, source capsule and partial-metrics.json. Interpreter3.12.3 uses existing NumPy2.5.4/SciPy1.18.1/pytest9.2.0, unlike the earlier owner SDK environment NumPy1.26.4/SciPy1.11.4. No installs, providers, live training, model acquisition, consumer ref changes, native builds or services were performed. Parent takes custody of the partial pilot and independent experimental review before any confirmation. Confirmatory101..105, selection201..205 and final901..905 remain untouched.
