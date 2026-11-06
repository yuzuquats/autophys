# Can the inner research loop turn measurements into useful, honest conclusions?

Status: live predeclared protocol, revision 1 scientific design; integration gates
updated 2026-11-06. No pilot, confirmatory run, provider invocation or experiment
harness execution is established by this consolidation. The scientific seed schedules,
thresholds and matrix are unchanged from the original 15,783-byte design.

The canonical source is yuzuquats:/home/james/workspace/autophys master. Independent
completeness review must verify adoption and retained ancestry before the parent
aligns consumers. Then qualify the changed native code from that exact unified source
under a separately authorized resource phase. Rust parsing is not a typecheck and the
currently deployed older native binary is not evidence for this candidate. Freeze the
qualified source digest and any later harness changes before pilot or confirmation.
The present executor runs no experiments and performs no native/Cargo/Deno build.

The actual product boundary

Owner fad6b86d257f363ed7e1aaa182e474abe8b556f5 has:
- synthetic.py: CaseView / SyntheticRunner separate measurements from Evaluator truth.
  observe generates at tighter TRUTH_OPTIONS than the fitting solver.
- agent.py: Investigation.run dispatches fitting, sensitivity, ranking, requests,
  comparison, validation and stopping. ProposalRunner returns awaiting_data;
  approve/attach_data/resume implement the laboratory handoff.
- bench.py: run_case writes real workbook records, then evaluator.reveal; the
  heuristic FakeReasoner consumes rendered diagnostics, not the evaluator object.
- research.py: research evaluates the initial strategy and proposed strategies on
  training seeds, keeps lexicographically better scores, then evaluates initial/final
  strategies on disjoint held-out seeds. The scripted researcher supplies known edits.

Two source-level limitations matter before any experiment:
1. research.py:evaluate adds all records of failed runs to failing_transcripts AFTER
   run_case has appended a reveal. proposal_prompt retains that payload, including
   synthetic truth, when it sends the report to a researcher. Inner-policy truth
   separation does not establish outer-researcher truth separation. Check this explicitly;
   a harness wrapper may redact reveals before a future data-driven proposer, but must
   report that it adds a boundary absent from the default product path.
2. research() uses improves() on training scores and checks held-out results only at
   the end. It does not reject/rollback a candidate because of held-out failure.
   paired_bootstrap exists separately. Do not claim research() has an independent
   validation acceptance gate merely because its final summary has held-out scores.

Those are inspection findings, not reproduced test failures. They may change before
execution; pin and recheck actual source. Existing tests test_research_planted.py
exercise scripted edit selection on a known biased-battery problem. They are useful
integration tests, not proof that an LLM independently discovered a scientific fix.

Claims and measurements

Primary claim: a diagnostic-driven offline policy can recover identifiable physical
quantities and improve unseen predictions by choosing an informative measurement.
Secondary claim: the real research orchestration can accept a useful predeclared
strategy change and reject a harmful one, while preserving its records and budgets.
Negative claim: underdetermination, unavailable validation or unmodeled dynamics must
not be reported as confidently validated physical parameters.

No autonomous LLM discovery, learned reasoning improvement, paid training, real-lab
performance, or population-wide generalization is claimed by offline work. Model
access is unnecessary for these mechanical/scientific tests; request concrete access
only after their results identify a question that needs it.

Predetermined schedule

Pilot only: seeds 11 and 12. Check runtime, instrumentation and generator schemas;
never include those outputs in confirmation or use final seeds to repair the protocol.
If pilot changes thresholds or scientific design, write revision 2 before using any
confirmation seed. Keep pilot artifacts and label them as pilot.

Confirmation: seeds 101,102,103,104,105 for recovery, design and negative controls.
These index independent noise and generator draws, with separate RNG streams for
initial data, newly executed data, and final test trajectories.
Outer research selection uses train seeds 201..205; untouched final audit uses
901..905. Existing product research fixtures remain unchanged. Freeze candidate
texts, source hashes, generator specification and seed schedule before confirmation.
No seed substitution, threshold tuning, rerunning only favorable cases, or fixture/
science-golden modification is allowed. Every failure and timeout remains in results.

Matrix A: useful parameter recovery

Three systems: mass-spring-damper oscillator, thermal RC, battery ECM. Run 5 matched
units per system. Existing product cases give a compatibility matrix; an additional
custom CaseView matrix can perturb physical parameters within 0.8..1.2 of each
catalogue truth using a predetermined log-uniform generator. Report fixed-catalogue
and perturbed-truth results separately so repeated noise around one truth is not
sold as broad physical coverage. Custom observations use public observe, Dataset,
SyntheticRunner and Evaluator with the same real Project/Investigation pipeline;
never a fitted coefficient injected as a tool result.

