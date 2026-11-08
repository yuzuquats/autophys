# Field test of v0.1.1: triage and fixes

The operator's local notes in `issues/` (gitignored) record a first-experiment
evaluation of the published `v0.1.1` macOS arm64 release with workbook 12
(synthetic battery world). The fitting math scored correct throughout; the six
gaps are in serving, recorded provenance, templates and error surfaces. This
page tracks what was verified against master and what has been fixed.

| # | Gap | Verified on master | State |
| --- | --- | --- | --- |
| G1 | A collection outside the server DB's registered `local` root serves 403 JSON on `/app` after a "ready" start | yes, `src/workspaces.rs:191` | open; decided (G1-DB): the server DB default follows the collection; explicit mismatches fail at startup, HTML error on `/app` |
| G2 | Workbench says "uncertainty not recorded or unbounded" for parameters the record says are identified | yes, and wider than filed (below) | **fixed** (decision UNC-1) |
| G3 | battery-fit template hard-codes project `battery_cycler_demo` | yes, `examples/battery-fit.demo/python/closed_loop.py:103` | open |
| G4 | CLI failures print the command schema before the error | the help block comes from vendored `tento-lisp-cmd` | open; the fix belongs in tento, with a `vendor/patches` patch here |
| G5 | Missing input file gives a Python traceback in `battery_fit.py` | yes, `read_csv` | open |
| G6 | Workbench timestamps are UTC only | yes, `html/client/wire.ts` `when()` | open; decided (G6-TZ): local time with zone, UTC on hover |
| G7 | Python settings holding numpy arrays fail in the record digest at investigation start, unnamed (workbook 15) | yes, `sdks/python/src/autophys/data.py:86` | open; decided (G7-VAL): validate at construction with a named error |
| G8 | A validation observation that reuses the train settings crashes `validate_predictions` (workbook 15) | not yet checked | open |

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

Remaining: G1, G3–G8 above (decisions below). The Identifiability card still has no singular
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
| G1-DB | `autophys serve`'s server database default follows the collection the way the collection does (`--collection`, else `$AUTOPHYS_HOME`, else `~/autophys`). `~/autophys` keeps today's app-data `server.db`; any other collection gets its own server DB under the app data directory, keyed by the collection path, so `AUTOPHYS_HOME=<dir> autophys serve` works as the template's hint says. An explicit `--server-db`/`$AUTOPHYS_SERVER_DB` whose pinned local root differs fails at startup with a message naming the fix, and `/app` errors render as an HTML page. The per-DB root pin in `src/workspaces.rs` is unchanged. Alternative: one global DB with a fail-fast message only (smaller; the documented flow would still need a flag). Reversal: restore the single default path; becomes expensive once released, since users then hold keys in per-collection DBs | not started |
| G7-VAL | Python experiment settings must be JSON values: `Simulator` (catalog) and `Observation` construction validate them and raise an error naming the experiment and setting, with the `.tolist()` fix. No automatic numpy conversion, because a converted setting would be an ndarray live but a list on replay, and float32 grids would hash differently. Loosening later to exact-type conversion stays backward compatible | not started |
| G6-TZ | Workbench timestamps show local time with the zone (`Nov 7 16:30 PST`) and the UTC value on hover; tests pin a time zone | not started |
| BUILD-1x | The workspace rule that repo `target/` dirs are symlinks into `~/ssd-mount/cargo-target/` should apply only to rwc-01 (yuzuquats has no external scratch volume), and repo `target/` caches should be tracked in the tento-scratch ledger. Handed off to the fleet/tento-scratch thread; nothing changes in autophys | handed off |
| CLEAN | Approved and done: deleted `~/target.web.modules`, `~/tento-lona-js` and `~/.cache/autophys/target.web.modules` on yuzuquats (no callers, no open files at deletion) | done |
