"""Append-only investigation records.

Every investigation is one ordered log of records. A record is
``{id, investigation, seq, kind, ts, payload, prev_hash, hash}``; ``hash`` is
``sha256(prev_hash + canonical JSON of {id, kind, payload})`` so a log can be
checked for edits or gaps (:meth:`Store.verify`). Nothing is updated in place:
a proposal's life is a sequence of ``proposal`` records whose ``event`` is
``proposed``, ``approved``, ``edited``, ``rejected``, ``withdrawn`` or
``data_attached``.

Kinds: ``investigation`` (first record), ``measurement`` (one observation
added to the versioned measurement set), ``run``, ``step``, ``proposal``,
``outcome``.

Above investigations sit projects and their immutable config versions
(:mod:`autophys.project`): ``ensure_project`` is idempotent by name,
``put_config_version`` is idempotent by content hash, and an investigation's
first record names the ``project_id`` and ``config_version`` it pins.

Backends: :class:`MemoryStore`, :class:`JsonlStore` (one ``<id>.jsonl`` file per
investigation plus ``investigations.jsonl``), in :mod:`autophys.workbook`
``WorkbookStore`` (one ``.ap-workbook`` SQLite file per project, the system of
record) and, in :mod:`autophys.http`, ``HttpStore`` against a daemon's
``/api/v1``.
"""

from __future__ import annotations

import fcntl
from contextlib import contextmanager
import hashlib
import json
import os
import threading
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

KINDS = ("investigation", "measurement", "run", "step", "proposal", "outcome", "reveal")
PROPOSAL_EVENTS = ("proposed", "approved", "edited", "rejected", "withdrawn", "data_attached")
GENESIS = "0" * 64


def _default(o: Any):
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, set):
        return sorted(o)
    if hasattr(o, "to_dict"):
        return o.to_dict()
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


def canonical(obj: Any) -> str:
    """Canonical JSON: sorted keys, no NaN (NaN/inf become null)."""
    return json.dumps(_clean(obj), sort_keys=True, separators=(",", ":"), default=_default)


def _clean(o: Any):
    if isinstance(o, float):
        return o if np.isfinite(o) else None
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, (np.floating,)):
        return _clean(float(o))
    if isinstance(o, np.integer):
        return int(o)
    if hasattr(o, "to_dict"):
        return _clean(o.to_dict())
    return o


def chain_hash(prev_hash: str, record_id: str, kind: str, payload: Any) -> str:
    body = canonical({"id": record_id, "kind": kind, "payload": payload})
    return hashlib.sha256((prev_hash + body).encode()).hexdigest()


@dataclass
class Record:
    id: str
    investigation: str
    seq: int
    kind: str
    ts: float
    payload: dict
    prev_hash: str
    hash: str

    def to_dict(self) -> dict:
        return asdict(self)


class StoreError(RuntimeError):
    pass


def config_hash(config: dict) -> str:
    return "sha256:" + hashlib.sha256(canonical(config).encode()).hexdigest()


