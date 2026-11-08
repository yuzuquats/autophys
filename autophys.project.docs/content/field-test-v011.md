# Field test of v0.1.1: triage and fixes

The operator's local notes in `issues/` (gitignored) record a first-experiment
evaluation of the published `v0.1.1` macOS arm64 release with workbook 12
(synthetic battery world). The fitting math scored correct throughout; the six
gaps are in serving, recorded provenance, templates and error surfaces. This
page tracks what was verified against master and what has been fixed.

| # | Gap | Verified on master | State |
| --- | --- | --- | --- |
| G1 | A collection outside the server DB's registered `local` root serves 403 JSON on `/app` after a "ready" start | yes, `src/workspaces.rs:191` | **fixed** (G1-DB; I3b8e5d1f0a7c4e29b6d2f8a1c5e0b7d4, hint I9c4a7e2b5d8f1036a2e9c7b4d1f8a5e3) |
| G2 | Workbench says "uncertainty not recorded or unbounded" for parameters the record says are identified | yes, and wider than filed (below) | **fixed** (decision UNC-1) |
| G3 | battery-fit template hard-codes project `battery_cycler_demo` | yes, `examples/battery-fit.demo/python/closed_loop.py:103` | **fixed**: the loop names its project from the scaffolded `pyproject.toml` (Id21fba38130f502ac39a); a second scaffold with a name already in the collection is refused (G3-NAME) |
| G4 | CLI failures print the command schema before the error | the help block comes from vendored `tento-lisp-cmd` | open; the fix belongs in tento, with a `vendor/patches` patch here |
| G5 | Missing input file gives a Python traceback in `battery_fit.py` | yes, `read_csv` | **fixed**: `PATH: cannot read: …`, exit 1, in `battery_fit.py` and `closed_loop.py` (I81a2a9ef78151d5f9eae) |
| G6 | Workbench timestamps are UTC only | yes, `html/client/wire.ts` `when()` | **fixed** (G6-TZ; Ieca755c8db5f47bd0cf4); the summary caption, meta line and sidebar row hover UTC too, and the Markdown export dates in full (G6-EXPORT) |
| G7 | Python settings holding numpy arrays fail in the record digest at investigation start, unnamed (workbook 15) | yes, `sdks/python/src/autophys/data.py:86` | **fixed** (G7-VAL; I88750988bbd92554128af9d8730f0bb3) |
| G8 | A validation observation that reuses the train settings crashes `validate_predictions` (workbook 15) | yes, `agent.py` `tool_validate_predictions` | **fixed** (G8-ALIGN; Ie8f4d0d56bb77ae8e4e0c53e9549ee4f) |

## G2: what was wrong

Checked against the real record `inv_c51194ac2a68ef19` in yuzuquats'
`~/autophys/battery_cycler_demo.ap-workbook`. Both SDKs compute a full
`SensitivityReport`, including `marginal_log_std` per parameter, but the
`analyze_sensitivity` step result recorded only `condition_number`,
`identified`, `non_identified` and `non_identifiable`. The browser maps that
summary to `fit.identification` (`wire.ts`), while daemon fits always have
`sensitivity: null`. The finished-investigation summary line read only
`fit.sensitivity`, so every free parameter of every daemon-recorded fit read
"uncertainty not recorded or unbounded", contradicting the recorded verdict.
The Parameters table showed no tag at all for the same reason.

## G2: the fix

- Both SDKs add `marginal_log_std` to the recorded `analyze_sensitivity`
  result: one-sigma log uncertainty per parameter, `null` where the report has
  `inf` (the parameter loads on a non-identifiable direction), so records stay
  strict JSON.
- `wire.ts` reads it into `fit.identification.marginal`, keeping only finite
  numbers; older records simply lack the key.
- `derive/shared.ts` `certaintyOf(fit, name)` answers fixed / identified (with
  std when known) / ridge / unknown from the full sensitivity result or the
  recorded summary. The summary line, the Parameters table and Details'
  "Where it stands" use it. Old workbooks now say "identified; uncertainty not
  recorded" or "not identified"; new ones show `±x%`.

Validation: `deno check` and `deno test` over `html/` (130 passed, including a
new summary test and the extended daemon wire test); the Python SDK suite and
the Rust `curves_reveal` test with new assertions on the recorded marginal.

Follow-up (same day): the Report download (`controller.ts` `reportText`) read
only the full sensitivity result, so for daemon fits it had no fit or
parameter lines; it now writes the fit line, each free parameter through
`certaintyOf` (± and identified, "identified; uncertainty not recorded", or
"not identified") and the condition. The Identifiability card replaces its
one-line "Identified: … Not identified: …" text with a per-parameter table
(identified / not identified tag and ±) and an "n of m identified" caption.
Checked on a fresh simulated battery loop served by a scratch daemon: round 1
shows C1 and R1 not identified, round 2 all three identified with C1 ±0.84%,
R0 ±0.39%, R1 ±0.67%. `deno test` over `html/`: 131 passed.
A free parameter in neither recorded list (a step attached to a fit with a
different free set, or a hand-written record) reads "identification not
recorded" in the Report and gets a grey "not recorded" tag in the card; the
note about missing singular values is a muted line, not a missing-data block.

Remaining: G4 (its fix belongs in tento's command library). G1, G3 and G5–G8 were fixed on 2026-11-08. The Identifiability card still has no singular
values or directions for daemon fits; recording them is a separate choice.
A fit's ± no longer depends on the policy running a separate
`analyze_sensitivity` step: `analysis.identify_every_fit` (default on) checks
every adopted fit and records it with that fit's step (decision ANA-1, which
replaces the open UNC-2). Workbooks recorded before it still read
"uncertainty not recorded". A fit whose check was skipped says so with the
SDK's reason ("simulation budget exhausted", or the check's failure): "not
checked" in the summary, Parameters and Report, and a "Not checked" note with
the reason on the Identifiability card and in Details.

