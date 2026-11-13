"""Demo overviews: render the demo projects' research notes and write them through the SDK (OV-5).

The notes live in ``ops/*.template.md``; their inserts name investigations by
placeholder, so a regenerated workbook gets its own ids:

- ``{{investigation_N}}``: the project's N-th investigation, oldest first.

``ops/demo_workbooks.py`` writes the oscillator and thermal notes as it generates
those workbooks. Run as a script, this
module makes a new demo seed version from an existing one:

    PYTHONPATH=sdks/python/src python3 ops/demo_overviews.py --from SEED_DIR --out NEW_DIR [--author autophys-demo]

It copies every workbook of SEED_DIR into the new, empty NEW_DIR with SQLite's
online backup (the source is opened read-only and never written), then appends
each known demo project's overview with one SDK write. Records, investigation
ids and chain heads are unchanged; the first overview write moves a workbook to
format 3, which only a daemon and SDKs that read format 3 can open. Installing
the new seed (``autophys workspace seed EMAIL --from NEW_DIR --version V``, into
an empty demo collection) is a separate, reviewed operation.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from autophys.workbook import WorkbookStore

OPS = Path(__file__).resolve().parent
TEMPLATES = {
    "battery_cycler_demo": "demo-overview-battery.template.md",
    "mass_spring_damper_demo": "demo-overview-oscillator.template.md",
    "thermal_rc_demo": "demo-overview-thermal.template.md",
}
AUTHOR = "autophys-demo"


def placeholders(store, project_id: str) -> dict[str, str]:
    """Placeholder name -> investigation id for one project of ``store``."""
    invs = [i for i in store.investigations() if i["project_id"] == project_id]
    out = {f"investigation_{n}": inv["id"] for n, inv in enumerate(invs, 1)}
    return out


def render(project: str, ids: dict[str, str]) -> str:
    """The project's note with its placeholders resolved; every placeholder must resolve."""
    markdown = (OPS / TEMPLATES[project]).read_text(encoding="utf-8")
    for name, inv in ids.items():
        markdown = markdown.replace("{{" + name + "}}", inv)
    if "{{" in markdown:
        raise ValueError(f"{TEMPLATES[project]}: unresolved placeholder near "
                         f"{markdown[markdown.index('{{'):][:40]!r}")
    return markdown


def write(store, project_id: str, project: str, author: str = AUTHOR, ids: dict[str, str] | None = None) -> dict:
    """Render and append the project's overview; a warning (an insert naming no
    investigation of this workbook, or an unknown attribute) is an error here."""
    markdown = render(project, placeholders(store, project_id) if ids is None else ids)
    stored, changed, warnings = store.put_overview(project_id, markdown, author)
    if warnings:
        raise ValueError(f"{project}: {[w['message'] for w in warnings]}")
    return {"seq": stored["seq"], "digest": stored["digest"], "author": stored["author"], "changed": changed}


def _state(store) -> dict:
    return {"investigations": [i["id"] for i in store.investigations()], "heads": store.heads()}


def new_seed(source: Path, out: Path, author: str = AUTHOR) -> list[dict]:
    """Copy ``source``'s workbooks into the empty ``out`` and add the demo overviews."""
    workbooks = sorted(source.glob("*.ap-workbook"))
    if not workbooks:
        raise ValueError(f"{source} holds no workbooks")
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f"{out} is not empty; write a new seed version into a fresh directory")
    out.mkdir(parents=True, exist_ok=True)
    report = []
    for path in workbooks:
        target = out / path.name
        src = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with WorkbookStore(target, create=False) as store:
            before = _state(store)
            entry = {"workbook": path.name, "projects": []}
            for project in store.projects():
                row = {"project": project["name"], "project_id": project["id"]}
                if project["name"] in TEMPLATES:
                    row["investigations"] = placeholders(store, project["id"])
                    row["overview"] = write(store, project["id"], project["name"], author)
                entry["projects"].append(row)
            check = store.check()
            if not check["ok"] or _state(store) != before:
                raise RuntimeError(f"{path.name}: the overview write changed records or failed the check: {check}")
        conn = sqlite3.connect(target)  # one self-contained file, like the source seed
        try:
            conn.execute("PRAGMA journal_mode = DELETE")
            entry["format"] = conn.execute("PRAGMA user_version").fetchone()[0]
        finally:
            conn.close()
        report.append(entry)
    return report


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="source", required=True, type=Path, help="the current seed collection (read only)")
    p.add_argument("--out", required=True, type=Path, help="a new, empty directory for the new seed version")
    p.add_argument("--author", default=AUTHOR, help=f"author recorded on each overview (default {AUTHOR})")
    args = p.parse_args(argv)
    try:
        print(json.dumps(new_seed(args.source, args.out, args.author), indent=2))
    except (ValueError, FileExistsError, RuntimeError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
