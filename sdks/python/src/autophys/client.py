"""Connections: ``ap.connect(target)`` → :class:`Client` → :class:`Workbook`.

``target`` is one of:

* a directory: a local collection of ``<project>.ap-workbook`` files, opened
  directly with :mod:`sqlite3` (created if missing);
* a path ending in ``.ap-workbook``: that one workbook;
* an ``http://`` or ``https://`` URL: an autophys daemon, which keeps its
  workbooks itself (W-8). The key comes from ``api_key=``,
  ``AUTOPHYS_API_KEY`` or ``~/.config/autophys/credentials``;
* nothing: ``$AUTOPHYS_HOME``, default ``~/autophys``.

``client.project(project)`` opens (or creates) one project's workbook. Pass
the :class:`~autophys.project.Project` to run investigations; pass its name
to read, review and approve only.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .agent import Investigation
from .project import Project
from .store import Store, StoreError
from .workbook import SUFFIX, WorkbookError, WorkbookStore, slug


def default_home() -> Path:
    return Path(os.environ.get("AUTOPHYS_HOME") or Path.home() / "autophys").expanduser()


def connect(target: str | os.PathLike | None = None, *, api_key: str | None = None) -> "Client":
    """Open a local collection, one workbook file, or a daemon URL."""
    if target is None:
        return LocalClient(default_home())
    text = os.fspath(target)
    if text.startswith(("http://", "https://")):
        from .http import HttpStore, load_credentials

        if api_key is None:
            creds = load_credentials(text)
            if creds is None:
                raise StoreError(f"no API key for {text}: pass api_key=, set AUTOPHYS_API_KEY or run `autophys pair`")
            api_key = creds.api_key
        return RemoteClient(HttpStore(text, api_key))
    path = Path(text).expanduser()
    if path.suffix == SUFFIX:
        return LocalClient(path.parent, only=path)
    return LocalClient(path)


class Client:
    """A connection to a collection of workbooks, one per project."""

    def projects(self) -> list[dict]:
        """``[{"id", "name"}]`` for every project in the collection."""
        raise NotImplementedError

    def project(self, project: Project | str) -> "Workbook":
        raise NotImplementedError

    def close(self) -> None:
        pass

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class LocalClient(Client):
    """Workbook files in a directory (or one file, ``only``), opened directly."""

    def __init__(self, root: str | Path, *, only: Path | None = None) -> None:
        self.root = Path(root).expanduser()
        self.only = only
        self._open: list[WorkbookStore] = []

    def __repr__(self) -> str:
        return f"LocalClient({str(self.only or self.root)!r})"

    def paths(self) -> list[Path]:
        if self.only is not None:
            return [self.only] if self.only.exists() else []
        return sorted(self.root.glob("*" + SUFFIX)) if self.root.is_dir() else []

    def projects(self) -> list[dict]:
        out = []
        for path in self.paths():
            with WorkbookStore(path, readonly=True) as wb:
                for p in wb.projects():
                    out.append({**p, "path": str(path)})
        return out

    def path_for(self, name: str) -> Path:
        return self.only if self.only is not None else self.root / (slug(name) + SUFFIX)

    def project(self, project: Project | str) -> "Workbook":
        name = project.name if isinstance(project, Project) else project
        path = self.path_for(name)
        if isinstance(project, Project):
            store = WorkbookStore(path)
        else:
            if not path.exists():
                raise WorkbookError("not_found", f"no workbook for project {name!r} at {path}")
            store = WorkbookStore(path, create=False)
        self._open.append(store)
        stored = store.project_name()
        if stored is not None and stored != name:
            raise WorkbookError("conflict", f"{path} holds project {stored!r}, not {name!r}")
        wb = Workbook(store, project if isinstance(project, Project) else None, name)
        if isinstance(project, Project):
            wb.project_id  # a new workbook records its project at once
        return wb

    def close(self) -> None:
        for s in self._open:
            s.close()
        self._open.clear()


class RemoteClient(Client):
    """A daemon's collection over ``/api/v1``; the daemon writes its workbooks."""

    def __init__(self, store: Store) -> None:
        self.store = store

    def __repr__(self) -> str:
        return f"RemoteClient({self.store!r})"

    def projects(self) -> list[dict]:
        return [{"id": p["id"], "name": p["name"]} for p in self.store.projects()]

    def project(self, project: Project | str) -> "Workbook":
        name = project.name if isinstance(project, Project) else project
        if not isinstance(project, Project) and name not in {p["name"] for p in self.projects()}:
            raise StoreError(f"no project {name!r} on {self.store!r}")
        return Workbook(self.store, project if isinstance(project, Project) else None, name)


class Workbook:
    """One project's workbook: its config versions and investigations."""

    def __init__(self, store: Store, project: Project | None, name: str) -> None:
        self.store = store
        self.project = project
        self.name = name
        self._id: str | None = None

    def __repr__(self) -> str:
        return f"Workbook({self.name!r}, {self.store!r})"

    @property
    def project_id(self) -> str:
        if self._id is None:
            if self.project is not None:
                self._id = self.store.ensure_project(self.name)
            else:
                match = [p["id"] for p in self.store.projects() if p["name"] == self.name]
                if not match:
                    raise StoreError(f"no project {self.name!r}")
                self._id = match[0]
        return self._id

    def _require_project(self, what: str) -> Project:
        if self.project is None:
            raise StoreError(f"{what} needs the Project (simulator and configuration): use client.project(project)")
        return self.project

    def investigate(self, dataset, runner, **kw: Any) -> Investigation:
        """Start a new investigation in this workbook (recorded at once; ``.run()`` runs it)."""
        return Investigation(self._require_project("investigate"), dataset, runner, store=self.store, **kw)

    def investigations(self) -> list[dict]:
        pid = self.project_id
        return [i for i in self.store.investigations() if i.get("project_id", pid) == pid]

    def investigation(self, investigation_id: str, runner: Any = None, **kw: Any) -> Investigation:
        """Resume an investigation from its records (see :meth:`Investigation.resume`)."""
        return Investigation.resume(self._require_project("investigation"), self.store, investigation_id, runner, **kw)

    def config_versions(self) -> list[dict]:
        return self.store.config_versions(self.project_id)

    def verify(self) -> dict:
        """Check every chain (and, for a local file, that projections match a rebuild)."""
        if isinstance(self.store, WorkbookStore):
            return self.store.check()
        errors, n = [], 0
        invs = self.investigations()
        for inv in invs:
            recs = self.store.records(inv["id"])
            n += len(recs)
            if not self.store.verify(inv["id"]):
                errors.append({"investigation": inv["id"]})
        return {"ok": not errors, "records": n, "investigations": len(invs), "chain_errors": errors,
                "projections_match": None}
