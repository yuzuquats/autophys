# Deploy-gate test investigation — 2026-11-04

The clean export of baseline `d628193` passes Rust (194 tests, 2 ignored)
and Python (620 tests, 6 skipped), but Deno has 64 passed / 10 failed.
Nine assertions still expect the pre-UI-26 sidebar; the tenth detects that
`205e478` dropped the revealed Ground truth node previously added by `26517ca`.
All ten have existing live-tree draft corrections in controller.deno.test.ts,
daemon.deno.test.ts, derive.deno.test.ts, render.deno.test.ts and derive/tree.ts.
The operator explicitly directs those hunks to remain with their owners:
this workstream neither commits them nor writes competing fixes.

`000a021` is only on train/cli; master has patch-equivalent `205e478`, sharing
Change-Id If6028d04b9a343c63179. No history was moved or rewritten.

During the investigation, another session committed `d051f8c`, adding
client/sign-in-in-place.ts. The live Deno gate then reported 81 passed / 1
failed: `client boundary: no DOM, storage or network outside api.ts`.
A clean export of committed HEAD reproduces that failure. There was no draft
in the sign-in module addressing it.

The fix moves the unchanged sign-in helper to routes/sign-in-in-place.ts and
updates its composition-root import. The route layer already owns DOM and
browser session integration; the client remains DOM-free. No boundary test
is weakened. The live Deno gate passes all 82 tests after this fix, using the
other sessions' existing sidebar drafts; this does not establish a passing
clean master. The ten sidebar failures remain blocked on their owners.

An extra root type-check found a separate readonly-tuple callback error in
ui/state-markup.ts. It is not a deploy-test failure; its disposition and the
post-commit clean-export results are recorded in the external receipt.

Evidence: rwc-dev-01:~/workspace/fleet/evidence/autophys/deploy-gate-tests-20261104-fe56c0cc/
contains full logs, test-to-draft hunk mappings and final gate counts.
Temporary clean git-archive inputs are under the CLI-created scratch entry
/tmp/autophys-gate-20261104/autophys-tests-fe56c0cc699a43cfb5da62bd8d9390f2.scratch-entry/.
No supported task-board CLI was available; its plan is retained with evidence.