class Store(ABC):
    def register_display(self, project_id: str, project) -> None:
        """Local stores do not generate or persist display previews yet."""

    def put_display(self, project_id: str, body: bytes) -> None:
        """Local stores intentionally do not persist display manifests yet.

        Memory, Jsonl and Workbook inherit this no-op; daemon storage is separate.
        """


    @abstractmethod
    def ensure_project(self, name: str) -> str: ...

    @abstractmethod
    def put_config_version(self, project_id: str, version: str, config: dict) -> str: ...

    @abstractmethod
    def config_versions(self, project_id: str) -> list[dict]: ...

    @abstractmethod
    def projects(self) -> list[dict]: ...

    @abstractmethod
    def create_investigation(self, meta: dict) -> str:
        """``meta`` must carry ``project_id`` and ``config_version`` already stored."""

    @abstractmethod
    def append(self, investigation: str, kind: str, payload: dict, *, record_id: str | None = None) -> Record: ...

    def append_batch(self, investigation: str, items: list[tuple[str, dict]]) -> list[Record]:
        """Append ``(kind, payload)`` records in order, all or none where the store can.

        Local stores commit the batch together (WorkbookStore in one
        transaction); this default, used over HTTP, appends one at a time.
        """
        return [self.append(investigation, kind, payload) for kind, payload in items]

    @abstractmethod
    def records(self, investigation: str, kind: str | None = None) -> list[Record]: ...

    @abstractmethod
    def investigations(self) -> list[dict]: ...

    def _find_record(self, rid: str) -> Record | None:
        return next((r for inv in self.investigations() for r in self.records(inv["id"]) if r.id == rid), None)

    def _prepare_create(self, meta: dict, record_id: str | None) -> tuple[str, dict, str | None]:
        from .workbook import WorkbookError, investigation_payload

        rid, payload, text = investigation_payload(meta, record_id)
        old = self._find_record(rid)
        if old:
            if old.kind == "investigation" and canonical(old.payload) == text:
                return rid, payload, old.investigation
            raise WorkbookError("idempotency_conflict", f"record id {rid} was already used for a different record")
        if payload["config_version"] not in {c["version"] for c in self.config_versions(payload["project_id"])}:
            raise WorkbookError("unknown_config_version", "config version is not stored; store the config version first")
        return rid, payload, None

    def _prepare_append(self, investigation: str, kind: str, payload: dict, record_id: str | None, pending=()):
        from .workbook import WorkbookError, append_payload, check_transition, check_reveal

        rid, payload, text = append_payload(kind, payload, record_id)
        old = next((r for r in pending if r.id == rid), None) or self._find_record(rid)
        if old:
            if old.investigation == investigation and old.kind == kind and canonical(old.payload) == text:
                return rid, payload, old
            raise WorkbookError("idempotency_conflict", f"record id {rid} was already used for a different record")
        if investigation not in {i["id"] for i in self.investigations()}:
            raise WorkbookError("not_found", f"unknown investigation {investigation}")
        if kind == "reveal":
            check_reveal(r.kind for r in [*self.records(investigation), *pending])
        if kind == "proposal":
            events = [r.payload for r in [*self.records(investigation, "proposal"), *(r for r in pending if r.kind == "proposal")]
                      if r.payload["proposal_id"] == payload["proposal_id"]]
            state = events[-1]["event"] if events else None
            proposed = events[0] if events else None
            check_transition(state, proposed, payload)
        return rid, payload, None

    def verify(self, investigation: str) -> bool:
        prev = GENESIS
        for i, r in enumerate(self.records(investigation)):
            if r.seq != i or r.prev_hash != prev or chain_hash(prev, r.id, r.kind, r.payload) != r.hash:
                return False
            prev = r.hash
        return True

    def proposal_status(self, investigation: str, proposal_id: str) -> dict:
        """Fold a proposal's events into its current state."""
        state: dict = {"proposal_id": proposal_id, "status": None, "events": []}
        for r in self.records(investigation, "proposal"):
            if r.payload.get("proposal_id") != proposal_id:
                continue
            ev = r.payload["event"]
            state["events"].append(ev)
            state["status"] = ev
            if ev == "proposed":
                state["experiment"] = r.payload.get("experiment")
                state["settings"] = r.payload.get("settings")
            if ev == "edited":
                state["settings"] = r.payload.get("settings")
        if state["status"] is None:
            raise StoreError(f"unknown proposal {proposal_id}")
        return state


def _check_config(version: str, config: dict) -> None:
    if config_hash(config) != version:
        raise StoreError("config version does not match the hash of its content")