For each unit run three matched arms: diagnostic/Fisher policy, no new experiment,
and uniform-random catalogue choice. Use the same initial observations and test
trajectories in each arm. Limit all arms to one newly acquired experiment for the
selection comparison. Random seed = 5000 + case_index*100 + seed; log the full
candidate set and selected name. It may select a weak or strong experiment; do not
exclude a lucky random baseline. The diagnostic policy uses rendered diagnostics,
real least-squares fits and information scores; it has no truth or final-test access.

Use held-out interventions, not another copy of the training trajectory: oscillator
unseen sine/step forcing, thermal longer power pulse, battery pulse train, matching
or extending the actual synthetic evaluator's tests. Original validation observations
are available for ordinary loop decisions; final test trajectories stay private.

A unit meets the recovery target when max identifiable-quantity relative error <=10%
and normalized test RMSE <=1.5 (RMSE divided by the declared channel sigma; aggregate
multi-channel weighted squared residuals before square root). Predeclare the catalogue
combos for zero-budget controls; do not score unidentifiable physical coefficients as
if individually estimable. Aim >=4/5 successful units in each identifiable case.

Selection usefulness target: >=25% median paired held-out RMSE reduction versus the
no-update arm, and >=10% versus uniform-random over the 15 primary case/seed units.
These are falsifiable targets, not expected scores. Report every per-case difference,
median, range, wins/ties/losses and paired bootstrap 95% interval (10,000 resamples,
fixed RNG 7001). Five seeds per case give limited power; if the interval includes no
gain, report that limitation even when a pooled point target passes. Never substitute
Fisher score improvement for measured held-out predictive improvement.

Matrix B: model discrimination and accept/reject mechanics

Run real CLI research --policy fake-reasoner --researcher scripted with cases
battery-biased and battery, train seeds 201..205, heldout seeds 901..905, iterations 2.
Initial playbook: compare_variants never. Candidate 1: compare_variants on_misfit.
Candidate 2: candidate 1 plus experiments none. Freeze their bytes/SHA-256 before runs.
Use the actual default playbook as base; create task-owned inputs outside data roots.
No evaluator stub, fake success score, canned fitted parameter, or prescribed outcome.

Record train/heldout score components, model selected, BIC differences, physical
errors, unseen RMSE, noise/sensor-offset estimates, action trace and simulation cost
for EACH unit, including the rejected candidate. The standard product research run
does not evaluate rejected candidates on heldout; add a separately labeled final
read-only evaluator pass AFTER selection is frozen to measure the harmful candidate
on the same heldout schedule. That audit never feeds selection.

Targets: useful edit retained, harmful edit rejected by actual product training rule;
>=4/5 biased-battery final units recover physical quantities within 10% and normalized
unseen RMSE <=1.5; unbiassed battery does not gain >10% median prediction error.
Independently confirm that the candidate rejected on training is harmful on heldout;
if not, report “rejected on training, harmful-on-heldout unproved.” If the useful edit
fails heldout, product's lack of automatic rollback is a finding, not a successful
independent validation gate. Prechosen edits test orchestration, not discovery.

Matrix C: honest negative controls

Five units each:
- oscillator free-only with zero experiment budget: structural scaling ambiguity;
  support c/m and k/m, refuse full independent m,c,k identification.
- thermal short-only and battery short-only: retain declared weak-parameter diagnosis;
  report usable combinations and prediction limits without claiming full recovery.
- oscillator and thermal with 50% MCAR missing samples, declared noise unchanged:
  use remaining finite samples, report effective N and uncertainty; same <=10%/
  <=1.5 target as A is an explicit robustness challenge, not assumed to pass.
- empty/all-missing training or validation: reject invalid training before writes;
  unavailable validation cannot produce validated success. Verify refusal store hashes.
- a misspecified thermal generator: independent two-timescale analytic response
  (equal weights, taus 300 s and 1800 s, total steady-state gain 2 K/W), evaluated
  through the single-RC product model with bias off and sigma 0.05 K. Initial short
  step plus longer held-out pulse tests whether validation exposes wrong dynamics.
  Record a failed or inconclusive model hypothesis as useful negative evidence.

No false “validated and fully identified” result is allowed in any structural,
missing-validation or misspecified unit (0/5 tolerance for each applicable control).
For missing-at-random data, calibrated success is allowed; failures remain visible.
For the two-timescale control there is no single true C,R to recover: report
predictive error and residual structure, not an invented physical parameter error.
If short local validation passes but final interventions fail, report that exact
failure of the stopping criterion. Do not adjust validation data to make it fail.

Matrix D: actual laboratory and artifact boundaries

