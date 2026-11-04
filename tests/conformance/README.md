# Workbook conformance (W-4)

The `.ap-workbook` format (`autophys.project.docs/content/workbook-format.md`)
has two implementations, the Rust crate and the Python SDK. This directory is
what both must pass, together with the hash-chain vectors in
`tests/vectors/chain.json`.

| Directory | Written by | Every implementation must |
| --- | --- | --- |
| `python/` | `sdks/python/tests/conformance_cases.py` | open each `<case>.ap-workbook` read-only on a copy, verify every chain, rebuild the projections, and match `<case>.json`: format pragmas, project name, record count, chain heads and projection rows |
| `rust/` | the Rust crate's tests (`cargo test` in `sdks/rust`) | the same; the Python suite verifies every workbook here, and the JSON beside it when present |

The goldens are single files (`journal_mode = DELETE`, vacuumed). Tests copy
them before opening so nothing writes `-wal` or `-shm` files here. Ids and
timestamps are random: regenerating changes the bytes, and each JSON always
describes its own workbook.

Cases: `thermal-validated` (a scripted run with a direct runner),
`oscillator-edited` (an E-1 outlook, an edit within its axis, data attached,
run to the end), `events-and-values` (every proposal event and the canonical
JSON edge values: non-ASCII text, Python float repr, a u64, NaN as null).

Regenerate (on rwc-dev-01, from `sdks/python`):

    PYTHONPATH=src ~/.cache/autophys/venv/bin/python tests/conformance_cases.py ../../tests/conformance/python
