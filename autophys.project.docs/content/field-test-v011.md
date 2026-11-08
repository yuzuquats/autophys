# Field test of v0.1.1: triage and fixes

The operator's local notes in `issues/` (gitignored) record a first-experiment
evaluation of the published `v0.1.1` macOS arm64 release with workbook 12
(synthetic battery world). The fitting math scored correct throughout; the six
gaps are in serving, recorded provenance, templates and error surfaces. This
page tracks what was verified against master and what has been fixed.

| # | Gap | Verified on master | State |
| --- | --- | --- | --- |
| G1 | A collection outside the server DB's registered `local` root serves 403 JSON on `/app` after a "ready" start | yes, `src/workspaces.rs:191` | open; recommended: fail fast at startup naming `--server-db`, HTML error on `/app`, fix the `closed_loop.py` hint |
| G2 | Workbench says "uncertainty not recorded or unbounded" for parameters the record says are identified | yes, and wider than filed (below) | **fixed** (decision UNC-1) |
| G3 | battery-fit template hard-codes project `battery_cycler_demo` | yes, `examples/battery-fit.demo/python/closed_loop.py:103` | open |
| G4 | CLI failures print the command schema before the error | the help block comes from vendored `tento-lisp-cmd` | open; the fix belongs in tento, with a `vendor/patches` patch here |
| G5 | Missing input file gives a Python traceback in `battery_fit.py` | yes, `read_csv` | open |
| G6 | Workbench timestamps are UTC only | yes, `html/client/wire.ts` `when()` | open |

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

Remaining: G1, G3–G6 above. The Identifiability card still has no singular
values or directions for daemon fits; recording them is a separate choice.
