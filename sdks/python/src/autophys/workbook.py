"""Workbooks: one SQLite file per project holding its record log.

A workbook (``<slug>.ap-workbook``) is the system of record for one project:
its config versions, every investigation's append-only record chain, and two
projection tables (``investigations``, ``proposals``) that are always
rebuildable from the records. The Rust daemon's store and this module
implement the same format, specified in
``autophys.project.docs/content/workbook-format.md``. This module uses only
the standard library's :mod:`sqlite3`.

Several processes may open one workbook: the SDK and the browser viewer both
append to it. Every append is one ``BEGIN IMMEDIATE`` transaction, so the
hash chain stays linear. A waiting SDK notices another process's commit
through ``PRAGMA data_version``.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ._text import rust_trim
from .store import _clean, GENESIS, Record, Store, StoreError, canonical, chain_hash

#: ``PRAGMA application_id`` of a workbook: ASCII ``APWB``.
APPLICATION_ID = 0x41505742
#: The schema version this module writes (``PRAGMA user_version``).
SCHEMA_VERSION = 1
SUFFIX = ".ap-workbook"

MAX_PAYLOAD_BYTES = 1 << 20
MAX_ID_LEN = 128
MAX_OUTLOOK_AXES = 3
KINDS = ("investigation", "measurement", "run", "step", "proposal", "outcome")
EVENTS = ("proposed", "approved", "edited", "rejected", "withdrawn", "data_attached")
_ID = re.compile(r"[A-Za-z0-9_.:-]+")

_SCHEMA = """
CREATE TABLE records (
  gseq          INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  investigation TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  ts            REAL NOT NULL,
  payload       TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  UNIQUE (investigation, seq)
);
CREATE TRIGGER records_no_update BEFORE UPDATE ON records
  BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
CREATE TRIGGER records_no_delete BEFORE DELETE ON records
  BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
