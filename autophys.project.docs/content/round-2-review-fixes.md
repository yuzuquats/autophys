# Round-2 review fixes

Scope: the unpushed autophys stack above ab1ff17; new scoped commits only.
No source push, deployment or full suites.

## R2-1: retain interrupted held-out spending

Resume now recovers retained timestamped held-out directories before any new
evaluation. It reuses each directory's persisted attempt identity, so both
completed repeat charges and individual recovered workbook charges are skipped
on later recovery. Archived attempts remain excluded; original outputs remain
available. This also covers attempts interrupted before this fix was installed.

Validation: from sdks/python,
`python3 -m pytest -q tests/test_autoloop_repeated_recovery.py`: **6 passed**.
The focused file covers interrupted training retries, single/repeated held-out
evaluations at different timestamps, and interruption after recovery charging.

Task board unavailable: the installed tsh.lona wrapper cannot find lona, and
no installed lona-console was found. Live steps and focused browser evidence
are recorded under ~/.cache/autophys/r2-implementation on yuzuquats.

## R2-2: let the drawer retain landing scroll on tour Back

First inspected `git show ab1ff17`: that commit sets native history restoration
to manual in brand.ts, but leaves guided-tour.ts's unconditional window restore
unchanged. The snapshot now restores window scroll only when the destination is
the app stage. The drawer owns the landing offset; app-internal scroll restoration
still runs.

Validation: `deno check routes/guided-tour.ts routes/index.root.ts` from html
passed. On a scratch daemon at 127.0.0.1:47970, the withHeadless browser pass
scrolled landing docs to 1100, entered the tour (window offset 0), pressed history
Back, and observed landing offset **1100** after transitions settled.
Used the requested Chromium executable and --no-sandbox. Browser and daemon
closed in finally; no page errors. No deployment or live-service changes.

The first scratch build used the existing binary's older baked-in source root;
the corrected pass rebuilt with AUTOPHYS_PROJECT_ROOT pointing explicitly to
the owner checkout. Both runs closed their children.

`cargo check -p autophys-cli` passed with existing warnings, using
CARGO_TARGET_DIR=~/ssd-mount/cargo-target-scratch/autophys-gaps.

Remaining: commit R2-3 (startup bookmark); its browser check has passed.
