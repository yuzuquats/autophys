"""The shared conformance suite (W-4): what Python and Rust must both pass.

* ``tests/vectors/chain.json``: canonical JSON and hash-chain vectors.
* ``tests/conformance/python/``: golden workbooks this SDK wrote; every
  implementation must read them back exactly as their JSON says.
* ``tests/conformance/rust/``: workbooks the Rust crate wrote; this SDK must
  verify them.
"""

from collections import Counter
import json
import shutil
from pathlib import Path

import pytest

from autophys.store import canonical, chain_hash
from autophys.workbook import APPLICATION_ID, INITIAL_VERSION, WorkbookStore, append_payload, investigation_payload, projection_rows

import conformance_cases

REPO = Path(__file__).resolve().parents[3]
VECTORS = REPO / "tests" / "vectors" / "chain.json"
GOLDEN = REPO / "tests" / "conformance"


def test_chain_vectors():
    doc = json.loads(VECTORS.read_text())
    assert doc["vectors"]
    for v in doc["vectors"]:
        env = v["envelope"]
        assert canonical(env) == v["canonical"]
        assert chain_hash(v["prev_hash"], env["id"], env["kind"], env["payload"]) == v["hash"]


def _goldens(side):
    return sorted((GOLDEN / side).glob("*.ap-workbook"))


@pytest.mark.parametrize("path", _goldens("python"), ids=lambda p: p.stem)
def test_python_goldens_read_back_exactly(path, tmp_path):
    exp = json.loads(path.with_suffix(".json").read_text())
    copy = tmp_path / path.name  # never let a test write -wal/-shm into the repository
    shutil.copy(path, copy)
    with WorkbookStore(copy, readonly=True) as wb:
        assert exp["format"] == {"application_id": APPLICATION_ID, "user_version": INITIAL_VERSION}
        assert wb.project_name() == exp["project"]
        report = wb.check()
        assert report["ok"] and report["records"] == exp["records"]
        assert wb.heads() == exp["heads"]
        assert projection_rows(wb._conn) == exp["projections"]


def test_every_case_has_a_golden():
    assert {p.stem for p in _goldens("python")} == set(conformance_cases.CASES)


@pytest.mark.parametrize("path", _goldens("rust"), ids=lambda p: p.stem)
def test_rust_written_workbooks_verify(path, tmp_path):
    copy = tmp_path / path.name
    shutil.copy(path, copy)
    with WorkbookStore(copy, readonly=True) as wb:
        report = wb.check()
        assert report["ok"]
        records = [r for inv in wb.investigations() for r in wb.records(inv["id"])]
        for record in records:
            if record.kind == "investigation":
                investigation_payload(record.payload, record.id)
            else:
                append_payload(record.kind, record.payload, record.id)
        side = path.with_suffix(".json")
        if side.exists():
            exp = json.loads(side.read_text())
            if "records" in exp:
                assert len(records) == report["records"] == exp["records"]
            if "kinds" in exp:
                assert dict(Counter(r.kind for r in records)) == exp["kinds"]
            assert wb.heads() == exp["heads"] and projection_rows(wb._conn) == exp["projections"]


def test_generator_writes_self_consistent_cases(tmp_path, current_reasoner_cassette):
    for path in conformance_cases.write(tmp_path, replay=current_reasoner_cassette):
        exp = json.loads(path.with_suffix(".json").read_text())
        with WorkbookStore(path, readonly=True) as wb:
            assert wb.check()["ok"] and wb.heads() == exp["heads"]
