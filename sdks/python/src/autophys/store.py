"""Append-only investigation records.

Every investigation is one ordered log of records. A record is
``{id, investigation, seq, kind, ts, payload, prev_hash, hash}``; ``hash`` is
``sha256(prev_hash + canonical JSON of {id, kind, payload})`` so a log can be
checked for edits or gaps (:meth:`Store.verify`). Nothing is updated in place:
a proposal's life is a sequence of ``proposal`` records whose ``event`` is
``proposed``, ``approved``, ``edited``, ``rejected`` or ``data_attached``.

Kinds: ``investigation`` (first record), ``measurement`` (one observation
added to the versioned measurement set), ``run``, ``step``, ``proposal``,
``outcome``.

Above investigations sit projects and their immutable config versions
(:mod:`autophys.project`): ``ensure_project`` is idempotent by name,
``put_config_version`` is idempotent by content hash, and an investigation's
first record names the ``project_id`` and ``config_version`` it pins.

Backends: :class:`MemoryStore`, :class:`JsonlStore` (one ``<id>.jsonl`` file per
investigation plus ``investigations.jsonl``) and, in :mod:`autophys.http`,
``HttpStore`` against the draft server contract.
"""

from __future__ import annotations

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

KINDS = ("investigation", "measurement", "run", "step", "proposal", "outcome")
PROPOSAL_EVENTS = ("proposed", "approved", "edited", "rejected", "data_attached")
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

    @abstractmethod
    def records(self, investigation: str, kind: str | None = None) -> list[Record]: ...

    @abstractmethod
    def investigations(self) -> list[dict]: ...

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


def _check_pin(store: "Store", meta: dict) -> None:
    pid, ver = meta.get("project_id"), meta.get("config_version")
    if not pid or not ver:
        raise StoreError("an investigation must name project_id and config_version")
    if ver not in {c["version"] for c in store.config_versions(pid)}:
        raise StoreError(f"config version {ver} is not stored for project {pid}")


def _check(kind: str, payload: dict) -> None:
    if kind not in KINDS:
        raise StoreError(f"unknown record kind {kind!r}")
    if kind == "proposal" and payload.get("event") not in PROPOSAL_EVENTS:
        raise StoreError(f"proposal event must be one of {PROPOSAL_EVENTS}")


class MemoryStore(Store):
    def __init__(self) -> None:
        self._logs: dict[str, list[Record]] = {}
        self._meta: dict[str, dict] = {}
        self._projects: dict[str, dict] = {}
        self._configs: dict[str, list[dict]] = {}
        self._lock = threading.Lock()

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

    def create_investigation(self, meta: dict) -> str:
        _check_pin(self, meta)
        inv = "inv_" + uuid.uuid4().hex[:16]
        with self._lock:
            self._logs[inv] = []
            self._meta[inv] = dict(meta)
        self.append(inv, "investigation", meta)
        return inv

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        _check(kind, payload)
        payload = json.loads(canonical(payload))
        with self._lock:
            log = self._logs.get(investigation)
            if log is None:
                raise StoreError(f"unknown investigation {investigation}")
            rid = record_id or uuid.uuid4().hex
            for r in log:
                if r.id == rid:
                    return r  # idempotent replay
            prev = log[-1].hash if log else GENESIS
            rec = Record(rid, investigation, len(log), kind, time.time(), payload, prev, chain_hash(prev, rid, kind, payload))
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

    def _lines(self, name: str) -> list[dict]:
        p = self.root / name
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    def _append_line(self, name: str, obj: dict) -> None:
        with open(self.root / name, "a") as f:
            f.write(canonical(obj) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def ensure_project(self, name: str) -> str:
        with self._lock:
            for p in self._lines("projects.jsonl"):
                if p["name"] == name:
                    return p["id"]
            pid = "prj_" + uuid.uuid4().hex[:16]
            self._append_line("projects.jsonl", {"id": pid, "name": name, "created": time.time()})
            return pid

    def put_config_version(self, project_id, version, config):
        _check_config(version, config)
        with self._lock:
            if project_id not in {p["id"] for p in self._lines("projects.jsonl")}:
                raise StoreError(f"unknown project {project_id}")
            if version not in {c["version"] for c in self.config_versions(project_id)}:
                self._append_line("configs.jsonl", {"project_id": project_id, "version": version, "config": config, "created": time.time()})
        return version

    def config_versions(self, project_id):
        return [{k: c[k] for k in ("version", "config", "created")} for c in self._lines("configs.jsonl") if c["project_id"] == project_id]

    def projects(self):
        return self._lines("projects.jsonl")

    def create_investigation(self, meta: dict) -> str:
        _check_pin(self, meta)
        inv = "inv_" + uuid.uuid4().hex[:16]
        self._path(inv).touch(exist_ok=False)
        with open(self.root / "investigations.jsonl", "a") as f:
            f.write(canonical({"id": inv, "created": time.time(), **meta}) + "\n")
        self.append(inv, "investigation", meta)
        return inv

    def append(self, investigation, kind, payload, *, record_id=None) -> Record:
        _check(kind, payload)
        payload = json.loads(canonical(payload))
        path = self._path(investigation)
        if not path.exists():
            raise StoreError(f"unknown investigation {investigation}")
        with self._lock:
            existing = self.records(investigation)
            rid = record_id or uuid.uuid4().hex
            for r in existing:
                if r.id == rid:
                    return r
            prev = existing[-1].hash if existing else GENESIS
            rec = Record(rid, investigation, len(existing), kind, time.time(), payload, prev, chain_hash(prev, rid, kind, payload))
            with open(path, "a") as f:
                f.write(canonical(rec.to_dict()) + "\n")
                f.flush()
                os.fsync(f.fileno())
            return rec

    def records(self, investigation, kind=None):
        path = self._path(investigation)
        if not path.exists():
            return []
        out = []
        with open(path) as f:
            for line in f:
                if line.strip():
                    r = Record(**json.loads(line))
                    if kind is None or r.kind == kind:
                        out.append(r)
        return out

    def investigations(self):
        return self._lines("investigations.jsonl")
