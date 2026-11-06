# Gaps found by labelling real data (`real_label.py`)

Historical stress-test report, not current qualification. The nine recorded
trajectories were inconclusive. Trajectory splits share catalog recordings and
therefore leak observations across splits; raw fenced targets may be exported.
Do not use these rows as a qualified training/held-out dataset. No recorded-data
run was repeated during consolidation. Entries 19–20 describe the old worker;
current prepared model assets remove implicit planning downloads, and SDK import
identity must still be checked for each actual environment.

Harness: `train/sft/real_label.py` replays the Pozzato, Allam, Onori 2022 M50T HPPC
windows (CC BY 4.0, local only under `~/.local/state/autophys/evidence/onori-pozzato-2022/`)
through `Investigation` + `ReasonLanePolicy`, and labels each decision step.
Run on rwc-dev-01, 2026-11-04, with the repo SDK (`PYTHONPATH=sdks/python/src`),
not the venv's older pip snapshot. Round: 9 trajectories (one per starting SOC
window), autolabelled with the scripted suggestion, exported to
`data-real-scripted/`. A second round fed deliberately bad labels (non-JSON,
unknown action, extra key, fenced JSON, a request for a window at its run limit,
malformed label-file lines) to check that nothing crashes.

Line numbers are at HEAD `f0ea40a` plus the working tree at the time.

## Ingest

1. **The CSV grid must equal the declared grid** (`sdks/python/src/autophys/mcp/measurements.py:55`).
   Each recorded window carries its own measured `t` in the catalog settings (`windows.json`),
   so the catalog is the data and a new recording means a new config version.
   Fix: accept a measured grid and resample or evaluate the simulator on it, recording the grid in the observation.
2. **Measured current can't be imported** (`mcp/measurements.py:34`: only `t` and the outputs are mapped for
   user projects). The window's current is restated as `segments` in settings by `scripts/m50t_hppc.py`.
   Fix: let `read_csv` map declared input channels into `Observation.settings` (or a `u` channel).
3. **No replay or recorded-data runner.** `tool_request_experiment` either makes a proposal
   (`agent.py:697`) or calls `runner.run(name)`. The real path (`ProposalRunner` + approve + `attach_data`)
   can't run inside `Investigation.run`. The harness uses a duck-typed `ReplayRunner` that calls `read_csv`.
   Fix: ship a `RecordedRunner(root, files)` in the SDK so a replay case uses the supported path.
4. **Runner errors other than `ToolError` crash the loop** (`agent.py:927` catches only `ToolError` and
   `SimulationBudgetExceeded`). `read_csv` raises `ValueError`, so a bad CSV would abort the whole investigation.
   The harness converts these to `ToolError`. Fix: catch runner `ValueError`/`OSError` in `tool_request_experiment` and turn them into a `ToolError`.

## Investigation

5. **The initial window doesn't count as a run, and replay can't produce new data.** Measurements passed
   to `Investigation(...)` are recorded (`agent.py:238`) but not counted in `runs_per_experiment`, so the
   starting window stays requestable. Re-requesting it would duplicate the identical recording as "new" train data.
   The harness builds a separate project per trajectory, with `max_runs` 0 for the start window and 1 for
   the others, so each trajectory has its own config version. There is no per-investigation catalog
   override (`project.py:95`; `Investigation` overrides only `free`, `agent.py:215`).
   Fix: count initial observations per experiment, or allow a per-investigation catalog/limits override.
6. **Validation data can never be obtained.** Requested data always joins train (`agent.py:712`), so a
   trajectory that starts with one window never has a validation split. All 9 trajectories end
   `inconclusive` ("validation split not passed"), and the dataset has **0** validated stops.
   Fix: a `split` argument on `request_experiment` (validation only), or project-declared validation windows.
7. **Experiment ranking is effectively a tie on real windows.** All 8 candidates score min_eig 3171 to 3173
   (`design.py:65` ranks simulated Fisher information at the current fit). The `top[0]` pick
   (`agent.py:1119`) is noise: 8 of 9 trajectories request `hppc_soc20`, and the 9th requests `hppc_soc90`.
   Training then teaches "always pick soc20". Fix: report ties (relative gain < x%) in RANKING, and have
   the teacher break them by a stated rule such as cost or distance in SOC.
8. **The model is misspecified across windows, and the loop doesn't notice.** R0, R1 and C1 are taken as
   constant over SOC. Combining two windows raises chi2/N (for example soc10+soc20: 3.3 to **19.9**). The
   only misfit reaction is `compare_models`, and that needs more than one variant (`agent.py:1108`), but
   `m50t_hppc` sets `bias="off"` (`scripts/m50t_hppc.py:46`). So the teacher still claims every
   parameter identified and stops. The guardrail checks only identifiability, not fit quality.
   Fix: make `misfit_threshold` a stop reason and a teacher branch (robust loss / inconclusive "model misfit").

