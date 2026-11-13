"""Workbook format 3: the overviews table, reached only at the first overview
write (OV-1 to OV-4). Mirrors sdks/rust/tests/workbook_format3.rs; both read
the shared vectors and goldens in tests/conformance/overview/."""
import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest

import conformance_cases
from autophys import connect
from autophys import _overview_blocks
from autophys.overview import INSERTS_JSON, check_overview, decode
from autophys.store import MemoryStore, config_hash
from autophys.workbook import (_OVERVIEWS_DDL, DISPLAY_VERSION, MAX_OVERVIEW_BYTES, OVERVIEW_VERSION, SCHEMA_VERSION,
                               WorkbookError, WorkbookStore)

ROOT = Path(__file__).resolve().parents[3]
SHARED = ROOT / "tests" / "conformance" / "overview"
CASES = json.loads((SHARED / "cases.json").read_text(encoding="utf-8"))
MANIFEST = b'{"format":1,"title":"toy"}'
# Rust error codes in cases.json, as WorkbookError codes.
CODES = {"invalid_payload": "invalid", "payload_too_large": "too_large"}


def raw(path):
    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = {n: s for n, s in conn.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")}
        return version, tables
    finally:
        conn.close()


def workbook(path):
    wb = WorkbookStore(path)
    return wb, wb.ensure_project("toy")


def with_investigation(wb, pid):
    config = {"physics": True}
    version = config_hash(config)
    wb.put_config_version(pid, version, config)
    return wb.create_investigation({"project_id": pid, "config_version": version})


def markdown_of(case):
    if "markdown_repeat" in case:
        text, n = case["markdown_repeat"]
        return text * n
    return case["markdown"]


def test_versions():
    assert (SCHEMA_VERSION, DISPLAY_VERSION, OVERVIEW_VERSION) == (3, 2, 3)
    assert MAX_OVERVIEW_BYTES == CASES["max_bytes"] == 256 * 1024


def test_the_insert_list_is_the_viewers_byte_for_byte():
    # Python needs its own package-data copy; the canonical file is the UI's.
    assert INSERTS_JSON.read_bytes() == (ROOT / "html" / "ui" / "investigation-inserts.json").read_bytes()


def test_a_display_write_stops_at_format_2_now_that_the_current_format_is_3(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    assert wb.put_display(pid, MANIFEST)[1]
    version, tables = raw(path)
    assert version == 2, "display upgrades to exactly 2, not to SCHEMA_VERSION"
    assert "display" in tables and "overviews" not in tables
    wb.close()


@pytest.mark.parametrize("display", [False, True])
def test_reading_an_overview_never_creates_the_table_or_changes_formats_1_and_2(tmp_path, display):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    if display:
        wb.put_display(pid, MANIFEST)
    wb.close()
    before = (raw(path), path.read_bytes())
    for readonly in (False, True):
        with WorkbookStore(path, readonly=readonly) as again:
            assert again.overview(pid) is None
            assert again.overview_versions(pid) == []
            assert again.check()["ok"]
    assert (raw(path), path.read_bytes()) == before
    assert before[0][0] == (2 if display else 1)


def test_the_first_overview_write_moves_to_format_3_with_the_shared_ddl(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    inv = with_investigation(wb, pid)
    md = f'# Toy\n\n<ap-investigation investigation="{inv}"></ap-investigation>\n'
    stored, changed, warnings = wb.put_overview(pid, md, "ada")
    assert changed and warnings == []
    assert (stored["seq"], stored["markdown"], stored["author"]) == (1, md, "ada")
    assert stored["digest"] == hashlib.sha256(md.encode()).hexdigest()
    version, tables = raw(path)
    assert version == 3 and tables["overviews"] == CASES["sql"] and "display" in tables
    assert wb.overview(pid) == stored
    assert wb.check()["ok"], "check ignores overviews"
    wb.put_display(pid, MANIFEST)
    assert raw(path)[0] == 3, "a display write leaves format 3"
    wb.close()
    with WorkbookStore(path, readonly=True) as again:
        assert again.overview(pid) == stored


def test_bytes_bodies_must_be_utf8(tmp_path):
    wb, pid = workbook(tmp_path / "p.ap-workbook")
    assert wb.put_overview(pid, "# é\n".encode(), "ada")[0]["markdown"] == "# é\n"
    for bad in (b"\xff\xfe", "\ud800"):
        with pytest.raises(WorkbookError) as e:
            wb.put_overview(pid, bad, "ada")
        assert (e.value.error, e.value.path) == ("invalid", "markdown")
    wb.close()


def test_versions_append_and_an_unchanged_body_adds_no_row(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    first, changed, _ = wb.put_overview(pid, "# One\n", "ada")
    assert changed
    again, changed, _ = wb.put_overview(pid, "# One\n", "grace")
    assert not changed and again == first, "the digest decides, not the author"
    second, changed, _ = wb.put_overview(pid, "# Two\n", "grace")
    assert changed and second["seq"] > first["seq"]
    third, changed, _ = wb.put_overview(pid, "# One\n", "ada")
    assert changed and third["seq"] > second["seq"] and third["digest"] == first["digest"]
    assert [v["seq"] for v in wb.overview_versions(pid)] == [first["seq"], second["seq"], third["seq"]]
    assert wb.overview(pid) == third
    wb.close()


def test_latest_is_ordered_by_seq_not_created(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    wb.put_overview(pid, "# One\n", "ada")
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO overviews (seq, project, digest, markdown, author, created) VALUES (100, ?, ?, ?, 'bob', 1.0)",
                 (pid, hashlib.sha256(b"# Old clock\n").hexdigest(), "# Old clock\n"))
    conn.commit()
    conn.close()
    latest = wb.overview(pid)
    assert (latest["seq"], latest["author"], latest["created"]) == (100, "bob", 1.0)
    assert wb.overview_versions(pid)[-1] == latest
    wb.close()


@pytest.mark.parametrize("case", CASES["refused"], ids=lambda c: c["name"])
def test_refused_writes_change_nothing(tmp_path, case):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    with pytest.raises(WorkbookError) as e:
        wb.put_overview(pid, markdown_of(case), case["author"])
    assert e.value.error == CODES[case["error"]]
    assert e.value.path == case.get("path")
    version, tables = raw(path)
    assert version == 1 and "overviews" not in tables
    wb.close()


@pytest.mark.parametrize("case", CASES["accepted"], ids=lambda c: c["name"])
def test_accepted_edges(tmp_path, case):
    wb, pid = workbook(tmp_path / "p.ap-workbook")
    assert wb.put_overview(pid, markdown_of(case), case["author"])[1]
    wb.close()


def test_digests_are_the_sha256_of_the_utf8_body(tmp_path):
    wb, pid = workbook(tmp_path / "p.ap-workbook")
    for case in CASES["digests"]:
        assert wb.put_overview(pid, case["markdown"], "ada")[0]["digest"] == case["digest"]
    wb.close()


@pytest.mark.parametrize("case", CASES["warnings"], ids=lambda c: c["name"])
def test_warnings_match_the_shared_vectors(case):
    assert check_overview(case["markdown"], CASES["investigations"]) == case["warnings"]


@pytest.mark.parametrize("case", CASES["warnings"], ids=lambda c: c["name"])
def test_cards_and_renders_match_the_shared_vectors(case):
    """The block pass puts cards and HTML blocks where the viewer does
    (html/routes/overview-vectors.deno.test.ts checks the same vectors against the
    bundled parser)."""
    found = _overview_blocks.blocks(case["markdown"], ("ap-investigation",))
    assert [f[2] + 1 for f in found if f[0] == "card" and f[1] == "ap-investigation"] == case["cards"]
    assert (not any(f[0] == "html_block" for f in found)) == case["renders"]


@pytest.mark.parametrize(("raw", "want"), [
    ("a&amp;b", "a&b"), ("a&ampb", "a&ampb"), ("a&amp b", "a& b"), ("a&amp=b", "a&amp=b"),
    ("&#95x&#x80;", "_x\u20ac"), ("&#0;&#xD800;&#x110000;", "\ufffd\ufffd\ufffd"), ("&bogus;&", "&bogus;&"),
    ("&#;", "&#;")])
def test_attribute_values_decode_as_the_html_parser_does(raw, want):
    assert decode(raw) == want


def test_overviews_ddl_is_the_shared_vector():
    assert _OVERVIEWS_DDL == CASES["ddl"]


def test_a_write_warns_about_its_own_workbook_and_still_stores_the_body(tmp_path):
    wb, pid = workbook(tmp_path / "p.ap-workbook")
    inv = with_investigation(wb, pid)
    md = (f'<ap-investigation investigation="{inv}" hue="1"></ap-investigation>\n\n'
          '<ap-investigation investigation="inv_gone"></ap-investigation>\n')
    stored, changed, warnings = wb.put_overview(pid, md, "ada")
    assert changed and stored["markdown"] == md
    assert [(w["code"], w.get("attribute"), w.get("investigation")) for w in warnings] == [
        ("unknown_attribute", "hue", None), ("unknown_investigation", None, "inv_gone")]
    assert wb.put_overview(pid, md, "ada")[2] == warnings
    wb.close()


def test_newer_formats_are_refused_on_open_and_on_write(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 4")
    conn.close()
    with pytest.raises(WorkbookError, match="format 4; this SDK reads up to 3"):
        wb.put_overview(pid, "# x\n", "ada")
    version, tables = raw(path)
    assert version == 4 and "overviews" not in tables
    wb.close()
    with pytest.raises(WorkbookError, match="format 4"):
        WorkbookStore(path)


def test_only_an_overview_write_makes_a_workbook_unreadable_below_format_3(tmp_path):
    """A reader that reads up to 2 (an SDK before format 3) refuses a
    workbook exactly when it holds an overview."""
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    wb.put_display(pid, MANIFEST)
    wb.overview(pid)
    assert raw(path)[0] <= 2
    wb.put_overview(pid, "# x\n", "ada")
    assert raw(path)[0] == 3
    wb.close()


def test_memory_stores_keep_no_overview():
    store = MemoryStore()
    pid = store.ensure_project("toy")
    assert store.put_overview(pid, "# x\n", "ada") is None
    assert store.overview(pid) is None and store.overview_versions(pid) == []


def test_the_project_handle_reads_and_writes_overviews(tmp_path):
    client = connect(str(tmp_path))
    wb = client.ensure_project("toy")
    assert wb.overview() is None and wb.overview_versions() == []
    stored, changed, warnings = wb.put_overview("# Handle\n", "ada")
    assert changed and warnings == [] and wb.overview() == stored
    assert wb.overview_versions() == [stored]
    client.close()


# --- cross-SDK goldens --------------------------------------------------------

def _goldens():
    return sorted(SHARED.glob("*.ap-workbook"))


def test_both_sdks_wrote_a_golden():
    assert {p.stem for p in _goldens()} >= {"python", "rust"}


@pytest.mark.parametrize("golden", _goldens(), ids=lambda p: p.stem)
def test_overview_goldens_read_back(golden, tmp_path):
    exp = json.loads(golden.with_suffix(".json").read_text(encoding="utf-8"))
    copy = tmp_path / golden.name
    shutil.copy(golden, copy)
    store = WorkbookStore(copy, create=False)
    pid = store.projects()[0]["id"]
    assert conformance_cases.overview_expected(store, copy, pid) == exp
    assert exp["format"]["user_version"] == 3 and exp["overview_sql"] == CASES["sql"]
    versions = exp["versions"]
    assert len(versions) >= 2
    for v in versions:
        assert v["digest"] == hashlib.sha256(v["markdown"].encode()).hexdigest()
    latest = versions[-1]
    assert store.overview(pid) == latest
    assert store.check()["ok"]
    assert check_overview(latest["markdown"], [i["id"] for i in store.investigations()]) == []
    same, changed, _ = store.put_overview(pid, latest["markdown"], "reader")
    assert not changed and same == latest, "rewriting the latest adds no row"
    store.put_display(pid, MANIFEST)
    assert raw(copy)[0] == 3
    store.close()


def test_the_overview_generator_writes_a_self_consistent_golden(tmp_path):
    path = conformance_cases.write_overview_golden(tmp_path)
    exp = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    assert [v["author"] for v in exp["versions"]] == ["python-writer", "python-reviewer"]
    (tmp_path / "read").mkdir()
    test_overview_goldens_read_back(path, tmp_path / "read")