CREATE TABLE projects (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  created REAL NOT NULL
);
CREATE TABLE config_versions (
  project TEXT NOT NULL REFERENCES projects(id),
  version TEXT NOT NULL,
  body    TEXT NOT NULL,
  created REAL NOT NULL,
  PRIMARY KEY (project, version)
);
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created    REAL NOT NULL
);
"""

_PROJECTIONS = """
CREATE TABLE investigations (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL,
  config_version TEXT NOT NULL,
  overrides      TEXT NOT NULL,
  status         TEXT NOT NULL,
  budget_used    INTEGER NOT NULL,
  created        REAL NOT NULL,
  updated        REAL NOT NULL
);
CREATE TABLE proposals (
  investigation TEXT NOT NULL,
  id            TEXT NOT NULL,
  state         TEXT NOT NULL,
  experiment    TEXT,
  settings      TEXT,
  updated       REAL NOT NULL,
  PRIMARY KEY (investigation, id)
);
"""


class WorkbookError(StoreError):
    """A refused workbook operation. ``error`` is the machine code the daemon
    also uses (``invalid``, ``not_found``, ``conflict``, ``proposal_exists``,
    ``idempotency_conflict``, ``unknown_config_version``, ``too_large``);
    ``path`` names the offending field for ``invalid``."""

    def __init__(self, error: str, message: str, path: str | None = None) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.error = error
        self.path = path


def _invalid(path: str, message: str) -> WorkbookError:
    return WorkbookError("invalid", message, path)


def slug(name: str) -> str:
    """The file stem for a project name (see the format spec)."""
    s = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-.")
    return s or "project"


def now_ts() -> float:
    """Unix seconds at microsecond precision, as the daemon writes ``ts``."""
    return (time.time_ns() // 1000) / 1e6


# --------------------------------------------------------------------------
# Validation (pure; mirrors src/store/validate.rs)


def check_id(path: str, value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_ID_LEN:
        raise _invalid(path, f"must be 1 to {MAX_ID_LEN} characters")
    if not _ID.fullmatch(value):
        raise _invalid(path, "may contain only A-Z a-z 0-9 _ - . :")
    return value


def _number(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _string(obj: dict, at: str, key: str) -> str:
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise _invalid(f"{at}.{key}", "required non-empty string")
    return v


def _finite_array(v: Any, at: str) -> int:
    if not isinstance(v, list):
        raise _invalid(at, "required array of numbers")
    for i, x in enumerate(v):
        n = _number(x)
        if n is None or not math.isfinite(n):
            raise _invalid(f"{at}[{i}]", "must be a finite number")
    return len(v)


def outlook_shape(outlook: Any) -> None:
    at = "payload.outlook"
    if not isinstance(outlook, dict):
        raise _invalid(at, "must be an object")
    axes = outlook.get("axes")
    if not isinstance(axes, list):
        raise _invalid(f"{at}.axes", "required array")
    if len(axes) > MAX_OUTLOOK_AXES:
        raise _invalid(f"{at}.axes", f"at most {MAX_OUTLOOK_AXES} axes, got {len(axes)}")
    cells = 1
    for i, axis in enumerate(axes):
        a = f"{at}.axes[{i}]"
        if not isinstance(axis, dict):
            raise _invalid(a, "must be an object")
        _string(axis, a, "name")
        n = _finite_array(axis.get("values"), f"{a}.values")
        if n == 0:
            raise _invalid(f"{a}.values", "must not be empty")
        cells *= n
    n = _finite_array(outlook.get("score"), f"{at}.score")
    if n != cells:
        raise _invalid(f"{at}.score", f"has {n} values; the axes describe {cells} cells (row-major)")
    after = outlook.get("after")
    if not isinstance(after, dict):
        raise _invalid(f"{at}.after", "required object")
    for param, values in after.items():
        n = _finite_array(values, f"{at}.after.{param}")
        if n != cells:
            raise _invalid(f"{at}.after.{param}", f"has {n} values; the axes describe {cells} cells (row-major)")


def _trace_shape(kind: str, payload: dict) -> None:
    """Additive v1 trace fields; unknown usage keys remain readable."""
    def obj(key):
        value = payload[key]
        if not isinstance(value, dict):
            raise _invalid("payload." + key, "must be an object")
        return value

    def fields(value, at, strings=(), integers=(), numbers=(), nullable=()):
        for key in strings:
            if key in value and not isinstance(value[key], str):
                raise _invalid(at + "." + key, "must be a string")
        for key in integers:
            if key in value and (type(value[key]) is not int or value[key] < 0):
                raise _invalid(at + "." + key, "must be an integer >= 0")
        for key in numbers:
            if key in value and not (key in nullable and value[key] is None):
                n = _number(value[key])
                if n is None or not math.isfinite(n):
                    raise _invalid(at + "." + key, "must be a finite number" + (" or null" if key in nullable else ""))

    def digest(value, at):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
            raise _invalid(at, "must be a 64-hex sha256")

    if kind == "investigation":
        if "playbook" in payload:
            value = obj("playbook")
            for key in ("name", "version"):
                _string(value, "payload.playbook", key)
            digest(value.get("sha256"), "payload.playbook.sha256")
        if "model" in payload:
            value = obj("model")
            for key in ("role", "route", "model"):
                _string(value, "payload.model", key)
            if value["role"] not in ("policy", "researcher"):
                raise _invalid("payload.model.role", "must be policy or researcher")
            if value.get("effort") is not None and not isinstance(value["effort"], str):
                raise _invalid("payload.model.effort", "must be a string or null")
            fields({k: v for k, v in value.items() if v is not None}, "payload.model", integers=("max_tokens",))
        if "price" in payload:
            value = obj("price")
            for key in ("model", "as_of"):
                _string(value, "payload.price", key)
            for key in ("input_per_mtok", "output_per_mtok"):
                if key not in value:
                    raise _invalid("payload.price." + key, "required number")
            fields(value, "payload.price", numbers=("input_per_mtok", "output_per_mtok"))
    if kind == "step":
        if "usage" in payload:
            fields(obj("usage"), "payload.usage", strings=("route", "model"),
                   integers=("input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_input_tokens"),
                   numbers=("latency_ms", "cost_usd"), nullable=("cost_usd",))
        if "replayed" in payload and type(payload["replayed"]) is not bool:
            raise _invalid("payload.replayed", "must be a boolean")
        if "images" in payload:
            if not isinstance(payload["images"], list):
                raise _invalid("payload.images", "must be an array")
            for i, value in enumerate(payload["images"]):
                at = f"payload.images[{i}]"
                if not isinstance(value, dict):
                    raise _invalid(at, "must be an object")
                # Blob references use the store's sha256: prefix.
                digest(value.get("sha256", "").removeprefix("sha256:") if isinstance(value.get("sha256"), str) else None, at + ".sha256")
                _string(value, at, "media_type")
                fields(value, at, strings=("caption",))
    if kind == "outcome" and "usage_total" in payload:
        fields(obj("usage_total"), "payload.usage_total", integers=("calls", "input_tokens", "output_tokens"),
               numbers=("cost_usd",), nullable=("cost_usd",))


def check_integer_range(value: Any, path: str = "payload") -> None:
    """serde_json represents integers only in the i64/u64 union."""
    if isinstance(value, int) and not isinstance(value, bool) and not -(2 ** 63) <= value <= 2 ** 64 - 1:
        raise _invalid(path, "integer must be in -2**63 .. 2**64-1")
    if isinstance(value, dict):
        for key, item in value.items():
            check_integer_range(item, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            check_integer_range(item, f"{path}[{index}]")


def payload_shape(kind: str, payload: Any) -> None:
    """Validate a payload for its kind (only what projections read, plus E-1's outlook)."""
    if kind not in KINDS:
        raise _invalid("kind", f"unknown kind {kind!r}")
    if not isinstance(payload, dict):
        raise _invalid("payload", "must be a JSON object")
    check_integer_range(payload)
    _trace_shape(kind, payload)
    if kind == "investigation":
        _string(payload, "payload", "project_id")
        _string(payload, "payload", "config_version")
    elif kind == "measurement":
        if not isinstance(payload.get("observation"), dict):
            raise _invalid("payload.observation", "required object")
    elif kind == "outcome":
        _string(payload, "payload", "status")
    elif kind == "proposal":
        check_id("payload.proposal_id", _string(payload, "payload", "proposal_id"))
        ev = _string(payload, "payload", "event")
        if ev not in EVENTS:
            raise _invalid("payload.event", f"must be one of {', '.join(EVENTS)}")
        if ev == "proposed":
            _string(payload, "payload", "experiment")
            if payload.get("settings") is not None and not isinstance(payload["settings"], dict):
                raise _invalid("payload.settings", "must be an object")
            if "outlook" in payload:
                outlook_shape(payload["outlook"])
        elif ev == "edited":
            if not isinstance(payload.get("settings"), dict):
                raise _invalid("payload.settings", "required object for edited")
        elif ev == "data_attached":
            if payload.get("measurement_version") is None:
                raise _invalid("payload.measurement_version", "required for data_attached")


def append_payload(kind: str, payload: Any, record_id: str | None) -> tuple[str, dict, str]:
    """Shared append envelope and payload validation for every local Store."""
    if kind == "investigation":
        raise _invalid("kind", "investigation records are created by create_investigation")
    rid = check_id("id", record_id) if record_id is not None else uuid.uuid4().hex
    clean, text = canonical_payload(payload)
    payload_shape(kind, clean)
    check_payload_size(text)
    return rid, clean, text


def canonical_payload(payload: Any) -> tuple[Any, str]:
    clean = _clean(payload)
    check_integer_range(clean)
    text = canonical(clean)
    return json.loads(text), text


def check_payload_size(text: str) -> None:
    if len(text.encode()) > MAX_PAYLOAD_BYTES:
        raise WorkbookError("too_large", f"payload exceeds {MAX_PAYLOAD_BYTES} bytes")


def investigation_payload(meta: dict, record_id: str | None) -> tuple[str, dict, str]:
    rid = check_id("Idempotency-Key", record_id) if record_id is not None else uuid.uuid4().hex
    payload = dict(meta)
    overrides = payload.get("overrides")
    if overrides is None:
        payload["overrides"] = {}
    elif not isinstance(overrides, dict):
        raise _invalid("overrides", "must be an object")
    payload, text = canonical_payload(payload)
    payload_shape("investigation", payload)
    check_payload_size(text)
    return rid, payload, text


def check_transition(state: str | None, proposed: dict | None, payload: dict) -> None:
    pid, ev = payload["proposal_id"], payload["event"]
    if ev == "proposed":
        if state is not None:
            raise WorkbookError("proposal_exists", f"proposal {pid} already exists and is {state}")
        return
    if state is None:
        raise WorkbookError("not_found", f"unknown proposal {pid}")
    if state == "proposed" and ev in ("approved", "rejected", "withdrawn"):
        return
    if state == "proposed" and ev == "edited":
        check_edit(proposed, payload)
        return
    if state in ("approved", "edited") and ev == "data_attached":
        return
    raise WorkbookError("conflict", f"proposal is {state}; {ev} is not allowed")


def check_edit(proposed: dict | None, payload: dict) -> None:
    axes = (proposed or {}).get("outlook", {}).get("axes") if isinstance((proposed or {}).get("outlook"), dict) else None
    if not isinstance(axes, list):
        return  # without an outlook the store cannot know what is editable
    ranges = {}
    for a in axes:
        vals = [v for v in (_number(x) for x in a.get("values", [])) if v is not None]
        if isinstance(a.get("name"), str):
            ranges[a["name"]] = (min(vals, default=math.inf), max(vals, default=-math.inf))
    before = proposed.get("settings") if isinstance(proposed.get("settings"), dict) else None
    for key, value in payload["settings"].items():
        at = f"payload.settings.{key}"
        if key in ranges:
            lo, hi = ranges[key]
            slack = 1e-9 * max(abs(lo), abs(hi), 1.0)
            x = _number(value)
            if x is None:
                raise _invalid(at, "must be a number (it is an outlook axis)")
            if not (lo - slack <= x <= hi + slack):
                raise _invalid(at, f"{x} is outside the outlook axis [{lo}, {hi}]")
        elif before is None or key not in before or canonical(before[key]) != canonical(value):
            raise _invalid(at, "is not an outlook axis, so it cannot be edited")


# --------------------------------------------------------------------------
# The projection fold (mirrors src/store/projections.rs::apply)

_STATUS_AFTER = {"proposed": "awaiting_approval", "approved": "awaiting_data", "edited": "awaiting_data",
                 "rejected": "open", "withdrawn": "open", "data_attached": "open"}


def _apply(conn: sqlite3.Connection, rec: Record) -> None:
    p = rec.payload
    inv = rec.investigation
    if rec.kind == "investigation":
        conn.execute(
            "INSERT INTO investigations (id, project, config_version, overrides, status, budget_used, created, updated)"
            " VALUES (?, ?, ?, ?, 'open', 0, ?, ?)",
            (inv, p.get("project_id") or "", p.get("config_version") or "",
             canonical(p.get("overrides") if p.get("overrides") is not None else {}), rec.ts, rec.ts))
        return
    if rec.kind == "measurement":
        conn.execute("UPDATE investigations SET budget_used = budget_used + 1 WHERE id = ?", (inv,))
    elif rec.kind == "outcome":
        if isinstance(p.get("status"), str):
            conn.execute("UPDATE investigations SET status = ? WHERE id = ?", (p["status"], inv))
    elif rec.kind == "proposal":
        pid, ev = p.get("proposal_id"), p.get("event")
        if isinstance(pid, str) and ev in EVENTS:
            settings = canonical(p["settings"]) if p.get("settings") is not None else None
            if ev == "proposed":
                exp = p.get("experiment") if isinstance(p.get("experiment"), str) else None
                conn.execute(
                    "INSERT INTO proposals (investigation, id, state, experiment, settings, updated)"
                    " VALUES (?, ?, 'proposed', ?, ?, ?)", (inv, pid, exp, settings, rec.ts))
            else:
                conn.execute("UPDATE proposals SET state = ?, updated = ? WHERE investigation = ? AND id = ?",
                             (ev, rec.ts, inv, pid))
                if ev == "edited":
                    conn.execute("UPDATE proposals SET settings = ? WHERE investigation = ? AND id = ?",
                                 (settings, inv, pid))
            conn.execute("UPDATE investigations SET status = ? WHERE id = ?", (_STATUS_AFTER[ev], inv))
    conn.execute("UPDATE investigations SET updated = ? WHERE id = ?", (rec.ts, inv))


def projection_rows(conn: sqlite3.Connection) -> dict:
    """Every projection row, in key order: what a rebuild must reproduce."""
    inv = conn.execute("SELECT id, project, config_version, overrides, status, budget_used, created, updated"
                       " FROM investigations ORDER BY id").fetchall()
    props = conn.execute("SELECT investigation, id, state, experiment, settings, updated"
                         " FROM proposals ORDER BY investigation, id").fetchall()
    return {
        "investigations": [dict(zip(("id", "project", "config_version", "overrides", "status", "budget_used",
                                     "created", "updated"), r)) for r in inv],
        "proposals": [dict(zip(("investigation", "id", "state", "experiment", "settings", "updated"), r))
                      for r in props],
    }


def _row_record(row) -> Record:
    _gseq, rid, inv, seq, kind, ts, payload, prev, h = row
    return Record(rid, inv, seq, kind, ts, json.loads(payload), prev, h)


_COLUMNS = "gseq, id, investigation, seq, kind, ts, payload, prev_hash, hash"


# --------------------------------------------------------------------------


class WorkbookStore(Store):
    """A :class:`~autophys.store.Store` over one ``.ap-workbook`` file.

    ``WorkbookStore(path)`` opens the file, creating and initialising it when
    it does not exist (``create=False`` refuses instead). ``readonly=True``
    opens it without write access. The connection is shared by the threads
    of one process under a lock; other processes open their own.
    """

    watch_interval = 0.1  # seconds between data_version checks while waiting

    def __init__(self, path: str | Path, *, create: bool = True, readonly: bool = False) -> None:
        self.path = Path(path)
        if not self.path.exists() and (readonly or not create):
            raise WorkbookError("not_found", f"no workbook at {self.path}")
        if not readonly:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        uri = f"file:{self.path}?mode=ro" if readonly else f"file:{self.path}"
        self._conn = sqlite3.connect(uri, uri=True, timeout=5.0, isolation_level=None, check_same_thread=False)
        self.readonly = readonly
        self._lock = threading.RLock()
        self._writes = 0
        try:
            self._conn.execute("PRAGMA foreign_keys = ON")
            if not readonly:
                mode = self._conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
                if mode.lower() != "wal":
                    raise WorkbookError("invalid", f"journal_mode is {mode}, not wal")
                self._conn.execute("PRAGMA synchronous = NORMAL")
                self._init()
            self._check_format()
        except BaseException:
            self._conn.close()
            raise

    # --- file ---------------------------------------------------------------
    def _pragma(self, name: str) -> int:
        return int(self._conn.execute(f"PRAGMA {name}").fetchone()[0])

    def _check_format(self) -> None:
        aid, ver = self._pragma("application_id"), self._pragma("user_version")
        if aid != APPLICATION_ID:
            raise WorkbookError("invalid", f"{self.path} is not an autophys workbook (application_id {aid:#x})")
        if ver > SCHEMA_VERSION:
            raise WorkbookError("invalid", f"{self.path} has workbook format {ver}; this SDK reads up to {SCHEMA_VERSION}")

    def _init(self) -> None:
        with self._tx():
            aid, ver = self._pragma("application_id"), self._pragma("user_version")
            if aid == 0 and ver == 0:
                tables = self._conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
                if tables:
                    raise WorkbookError("invalid", f"{self.path} is a SQLite database but not an autophys workbook")
                for stmt in _split(_SCHEMA + _PROJECTIONS):
                    self._conn.execute(stmt)
                self._conn.execute(f"PRAGMA application_id = {APPLICATION_ID}")
                self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        if self.readonly:
            raise WorkbookError("invalid", f"{self.path} is open read-only")
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._writes += 1

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> "WorkbookStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"WorkbookStore({str(self.path)!r})"

    def data_version(self) -> tuple[int, int]:
        """Changes whenever any connection, in any process, commits."""
        with self._lock:
            return self._pragma("data_version"), self._writes

    def _q(self, sql: str, params: tuple = ()) -> list:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    # --- reference data -----------------------------------------------------
    def project_name(self) -> str | None:
        rows = self._q("SELECT name FROM projects")
        return rows[0][0] if rows else None

    def ensure_project(self, name: str) -> str:
        if not isinstance(name, str) or not rust_trim(name) or len(name) > 200:
            raise _invalid("name", "required string of 1 to 200 characters")
        with self._tx() as c:
            rows = c.execute("SELECT id, name FROM projects").fetchall()
            for pid, existing in rows:
                if existing == name:
                    return pid
            if rows:
                raise WorkbookError("conflict", f"{self.path} holds project {rows[0][1]!r}, not {name!r}")
            pid = "prj_" + secrets.token_hex(8)
            c.execute("INSERT INTO projects (id, name, created) VALUES (?, ?, ?)", (pid, name, now_ts()))
            return pid

    def put_config_version(self, project_id: str, version: str, config: dict) -> str:
        body = canonical(config)
        if "sha256:" + hashlib.sha256(body.encode()).hexdigest() != version:
            raise WorkbookError("hash_mismatch", "config version does not match the hash of its content")
        with self._tx() as c:
            if not c.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
                raise WorkbookError("not_found", f"unknown project {project_id}")
            c.execute("INSERT OR IGNORE INTO config_versions (project, version, body, created) VALUES (?, ?, ?, ?)",
                      (project_id, version, body, now_ts()))
        return version

    def config_versions(self, project_id: str) -> list[dict]:
        rows = self._q("SELECT version, body FROM config_versions WHERE project = ? ORDER BY created, version",
                       (project_id,))
        return [{"version": v, "config": json.loads(b)} for v, b in rows]

    def projects(self) -> list[dict]:
        return [{"id": i, "name": n} for i, n in self._q("SELECT id, name FROM projects ORDER BY name")]

    # --- blobs --------------------------------------------------------------
    def put_blob(self, data: bytes, media_type: str = "application/octet-stream") -> str:
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        with self._tx() as c:
            c.execute("INSERT OR IGNORE INTO blobs (sha256, media_type, bytes, created) VALUES (?, ?, ?, ?)",
                      (key, media_type, sqlite3.Binary(data), now_ts()))
        return key

    def get_blob(self, key: str) -> tuple[bytes, str]:
        rows = self._q("SELECT bytes, media_type FROM blobs WHERE sha256 = ?", (key,))
        if not rows:
            raise WorkbookError("not_found", f"no blob {key}")
        return bytes(rows[0][0]), rows[0][1]

    # --- the log ------------------------------------------------------------
    def _insert(self, c: sqlite3.Connection, inv: str, rid: str, kind: str, payload: Any, text: str) -> Record:
        head = c.execute("SELECT seq, hash FROM records WHERE investigation = ? ORDER BY seq DESC LIMIT 1",
                         (inv,)).fetchone()
        seq, prev = (head[0] + 1, head[1]) if head else (0, GENESIS)
        rec = Record(rid, inv, seq, kind, now_ts(), payload, prev, chain_hash(prev, rid, kind, payload))
        c.execute("INSERT INTO records (id, investigation, seq, kind, ts, payload, prev_hash, hash)"
                  " VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (rid, inv, seq, kind, rec.ts, text, prev, rec.hash))
        _apply(c, rec)
        return rec

    def create_investigation(self, meta: dict, *, record_id: str | None = None) -> str:
        rid, payload, text = investigation_payload(meta, record_id)
        with self._tx() as c:
            row = c.execute(f"SELECT {_COLUMNS} FROM records WHERE id = ?", (rid,)).fetchone()
            if row:
                if row[4] == "investigation" and row[6] == text:
                    return row[2]
                raise WorkbookError("idempotency_conflict", f"record id {rid} was already used for a different record")
            if not c.execute("SELECT 1 FROM config_versions WHERE project = ? AND version = ?",
                             (payload["project_id"], payload["config_version"])).fetchone():
                raise WorkbookError("unknown_config_version", "store the config version first")
            inv = "inv_" + secrets.token_hex(8)
            self._insert(c, inv, rid, "investigation", payload, text)
            return inv

    def append(self, investigation: str, kind: str, payload: dict, *, record_id: str | None = None) -> Record:
        item = append_payload(kind, payload, record_id)
        with self._tx() as c:
            return self._append_tx(c, investigation, kind, *item)

    def append_batch(self, investigation: str, items: list[tuple[str, dict]]) -> list[Record]:
        """Append the records in one ``BEGIN IMMEDIATE`` transaction: all or none."""
        prepared = [(kind, *append_payload(kind, payload, None)) for kind, payload in items]
        with self._tx() as c:
            return [self._append_tx(c, investigation, kind, rid, payload, text) for kind, rid, payload, text in prepared]

    def _append_tx(self, c: sqlite3.Connection, investigation: str, kind: str, rid: str, payload: Any, text: str) -> Record:
        row = c.execute(f"SELECT {_COLUMNS} FROM records WHERE id = ?", (rid,)).fetchone()
        if row:
            if row[2] == investigation and row[4] == kind and row[6] == text:
                return _row_record(row)
            raise WorkbookError("idempotency_conflict", f"record id {rid} was already used for a different record")
        if not c.execute("SELECT 1 FROM investigations WHERE id = ?", (investigation,)).fetchone():
            raise WorkbookError("not_found", f"unknown investigation {investigation}")
        if kind == "proposal":
            self._check_transition(c, investigation, payload)
        return self._insert(c, investigation, rid, kind, payload, text)

    def _check_transition(self, c: sqlite3.Connection, inv: str, payload: dict) -> None:
        pid, ev = payload["proposal_id"], payload["event"]
        row = c.execute("SELECT state FROM proposals WHERE investigation = ? AND id = ?", (inv, pid)).fetchone()
        state = row[0] if row else None
        proposed = None
        if ev == "edited" and state == "proposed":
            for (text,) in c.execute("SELECT payload FROM records WHERE investigation = ? AND kind = 'proposal' ORDER BY seq", (inv,)):
                p = json.loads(text)
                if p.get("proposal_id") == pid and p.get("event") == "proposed":
                    proposed = p
                    break
        check_transition(state, proposed, payload)

    def records(self, investigation: str, kind: str | None = None) -> list[Record]:
        rows = self._q(f"SELECT {_COLUMNS} FROM records WHERE investigation = ? AND (? IS NULL OR kind = ?) ORDER BY seq",
                       (investigation, kind, kind))
        return [_row_record(r) for r in rows]

    def investigations(self) -> list[dict]:
        rows = self._q("SELECT id, project, config_version, overrides, status, budget_used, created, updated"
                       " FROM investigations ORDER BY created, id")
        return [{"id": r[0], "project_id": r[1], "config_version": r[2], "overrides": json.loads(r[3]),
                 "status": r[4], "budget_used": r[5], "created": r[6], "updated": r[7]} for r in rows]

    def proposal(self, investigation: str, proposal_id: str) -> dict:
        rows = self._q("SELECT state, experiment, settings, updated FROM proposals WHERE investigation = ? AND id = ?",
                       (investigation, proposal_id))
        if not rows:
            raise WorkbookError("not_found", f"unknown proposal {proposal_id}")
        state, exp, settings, updated = rows[0]
        return {"investigation": investigation, "proposal_id": proposal_id, "status": state, "experiment": exp,
                "settings": json.loads(settings) if settings is not None else None, "updated": updated}

    def wait_for_approval(self, investigation: str, proposal_id: str, *, timeout: float = 3600, interval: float = 5,
                          sleep=time.sleep, clock=time.monotonic) -> dict:
        """Return once the proposal leaves ``proposed``, whoever wrote the decision.

        The proposal is re-read only when the file changed (``data_version``),
        so waiting costs one pragma per ``watch_interval``.
        """
        deadline = clock() + timeout
        seen = None
        while True:
            version = self.data_version()
            if version != seen:
                seen = version
                st = self.proposal_status(investigation, proposal_id)
                if st["status"] != "proposed":
                    return st
            if clock() >= deadline:
                raise TimeoutError(f"proposal {proposal_id} still awaiting approval")
            sleep(min(interval, self.watch_interval))

    # --- integrity ----------------------------------------------------------
    def check(self) -> dict:
        """Verify every chain and that the projections equal a fresh rebuild.

        Returns ``{"ok", "records", "investigations", "chain_errors",
        "projections_match"}``; nothing in the file is changed.
        """
        with self._lock:
            rows = self._conn.execute(f"SELECT {_COLUMNS} FROM records ORDER BY gseq").fetchall()
            stored = projection_rows(self._conn)
        mem = sqlite3.connect(":memory:", isolation_level=None)
        try:
            for stmt in _split(_PROJECTIONS):
                mem.execute(stmt)
            heads: dict[str, tuple[int, str]] = {}
            errors = []
            for row in rows:
                rec = _row_record(row)
                seq, prev = heads.get(rec.investigation, (-1, GENESIS))
                if (rec.seq != seq + 1 or rec.prev_hash != prev
                        or chain_hash(prev, rec.id, rec.kind, rec.payload) != rec.hash):
                    errors.append({"investigation": rec.investigation, "seq": rec.seq, "id": rec.id})
                heads[rec.investigation] = (rec.seq, rec.hash)
                _apply(mem, rec)
            rebuilt = projection_rows(mem)
        finally:
            mem.close()
        match = rebuilt == stored
        return {"ok": not errors and match, "records": len(rows), "investigations": len(heads),
                "chain_errors": errors, "projections_match": match}

    def heads(self) -> dict[str, dict]:
        """``{investigation: {"seq", "hash"}}`` of every chain's last record."""
        rows = self._q("SELECT investigation, seq, hash FROM records r WHERE seq ="
                       " (SELECT MAX(seq) FROM records WHERE investigation = r.investigation) ORDER BY investigation")
        return {inv: {"seq": seq, "hash": h} for inv, seq, h in rows}


def _split(script: str) -> list[str]:
    """Split DDL into statements (triggers contain ``;`` inside BEGIN..END)."""
    out, buf = [], []
    for line in script.strip().splitlines():
        buf.append(line)
        text = "\n".join(buf).strip()
        if text.endswith(";") and (not text.upper().startswith("CREATE TRIGGER") or text.upper().endswith("END;")):
            out.append(text)
            buf = []
    if "\n".join(buf).strip():
        out.append("\n".join(buf).strip())
    return out