## Prompt rendering / teacher

9. **The teacher never sees "no validation possible".** With `VALIDATION: current available=no passed=no`
   it still spends a `validate_predictions` step and then stops `inconclusive` with evidence
   `"validation passed=False"` (`agent.py:1122-1129`). Fix: skip the validation step and cite
   "no validation split" when none exists.
10. **Action coverage on real data is narrower than synthetic.** Targets contain no `compare_models`
    (bias off), no `inspect_data`, no validated stop, and 1 experiment per trajectory (each request
    leaves every parameter identified, so `need_more` is false, `agent.py:1114`).
    Fix: set the real project's noise model to `bias="compare"`, and teach `inspect_data` on first contact with measured data.
11. **No supported way to pause the loop at a decision.** The harness raises its own exception from inside
    `FakeReasoner.complete` (`reasoner.py:503`), and it escapes `Investigation.run` (`agent.py:894`) only
    because the loop doesn't catch generic exceptions. The step counter is already incremented and the
    store is left mid-step. Fix: a policy return value or exception the loop treats as "suspend", recorded
    and resumable via `Investigation.resume`.
12. **`FakeReasoner` doesn't pass `response_schema` to its responder** (`reasoner.py:503`). The harness
    subclasses `FakeReasoner` to record it. Fix: pass the full call (messages, schema, effort, max_tokens) to the responder.
13. **Repeated tool errors burn the step budget silently.** Only parse/validation failures count toward the
    "three in a row" stop (`agent.py:927-930`). A labeller that repeatedly requests a window at its run
    limit loops until 24 steps (seen in the bad-label round). Fix: count consecutive identical tool errors as failures.
14. **Investigation ids are random** (`store.py:276`, uuid). Prompts don't contain them, so keys are
    deterministic (two exports were byte-identical), but `finished.json` can't name a stable investigation.
    Fix: optional caller-supplied `record_id` on `Investigation`.

## Export / splits

15. **Splitting by trajectory doesn't isolate data.** `hppc_soc20` is the start of a validation trajectory,
    yet 7 train and heldout trajectories request it as train data. `real-hppc_soc20` (validation) and
    `real-hppc_soc90` (train) end on the same two-window dataset, with fits equal to within 1e-5. `build_dataset.py`'s
    seed split has no analogue for shared recordings. Fix: assign windows to splits and restrict each
    trajectory's catalog to its split's windows (or split by cell when there are more cells).
16. **The loop accepts fenced or embedded JSON, and the target keeps the raw text** (`reasoner.py:520`:
    `parse_json_content` strips fences and falls back to the outermost braces). A fenced label passes the
    loop, and `export` writes it verbatim, so SFT would teach fences. `build_dataset.py` targets are
    canonical `json.dumps`. Fix: `export` should write `json.dumps(Decision.to_dict())` and record the raw text in meta.
17. **The run manifest drops provenance.** `dataset_identity` keeps only `system_prompt_sha256`, `cases`
    and `playbook` (`src/train.rs:354`), so the data source, license and citation, labellers and label
    sha from `manifest.json` don't reach `runs/N/manifest.json`. Fix: copy `data_source` and `labels` into the identity.
18. **No closed-loop eval for real rows.** `eval_heldout.py:34,71` and `bench.run_case` only know
    synthetic `CASES`, so held-out real trajectories can only be scored one step at a time.
    Fix: register the replay case (recorded runner + project) in `bench`.

## Train CLI

19. **The "offline" dry run needs the network.** `autophys train run` (no `--live`) fails with network
    blocked: `urllib.error.URLError: [Errno 111] Connection refused`. `train_sft.py:57` fetches
    `tokenizer.json`, `patch_chat_template.py:42,46` the template and `render.py:38` the config from
    huggingface.co on every plan, with no cache. Nothing is written (the plan runs before
    `write_json`, `src/train.rs:653,677`). Fix: read from the HF cache (`huggingface_hub`,
    `HF_HUB_OFFLINE`) or vendor tokenizer and template next to `serving/*.jinja`.
20. **The venv SDK is an older snapshot.** `~/autophys-train/.venv` has a pip-installed autophys that
    differs from `sdks/python/src` (agent, bench, project, reasoner, simulator...), and `autophys train
    dataset` runs `build_dataset.py` with it. The system-prompt sha matched here (`09efc287…1802`), but
    nothing checks this. Fix: have the worker run with `PYTHONPATH=sdks/python/src`, or compare the SDK git hash in the manifest.