Run at least five oscillator/thermal proposal investigations in fresh task-owned
workbooks. For each: fit -> analyze -> rank -> propose -> awaiting_data; close all
objects; reopen in a fresh interpreter; refuse attachment before approval without
extra writes; approve from a separate viewer connection; execute the proposal through
the blind synthetic runner; attach real observation bytes; reopen/resume; revise fit;
validate and stop. Reveal truth only after final outcome. Compare with an uninterrupted
matched reference: decisions/estimates/counts identical where numerical platform permits,
otherwise specify and record float tolerance separately from exact record replay.

Verify chains/projections with public verify; preserve raw records, config hashes,
blob hashes, proposal transitions and a normalized action log. Resume after reveal
must be refused. Test stable attachment replay/conflict through the supported public
store/HTTP API: no duplicate measurement, no half attachment, no double experiment or
test-hour charge. Do not assume Investigation.attach_data retry behavior is identical
to the record-level API; record the actual boundary exercised and any refusal.

Use the real Rust daemon in one ephemeral loopback port with task-owned collection,
server DB, credentials/config and a trivial static web root to avoid frontend builds.
No production state, registration or managed service is touched. Own the process in
a try/finally with terminate/wait/kill fallback; retain logs and verify exit/port closure.
Exercise Python write -> Rust read/verify AND Rust write/approve/attach -> Python
resume/evaluate using the same newly produced workbook, not merely checked-in shared
fixtures. Record executable source stamp and paired record/blob/config identities.
Run the actual relevant Rust numerical/remote and Python paired tests; report exact
selected/passed/skipped counts. Sharing a file alone does not prove language parity.

Offline policy usage can have unknown SDK cost_usd or synthetic token metadata.
Preserve that value; separately record zero external provider requests/billed spending.
Use real step/simulation/experiment/test-hour counters and caps (24 steps, 20,000
simulations, one selected experiment in A; catalogue 2-experiment/3-hour limits in B).
Budget exhaustion is a failure/result, not an excuse to rerun with larger caps.
Use existing interrupted-spending recovery tests as an additional invariant shard,
with real completion records and modeled billing explicitly distinguished.

Execution and artifacts after the review gate

After independent source review and reviewed consumer fast-forward, use one native
compilation from the exact unified master on rwc-dev-01 only, with separately approved
external SSD CARGO_TARGET_DIR, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS<=8 and a bounded
wall deadline. The parent must establish capacity/output limits for that later phase;
the executor's 8 MiB total source-only allowance does not authorize it. Leave existing
targets, Deno caches, SDK goldens, frozen artifacts, data and backups untouched. Inspect RAM/CPU and boot ID before/after; abort
confirmation on reboot, unexplained HEAD/index drift, source hash change or resource
pressure. No yuzu build or experiment allocation. The current source-only consolidation is
already authorized on yuzuquats; it does not authorize this future campaign.

Use a clean task-owned Python venv outside the checkout with numpy/scipy/pytest;
record interpreter, package versions, wheel hashes, source hashes and actual import
paths. Never reuse an older installed SDK silently. No live reasoner flags, training
CLI live flags, Modal run, provider account calls or external model download.
One machine-level experiment worker at a time; per-unit deadline 180 s, confirmatory
campaign deadline 90 minutes exclusive of native compilation; keep timed-out rows.
These are preliminary operational bounds subject to pilot revision before confirmation.

Raw data/workbooks/logs/manifests/CSV live in the ignored fleet evidence path if
verified by git check-ignore, otherwise the existing private workstream directory.
Keep exact per-unit CSV/JSON results, rejected outcomes, environment/source manifest,
reproduce commands, and standalone scientific plots of errors versus baselines,
residuals and held-out trajectories. Plot truth only in post-outcome results.
Commit only OWN protocol/harness/short result pages under Project: autophys, with a
Kind: plan cover BEFORE confirmation, after source review/native qualification and
the parent's resource gate. The existing Project: autophys consolidation plan covers
adoption of this protocol; it grants no experiment execution permission.

Proposed command skeletons (NOT executed; harness CLI to be implemented after gate):
  python -m pytest -q sdks/python/tests/test_research_planted.py
  python -m autophys.cli research --policy fake-reasoner --researcher scripted \
    --playbook INITIAL --edit USEFUL --edit HARMFUL \
    --case battery-biased --case battery --train-seeds 201,202,203,204,205 \
    --heldout-seeds 901,902,903,904,905 --iterations 2 --output-dir FRESH_OUTPUT
  python PATH_TO_OWN_HARNESS --protocol FROZEN_PROTOCOL --matrix recovery,controls,approval

Return a per-case and per-seed result, not only pass counts: estimates and identifiable
ratios; mean/max errors; normalized held-out RMSE and paired improvements; uncertainty
and diagnosis; selected experiments/models; steps/simulations/test hours; usage/spend;
replay/resume and cross-language boundary proofs; all negative outcomes and exact
unresolved product limitations. Model capability and useful scientific mechanics are
separate conclusions.