class MemoryStore(Store):
    def __init__(self) -> None:
        self._blobs = {}
        self._logs: dict[str, list[Record]] = {}
        self._meta: dict[str, dict] = {}
        self._projects: dict[str, dict] = {}
        self._configs: dict[str, list[dict]] = {}
        self._lock = threading.Lock()

    def put_blob(self, data: bytes, media_type: str = "application/octet-stream") -> str:
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        with self._lock:
            self._blobs.setdefault(key, (bytes(data), media_type))
        return key

    def get_blob(self, key: str) -> tuple[bytes, str]:
        return self._blobs[key]

    def ensure_project(self, name: str) -> str:
        with self._lock:
            for pid, p in self._projects.items():
                if p["name"] == name:
                    return pid
            pid = "prj_" + uuid.uuid4().hex[:16]
            self._projects[pid] = {"id": pid, "name": name, "created": time.time()}
            self._configs[pid] = []
            return pid

    def put_config_version(self, project_id, version, config):
        _check_config(version, config)
        with self._lock:
            if project_id not in self._configs:
                raise StoreError(f"unknown project {project_id}")
            if version not in {c["version"] for c in self._configs[project_id]}:
                self._configs[project_id].append({"version": version, "config": json.loads(canonical(config)), "created": time.time()})
        return version

    def config_versions(self, project_id):
        return list(self._configs.get(project_id, []))

    def projects(self):
        return list(self._projects.values())

    def create_investigation(self, meta: dict, *, record_id: str | None = None) -> str:
        from .workbook import now_ts

        with self._lock:
            rid, payload, replay = self._prepare_create(meta, record_id)
            if replay is not None:
                return replay
            inv = "inv_" + uuid.uuid4().hex[:16]
            self._meta[inv] = dict(payload)
            self._logs[inv] = [Record(rid, inv, 0, "investigation", now_ts(), payload, GENESIS,
                                      chain_hash(GENESIS, rid, "investigation", payload))]
            return inv

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        with self._lock:
            return self._append_locked(investigation, kind, payload, record_id)

    def append_batch(self, investigation, items):
        with self._lock:
            n = len(self._logs.get(investigation, ()))
            try:
                return [self._append_locked(investigation, kind, payload, None) for kind, payload in items]
            except BaseException:
                if investigation in self._logs:
                    del self._logs[investigation][n:]
                raise

    def _append_locked(self, investigation, kind, payload, record_id) -> Record:
        from .workbook import now_ts

        rid, payload, replay = self._prepare_append(investigation, kind, payload, record_id)
        if replay is not None:
            return replay
        log = self._logs[investigation]
        prev = log[-1].hash if log else GENESIS
        rec = Record(rid, investigation, len(log), kind, now_ts(), payload, prev, chain_hash(prev, rid, kind, payload))
        log.append(rec)
        return rec

    def records(self, investigation, kind=None):
        return [r for r in self._logs.get(investigation, []) if kind is None or r.kind == kind]

    def investigations(self):
        return [{"id": k, **v} for k, v in self._meta.items()]


