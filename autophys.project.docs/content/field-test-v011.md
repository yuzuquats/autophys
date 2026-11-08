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
| G4 | CLI failures print the command schema before the error | yes, and on stdout: under `--json` every failure puts the plain help block where the JSON should be (`vendor/tento/tento-lisp-cmd/src/shell.rs` namespace dispatch) | **decided (operator, 2026-11-08)**: error + `--help` hint; **implemented 2026-11-08** (I16323eacf8b1a51589bb1367d8319ad6), see G4 below |
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

G1 and G3–G8 were fixed on 2026-11-08 (G4 in autophys's vendored copy; the same change is proposed to tento). The Identifiability card still has no singular
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

- **G8-LOOP** (agent-chosen, **confirmed by the operator 2026-11-08** in the third `/open-questions` pass: keep record-and-continue; implemented, I5c9e2a7f1d4b8063c5e9a2f7d1b4c8e6). Before: a grid mismatch raised out of Python `Investigation.run()` with no outcome record, while the Rust loop recorded it as the step result and continued. After: Python matches Rust; the named error is the step's result and `last_error`, the policy sees it next turn, and the run goes on to an outcome (a scripted run that cannot fix its data ends `budget_exhausted`). LOOP-PARITY extends the parity to every tool failure. Why: one behaviour across SDKs, and an attached CSV with the wrong sample count leaves a record instead of a traceback. Strongest alternative: end the run at once with status `failed` naming the observation, in both SDKs; it is quicker for a data error no action can fix, but takes the choice away from an LLM policy that could stop or ask for new data. Reversal: re-raise `GridMismatchError` in `run()` and drop its import (two lines plus two tests).
- **G8-FINISH** (operator: fix, 2026-11-08; implemented, I1d6f3a8c2e9b5074d1f6a3c8e2b9d5f0). The closing identifiability check in `_finish` (Rust: `finish`) no longer lets a simulator failure or grid mismatch escape: the run ends with its outcome, the reasons say the check could not run and why, and nothing is identified.
- **LOOP-PARITY** (operator: fix, 2026-11-08; implemented, I1d6f3a8c2e9b5074d1f6a3c8e2b9d5f0). The Python loop records any `SimulationError` (grid mismatch included) or `BoundsError` from a tool step as the step result, as Rust records any dispatch error. Pinned in Python by a run whose simulator always fails (`test_a_run_whose_simulator_always_fails_ends_with_an_outcome`) and in Rust by a simulator that fails after the last good fit (`a_simulator_failing_after_the_fit_still_ends_the_run_with_an_outcome`). Rust's `optimize_parameters` reports a simulator that fails at every point as a step error, where Python's returns a penalized fit; both now end with an outcome.
- **FINISH-WORDING** (nit from review round 5; **operator 2026-11-08: fix the wording**; implemented, I4e9a2c7f5b1d8063e4a9c2f7b5d1e8a6; also applies when no simulations were left for the check). When the closing check fails, drop "not identified by the rule" and say "guardrail: claimed identified but identifiability was not checked: …", in both SDKs. When a stop claims identification and the closing check could not run, the outcome also says "not identified by the rule" and "the rule disagrees", although the rule produced no result. The status (validated becomes inconclusive) and `identified` (empty) are right; only the wording overstates. Rust's closing check also now reports an "invalid Jacobian" (non-finite sensitivities) as a reason instead of an error; the message is kept in the outcome.
- **G3-FILE** (**operator 2026-11-08: treat the file as the target**; implemented, I6d1f8b3a9e5c2047d6f1b8a3e9c5d2b7). If `$AUTOPHYS_HOME` is an existing `.ap-workbook` file, `autophys new` refuses, naming it; `--existing` proceeds; a missing file proceeds as before. Fact behind it: both SDKs send every project to a file home (Python `client.py` `only=`, Rust `client.rs`), so the old note's "nothing regressed" understated the risk. Before: with `$AUTOPHYS_HOME` naming a single `.ap-workbook` file, the `new` name check never fired.
- **HOME-SLASH** (from review round 7; pre-existing; **decided by the operator 2026-11-08** in the fourth `/open-questions` pass: ignore the trailing slash, so the `.ap-workbook` suffix alone marks a workbook file in every SDK; implemented in ac0d3c6 and deployed with c0321a0: trailing slashes are stripped in Rust `connect` and in `autophys new`'s `check_new_name`, with tests; Python already behaves this way. Rejected: a slash means a folder (Python would have to read the raw text, and folders named like workbooks stay possible), and refusing the path (an error over a typo). Reversal: drop the strip; two small edits). A home written with a trailing slash (`…/x.ap-workbook/`) is a file home to Python (`pathlib` drops the slash) but a collection folder to Rust and to `autophys new`'s check, so the G3-FILE refusal does not fire for it. Making the SDKs agree (strip the slash in Rust, or keep it in Python) is the fix. A folder named `*.ap-workbook` gets its own refusal without the `--existing` advice.
- The penalty kept for real solver failures is now pinned by one test per SDK (`a_solver_failure_at_every_point_is_penalized_not_raised`).

### Fourth `/open-questions` pass, 2026-11-08 (after the c0321a0 deploy)

- **HOME-SLASH**: ignore a trailing slash (above); implemented and deployed in c0321a0.
- **G4** (decided by the operator, 2026-11-08; **implemented 2026-11-08**, I16323eacf8b1a51589bb1367d8319ad6; see "G4 as implemented" below). Before: when an autophys command fails, the vendored `tento-lisp-cmd` namespace dispatcher prints a plain `Name/Description/Options` block with `println!` to **stdout**, before the error, on every failure including runtime errors. So `--json` failures put text where the one JSON value is promised (`cli.md`: "`--json` keeps stdout one object"). Exit codes were already right (1 runtime, 2 usage). Decision: **error + `--help` hint**. Every failure leaves stdout empty and prints the error as one line on stderr; an argument error adds "Try `autophys <cmd> --help`"; full options come only from the rich `--help` (`command.doc/v1`), which is a separate path and unchanged. This matches bash and tsh's own built-ins (`tsh -c 'ls /missing'` prints one stderr line and leaves stdout empty), so it cannot regress tsh's bash conformance (`tsh/tools/src/conformance.rs` covers the built-ins, which never reach this dispatcher). Scope: a recorded patch to autophys's vendored copy under `vendor/patches`, plus the same proposal to tento's owners (corrected after measurement: installed tento tools on yuzuquats, rwc-03, rwc-05 and rwc-dev-01 never reach the block today; only source builds with nested command groups do, such as `tento-fleet tree node`; ux-test would lose its automatic options list on runtime failures, which is their call). Includes **G4-FLAG** (corrected: the earlier claim that `autophys train --bogus` reads `unknown command "autophys train --bogus"` came from a capture loop that passed the words as one argument). The real cases: `autophys train --bogus` printed `a train subcommand is required` plus the whole train usage; `autophys verify x.ap-workbook` printed `param without option` after the stdout block. Under the same rule both name the flag or word and point at that command's `--help`. Rejected: moving the full plain block to stderr (keeps two different help renderings), and fixing tento first (delays autophys's `--json` fix by a cross-host cycle). Reversal: drop the vendor patch.
- **G4 as implemented** (2026-11-08, I16323eacf8b1a51589bb1367d8319ad6). The operator first reviewed before/after captures for autophys (13 cases) and for five tento tools (22 cases, on a throwaway tento build), and checked the shape against common CLIs: kubectl, cargo, docker, git, gh and argparse all report a bad flag on stderr only, most as one line plus a `--help` pointer. Now: `vendor/patches/autophys-cli-errors/` adds `Scripts::without_usage_on_failure()` (autophys sets it on the root and the five groups) and one-line argument errors in `tento-lisp-cmd`; `src/cli_error.rs` is the single failure formatter (`autophys: REASON`, plus ``Try `autophys CMD --help` for the options.`` for usage errors, where CMD is `records` or `train dataset`; the root's hint for an unknown command). Messages in the existing `REASON\nusage: ...` convention keep only the reason, so `train dataset --bogus` and admin usage errors are one line too. `serve`, `whoami`, `train` and admin say `unknown option "--x"` for a flag (was `unknown argument`, `unknown flag`, `unexpected argument`). Exit codes unchanged (2 usage, 1 runtime). `--help` output unchanged. Test: `tests/cli.rs` `failures_are_one_stderr_line_with_a_help_hint_and_no_stdout` (nine cases, stdout empty, exact stderr); `tests/http.rs` now expects the one-line group error. Not covered: typos that a command accepts silently, and commands that validate their own words without the usage convention, which stay one-line runtime errors without a hint. Review round 9 (GLM): the hint skips flags, so `autophys --json records --bogus` names `records` (was `--json`; the reviewer's `help records --jsn` case cannot occur, since any `help`/`-h` prints that command's help and exits 0); only `usage: autophys` text is treated as usage, so another program's `usage:` quoted in a runtime error is kept whole.
- **G4-BARE** (**operator 2026-11-08: align it**; implemented). Bare `autophys` with no command now prints `autophys: a command is required` plus ``Try `autophys --help` for the commands.`` on stderr, exit 2, like every other failure; the full usage is `autophys --help`. Before: the whole usage block on stderr. The agent had first kept the old block (stderr only, and git, cargo, kubectl, docker and gh treat a bare call as asking for help); the operator chose consistency. Pinned in `tests/http.rs` `binary_lists_its_subcommands`.
- **FLAKE** (decided by the operator, 2026-11-08: stress it first; **run 2026-11-08: passed 800/800**, 400 at 10 parallel and 400 more at 10 parallel alongside the full Rust suite; not reproduced, so the hypothesis below stays unconfirmed and the test is unchanged). `connect_with_json_keeps_stdout_one_object` (tests/user_cli.rs) failed at `pair approve` twice (first Linux build of 4910701; about 1 in 90 runs under load), and every isolated rerun passed. Unconfirmed hypothesis: the test takes the pairing code from the last word of the *first* stderr line, so any earlier warning line would hand approve a wrong code. Plan: loop the test a few hundred times under load on yuzuquats, keeping the host above the disk floor and yielding to other builds; the 090512e diagnostics print the parsed line and approve's output; fix what a real failure shows. If it never reproduces, report that rather than guess. Rejected: hardening the parse now without evidence, and waiting for a natural failure.
- **PEER-PUSH** (decided by the operator, 2026-11-08: push it). The other session's unpushed `Record the v0.1.3 release and deployment` (I7a3c9e5b1d8f2046a7c3e9b5d1f8a2c4, release.md only) goes out unchanged with this thread's next fast-forward push, so the published release notes match the deployed release.

