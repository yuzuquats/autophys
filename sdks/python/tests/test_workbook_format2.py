"""Workbook format 2: the display table, reached at the first display write (DM-D1, DM-D1a)."""
import hashlib
import json
import sqlite3

import pytest

from autophys.store import canonical
from autophys.workbook import INITIAL_VERSION, MAX_DISPLAY_BYTES, SCHEMA_VERSION, WorkbookError, WorkbookStore

# The display DDL as SQLite keeps it in sqlite_master: the Rust SDK's statement
# without "IF NOT EXISTS" and the trailing ";". Both SDKs must leave this text.
DISPLAY_SQL = ("CREATE TABLE display (\n"
               "              project TEXT PRIMARY KEY REFERENCES projects(id),\n"
               "              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n"
               "            )")
# What SDKs before format 2 ran on a format-1 workbook (the Rust SDK's put_display).
LEGACY_DDL = ("CREATE TABLE IF NOT EXISTS display (\n"
              "              project TEXT PRIMARY KEY REFERENCES projects(id),\n"
              "              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n"
              "            );")
MANIFEST = {"format": 1, "channels": {"y": {"role": "output"}}, "title": "toy"}
BODY = json.dumps(MANIFEST).encode()


def raw(path):
    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = {name: sql for name, sql in conn.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")}
        return version, tables
    finally:
        conn.close()


def workbook(path):
    wb = WorkbookStore(path)
    return wb, wb.ensure_project("toy")


def test_versions():
    assert (INITIAL_VERSION, SCHEMA_VERSION) == (1, 2)


def test_new_workbook_is_format_1_and_opening_never_migrates(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    assert wb.display(pid) is None
    wb.close()
    for readonly in (False, True, False):
        with WorkbookStore(path, readonly=readonly) as again:
            assert again.display(pid) is None
    version, tables = raw(path)
    assert version == 1 and "display" not in tables


def test_first_display_write_moves_to_format_2(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    stored, changed = wb.put_display(pid, BODY)
    text = canonical(MANIFEST)
    assert changed and stored["body"] == MANIFEST
    assert stored["digest"] == hashlib.sha256(text.encode()).hexdigest()  # bare hex, like Rust
    version, tables = raw(path)
    assert version == 2 and tables["display"] == DISPLAY_SQL
    row = sqlite3.connect(path).execute("SELECT project, digest, body FROM display").fetchall()
    assert row == [(pid, stored["digest"], text)]
    again, changed = wb.put_display(pid, canonical(MANIFEST).encode())
    assert not changed and again == stored  # identical canonical body keeps the row and timestamp
    other = dict(MANIFEST, title="changed")
    replaced, changed = wb.put_display(pid, json.dumps(other).encode())
    assert changed and wb.display(pid)["body"] == other and replaced["digest"] != stored["digest"]
    assert raw(path)[0] == 2
    wb.close()


def test_format_2_reads_back(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    stored, _ = wb.put_display(pid, BODY)
    wb.close()
    with WorkbookStore(path, readonly=True) as ro:
        assert ro.display(pid) == stored
        assert ro.project_name() == "toy" and ro.check()["ok"]
    with WorkbookStore(path) as rw:
        assert rw.display(pid) == stored and rw.display("prj_other") is None


def test_format_1_with_legacy_table_reads_and_upgrades_on_next_write(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    wb.close()
    text = canonical(MANIFEST)
    digest = hashlib.sha256(text.encode()).hexdigest()
    conn = sqlite3.connect(path)  # what a pre-format-2 SDK left behind
    conn.execute(LEGACY_DDL)
    conn.execute("INSERT INTO display VALUES (?, ?, ?, ?)", (pid, digest, text, 12.5))
    conn.commit()
    conn.close()
    assert raw(path)[0] == 1
    with WorkbookStore(path, readonly=True) as ro:
        assert ro.display(pid) == {"digest": digest, "body": MANIFEST, "created": 12.5}
    with WorkbookStore(path) as rw:
        assert raw(path)[0] == 1  # still not on open
        stored, changed = rw.put_display(pid, BODY)  # even an unchanged body completes the upgrade
        assert not changed and stored["created"] == 12.5
    version, tables = raw(path)
    assert version == 2 and tables["display"] == DISPLAY_SQL


def test_newer_formats_are_refused(tmp_path):
    path = tmp_path / "p.ap-workbook"
    workbook(path)[0].close()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()
    for readonly in (False, True):
        with pytest.raises(WorkbookError, match="format 3; this SDK reads up to 2"):
            WorkbookStore(path, readonly=readonly)


def test_a_newer_format_written_after_open_is_not_downgraded(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()
    with pytest.raises(WorkbookError, match="format 3"):
        wb.put_display(pid, BODY)
    wb.close()
    version, tables = raw(path)
    assert version == 3 and "display" not in tables


class _FailingDisplayInsert:
    """Delegates to the real connection but fails the display row's INSERT,
    after the migration step has already run in the same transaction."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, *args):
        if sql.startswith("INSERT INTO display"):
            raise sqlite3.OperationalError("disk I/O error (injected)")
        return self._conn.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def test_a_failed_display_write_leaves_format_1(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    with pytest.raises(WorkbookError, match="unknown project") as e:
        wb.put_display("prj_missing", BODY)
    assert e.value.error == "not_found"
    real = wb._conn
    wb._conn = _FailingDisplayInsert(real)
    try:
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            wb.put_display(pid, BODY)
    finally:
        wb._conn = real
    assert wb.display(pid) is None
    version, tables = raw(path)
    assert version == 1 and "display" not in tables  # the migration rolled back with the write
    wb.put_display(pid, BODY)  # the workbook is still usable
    assert raw(path)[0] == 2
    wb.close()


@pytest.mark.parametrize("body,error,match", [
    (b'{"format":2}', "invalid", "expected display manifest format 1"),
    (b'{"format":1.0}', "invalid", "expected display manifest format 1"),
    (b'{"format":true}', "invalid", "expected display manifest format 1"),
    (b'[1]', "invalid", "expected display manifest format 1"),
    (b'not json', "invalid", "must be JSON"),
    (b'{"format":1,"x":NaN}', "invalid", "must be JSON"),
    (b'{"format":1,"pad":"' + b"x" * MAX_DISPLAY_BYTES + b'"}', "too_large", "exceeds"),
])
def test_rejected_manifests_change_nothing(tmp_path, body, error, match):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    with pytest.raises(WorkbookError, match=match) as e:
        wb.put_display(pid, body)
    assert e.value.error == error
    wb.close()
    version, tables = raw(path)
    assert version == 1 and "display" not in tables


def test_readonly_workbooks_refuse_display_writes(tmp_path):
    path = tmp_path / "p.ap-workbook"
    wb, pid = workbook(path)
    wb.close()
    with WorkbookStore(path, readonly=True) as ro:
        with pytest.raises(WorkbookError, match="read-only"):
            ro.put_display(pid, BODY)
    assert raw(path)[0] == 1


# The display digest both SDKs compute for a non-ASCII manifest; pinned the
# same in sdks/rust/tests/workbook_format2.rs (canonical JSON is ASCII-only in
# both, keys sorted by code point).
NON_ASCII_CANONICAL = r'{"channels":{"T":{"label":"\u03b8 (\u00b0C)","unit":"\u00b0C"}},"ctl":"tab\tnl\n\u0001 \u2028","e":2,"format":1,"nums":[0.1,1e-07,1e+21,-0.0],"title":"Temp\u00e9rature \u2014 \u71b1 \ud83d\udd25","\u00e9":1,"\uffff":3,"\ud83d\ude00":4}'
NON_ASCII_DIGEST = "543ee13fd15bb36266fc0fe2ff74e76c62feae40e9e0fec1a54561349512c075"


def test_non_ascii_manifest_digest_matches_rust(tmp_path):
    upload = ('{"format":1,"title":"Température — 熱 🔥","channels":{"T":{"label":"θ (°C)","unit":"°C"}},'
              '"é":1,"e":2,"￿":3,"😀":4,"ctl":"tab\\tnl\\n\\u0001  ","nums":[0.1,1e-7,1e21,-0.0]}')
    wb, pid = workbook(tmp_path / "p.ap-workbook")
    stored, _ = wb.put_display(pid, upload.encode())
    assert stored["digest"] == NON_ASCII_DIGEST and canonical(stored["body"]) == NON_ASCII_CANONICAL
    assert sqlite3.connect(tmp_path / "p.ap-workbook").execute("SELECT body FROM display").fetchone()[0] == NON_ASCII_CANONICAL
    wb.close()