class JsonlStore(Store):
    """One JSON line per record, opened in append mode; never rewritten."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, inv: str) -> Path:
        if not inv.replace("_", "").isalnum():
            raise StoreError(f"bad investigation id {inv!r}")
        return self.root / f"{inv}.jsonl"

    @contextmanager
    def _write_lock(self):
        with self._lock:
            with (self.root / ".write.lock").open("a+b") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def put_blob(self, data: bytes, media_type: str = "application/octet-stream") -> str:
        digest = hashlib.sha256(data).hexdigest()
        with self._write_lock():
            blobs = self.root / "blobs"
            blobs.mkdir(exist_ok=True)
            path = blobs / digest
            if not path.exists():
                # Sidecar first, then the blob by rename: a present blob is complete.
                for target, content in ((path.with_suffix(".json"), canonical({"media_type": media_type}).encode()),
                                        (path, bytes(data))):
                    tmp = target.with_name(target.name + ".tmp")
                    tmp.write_bytes(content)
                    os.replace(tmp, target)
        return "sha256:" + digest

    def get_blob(self, key: str) -> tuple[bytes, str]:
        digest = key.removeprefix("sha256:")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise StoreError("invalid blob hash")
        path = self.root / "blobs" / digest
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise StoreError("blob content does not match its hash")
        return data, json.loads(path.with_suffix(".json").read_text())["media_type"]

    @staticmethod
    def _read_lines(data):
        lines, end = [], 0
        chunks = data.splitlines(keepends=True)
        for index, line in enumerate(chunks):
            if not line.endswith(b"\n"):
                break  # a torn final write, even if its JSON happens to parse
            try:
                item = json.loads(line) if line.strip() else None
            except ValueError:
                if index != len(chunks) - 1:
                    raise
                break
            end += len(line)
            if item is not None:
                lines.append(item)
        return lines, end

    def _lines(self, name: str) -> list[dict]:
        p = self.root / name
        return self._read_lines(p.read_bytes())[0] if p.exists() else []

    def _append_lines(self, name, objects):
        with (self.root / name).open("a+b") as f:
            f.seek(0)
            _, end = self._read_lines(f.read())
            f.truncate(end)
            f.write("".join(canonical(obj) + "\n" for obj in objects).encode())
            f.flush()
            os.fsync(f.fileno())

    def _append_line(self, name: str, obj: dict) -> None:
        self._append_lines(name, [obj])

    def ensure_project(self, name: str) -> str:
        with self._write_lock():
            for p in self._lines("projects.jsonl"):
                if p["name"] == name:
                    return p["id"]
            pid = "prj_" + uuid.uuid4().hex[:16]
            self._append_line("projects.jsonl", {"id": pid, "name": name, "created": time.time()})
            return pid

    def put_config_version(self, project_id, version, config):
        _check_config(version, config)
        with self._write_lock():
            if project_id not in {p["id"] for p in self._lines("projects.jsonl")}:
                raise StoreError(f"unknown project {project_id}")
            if version not in {c["version"] for c in self.config_versions(project_id)}:
                self._append_line("configs.jsonl", {"project_id": project_id, "version": version, "config": config, "created": time.time()})
        return version

    def config_versions(self, project_id):
        return [{k: c[k] for k in ("version", "config", "created")} for c in self._lines("configs.jsonl") if c["project_id"] == project_id]

    def projects(self):
        return self._lines("projects.jsonl")

    def create_investigation(self, meta: dict, *, record_id: str | None = None) -> str:
        from .workbook import now_ts

        with self._write_lock():
            rid, payload, replay = self._prepare_create(meta, record_id)
            if replay is not None:
                return replay
            inv = "inv_" + uuid.uuid4().hex[:16]
            ts = now_ts()
            rec = Record(rid, inv, 0, "investigation", ts, payload, GENESIS,
                         chain_hash(GENESIS, rid, "investigation", payload))
            self._append_line(f"{inv}.jsonl", rec.to_dict())
            self._append_line("investigations.jsonl", {"id": inv, "created": ts, **payload})
            return inv

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        return self._append_many(investigation, [(kind, payload, record_id)])[0]

    def append_batch(self, investigation, items):
        return self._append_many(investigation, [(kind, payload, None) for kind, payload in items])

    def _append_many(self, investigation, items) -> list[Record]:
        """Validate every item, then write all new lines with one write and fsync."""
        from .workbook import now_ts

        with self._write_lock():
            existing = self.records(investigation)
            out: list[Record] = []
            new: list[Record] = []
            for kind, payload, record_id in items:
                rid, payload, replay = self._prepare_append(investigation, kind, payload, record_id, new)
                if replay is not None:
                    out.append(replay)
                    continue
                prev = new[-1].hash if new else (existing[-1].hash if existing else GENESIS)
                rec = Record(rid, investigation, len(existing) + len(new), kind, now_ts(), payload, prev,
                             chain_hash(prev, rid, kind, payload))
                new.append(rec)
                out.append(rec)
            if new:
                self._append_lines(f"{investigation}.jsonl", [r.to_dict() for r in new])
            return out

    def records(self, investigation, kind=None):
        path = self._path(investigation)
        if not path.exists():
            return []
        return [Record(**r) for r in self._lines(path.name) if kind is None or r["kind"] == kind]

    def investigations(self):
        return self._lines("investigations.jsonl")
