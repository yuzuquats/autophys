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

Remaining: verify and commit R2-2 (tour Back scroll) and R2-3 (startup bookmark).