## Operator decisions, 2026-11-08 (`/open-questions` in the autophys/issues thread)

| ID | Decision | Implementation |
| --- | --- | --- |
| UNC-1 | Confirmed: keep recording the per-parameter summary (± and verdicts), not the full singular values and direction vectors, which would add a matrix to every fit now that ANA-1 checks every fit (also recorded in [decisions.md](decisions.md)) | built |
| G1-DB | `autophys serve`'s server database default follows the collection the way the collection does (`--collection`, else `$AUTOPHYS_HOME`, else `~/autophys`). `~/autophys` keeps today's app-data `server.db`; any other collection gets its own server DB under the app data directory, keyed by the collection path, so `AUTOPHYS_HOME=<dir> autophys serve` works as the template's hint says. An explicit `--server-db`/`$AUTOPHYS_SERVER_DB` whose pinned local root differs fails at startup with a message naming the fix, and `/app` errors render as an HTML page. The per-DB root pin in `src/workspaces.rs` is unchanged. Alternative: one global DB with a fail-fast message only (smaller; the documented flow would still need a flag). Reversal: restore the single default path; becomes expensive once released, since users then hold keys in per-collection DBs | implemented |
| G7-VAL | Python experiment settings must be JSON values: `Simulator` (catalog) and `Observation` construction validate them and raise an error naming the experiment and setting, with the `.tolist()` fix. No automatic numpy conversion, because a converted setting would be an ndarray live but a list on replay, and float32 grids would hash differently. Loosening later to exact-type conversion stays backward compatible | implemented |
| G6-TZ | Workbench timestamps show local time with the zone (`Nov 7 16:30 PST`) and the UTC value on hover; tests pin a time zone | implemented |
| BUILD-1x | The workspace rule that repo `target/` dirs are symlinks into `~/ssd-mount/cargo-target/` should apply only to rwc-01 (yuzuquats has no external scratch volume), and repo `target/` caches should be tracked in the tento-scratch ledger. Handed off to the fleet/tento-scratch thread; nothing changes in autophys | handed off |
| CLEAN | Approved and done: deleted `~/target.web.modules`, `~/tento-lona-js` and `~/.cache/autophys/target.web.modules` on yuzuquats (no callers, no open files at deletion) | done |
| G8-ALIGN | Settings are model-specific, so the SDK cannot know which setting is a sample grid. Every place a prediction is lined up with an observation's samples (`validate_predictions`, fit residuals, synthetic test RMSE) checks the lengths first and raises `GridMismatchError` naming the observation, both lengths and the fix ("give this observation settings whose grid matches its own samples"), instead of an `IndexError`. Nothing is re-predicted on the observation's own `t`, which would hide the mismatch. Rust already returned a (less specific) error. Open consequence: `fit()` treats any `SimulationError`, including this one, as a failed trial point, so a *training* observation with a mismatched grid still yields a failed fit rather than the named error; re-raising it needs the same change in both SDKs. Reversal: drop the check; the old `IndexError` returns | **confirmed with a change (operator, 2026-11-08): see G8-TRAIN** | implemented for validation and test scoring |

### Second `/open-questions` pass, 2026-11-08 (after the d658192 deploy)

| ID | Decision | Implementation |
| --- | --- | --- |
| G8-TRAIN | **Operator: stop the fit on a grid mismatch.** `fit()` re-raises `GridMismatchError` instead of scoring the trial point with the failed-residual penalty, in both SDKs (Rust gains a matching error variant). A grid mismatch depends on the data, not the parameters, so no other trial point can fix it; real solver failures keep the penalty | implemented (I6b2e9d4a8c1f7053e2b9d6a4c8f1e7b5) |
| G3-NAME | **Operator: `autophys new` refuses a project name the collection already has**, naming the collection and offering an explicit flag to join the existing project. Deliberate sharing (one project fed from two machines) stays possible; a hand-copied scaffold folder is not caught | implemented (I9e4c1a7f3d8b2065c4a1e9f7d3b8c2a6) |
| G6-EXPORT | **Operator: the Markdown export writes the full local time and UTC**, e.g. "2026-11-08 03:12 PST (11:12 UTC)". On screen, the summary caption/meta and the sidebar rows gain the UTC hover the other labels have | implemented (I3c8a5e1d9f2b7046c8e5a1d3f9b2c7e4) |

Review (GLM, round 3) found no blockers. Open follow-ups, not built:

- **G8-LOOP** (agent-chosen, pending operator review; implemented, I5c9e2a7f1d4b8063c5e9a2f7d1b4c8e6). Before: a grid mismatch raised out of Python `Investigation.run()` with no outcome record, while the Rust loop recorded it as the step result and continued. After: Python matches Rust; the named error is the step's result and `last_error`, the policy sees it next turn, and the run always ends with an outcome (a scripted run that cannot fix its data ends `budget_exhausted`). Why: one behaviour across SDKs, and an attached CSV with the wrong sample count leaves a record instead of a traceback. Strongest alternative: end the run at once with status `failed` naming the observation, in both SDKs; it is quicker for a data error no action can fix, but takes the choice away from an LLM policy that could stop or ask for new data. Reversal: re-raise `GridMismatchError` in `run()` (one line plus two tests).
- **G3-FILE.** With `$AUTOPHYS_HOME` naming a single `.ap-workbook` file instead of a collection, the `new` name check never fires. The SDKs treat that configuration as an empty collection as well, so nothing regressed.
- The penalty kept for real solver failures is now pinned by one test per SDK (`a_solver_failure_at_every_point_is_penalized_not_raised`).
