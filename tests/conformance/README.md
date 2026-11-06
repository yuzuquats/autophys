# Shared workbook and scientific fixtures

Rust and Python implement the same [workbook format](../../autophys.project.docs/content/workbook-format.md).
These shared inputs check record interchange and numerical results; the
[numerical guide](numerics/README.md) explains tolerance-based science checks.
Discover the current inventory from the repository root, without regenerating:

```sh
git ls-files tests/conformance tests/vectors sdks/rust/src/models/fixtures
```

| Inputs | Writer / ownership | Readers and meaning |
| --- | --- | --- |
| `python/*.ap-workbook` + sibling JSON | `sdks/python/tests/conformance_cases.py` | Rust `sdks/rust/tests/conformance.rs` and Python `sdks/python/tests/test_conformance.py`: format, records, heads, projections and rebuild integrity. |
| `rust/*.ap-workbook` + sibling JSON | Rust `sdks/rust/tests/conformance.rs` | The same paired readers; Rust generation also verifies its generated temporary cases. |
| `python/thermal-curves-{initial,fit}.json` and `thermal-curves-reveal` workbook | Python workbook generator | Rust `curves_reveal.rs`, Python `test_curves_reveal.py`: curve payloads and measurement/reveal behavior. |
| `numerics/<model>/*.json` | `sdks/python/tests/numerics_cases.py` | Rust `numerics.rs`, Python `test_numerics_conformance.py`: explicit inputs, scientific outputs and declared comparison rules. |
| `../vectors/chain.json` | Canonical record-format reference vectors | Rust `vectors.rs`, Python `test_conformance.py`: exact canonical JSON and hash bytes. |
| `reasoner/spark-oscillator.jsonl`, `reasoner/prices.json` | Retained offline cassette and price inputs | Rust `conformance.rs`/`usage.rs`; Python `test_muse.py`, `test_replay_boundary.py`, `test_research.py`. Python workbook generation creates a separate current offline cassette via `reasoner_cassette.py`. Replay identity/usage are distinct from a live provider run. |
| `sdks/rust/src/models/fixtures/python.json` | Private Rust numeric reference; `generate.py` beside it | Rust `numerics.rs`; this is separate from the shared numerical corpus. Generator requires an exported Python SDK copy on PYTHONPATH. |
| `sdks/rust/src/models/fixtures/display/*.json` | Same private generator, explicitly `--display` | Rust `display.rs` and Python `test_display.py`: canonical built-in display metadata bytes. `--display` does not rewrite `python.json`. |
| `sdks/python/tests/candidate_after_reference.json` | Python-owned candidate/outlook reference | Rust `candidate_outlook.rs` and Python `test_candidate_outlook.py`; not a workbook golden. |

Workbook families include thermal validation, oscillator proposal editing,
events/canonical values, thermal curves/reveal and reasoner replay on the Python
side; events/values, multiple investigations and reasoner replay on the Rust
side. Enumerate files rather than relying on a fixed case count. Both workbook
readers discover committed workbooks; Rust also requires the Python
thermal/oscillator/events/reason-replayed cases. The numerical reader rejects a missing or empty
shared corpus.

SQLite goldens are self-contained DELETE-journal, vacuumed files. Readers copy
mutable workbook inputs to temporary locations before opening/rebuilding them,
so ordinary checks do not write WAL/SHM files beside committed goldens. Sibling
JSON describes its own workbook's random ids and timestamps; byte regeneration
changes those identities. Canonical-chain and display comparisons are exact;
numerical comparisons use the declared tolerances, sets or sign equivalence.
None of these inputs alone proves independent scientific validation.

## Explicit regeneration only

With the [contributor environment](../../CONTRIBUTING.md) active, these are
maintainer commands, not prerequisites for ordinary checks. Review the resulting
fixture diff; never regenerate merely to make a reader pass.

From `sdks/python`:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python tests/conformance_cases.py ../../tests/conformance/python
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python tests/numerics_cases.py
```

From `sdks/rust`, Rust-owned workbook regeneration is explicitly opt-in:

```sh
AUTOPHYS_WRITE_GOLDENS=1 cargo test --test conformance -- --exact the_generator_writes_self_consistent_cases
```

`AUTOPHYS_WRITE_GOLDENS_CASE=<case>` narrows that writer. Ordinary Rust generator
checks write into temporary directories instead. The private `generate.py`
requires an exported Python SDK source input, as stated in its header; select
`--display` only for display regeneration. Chain vectors, replay cassettes and
prices have no blanket regeneration command here: preserve their contract and
provenance and change them deliberately with their consumers. No fixtures were
regenerated for this documentation refresh.
