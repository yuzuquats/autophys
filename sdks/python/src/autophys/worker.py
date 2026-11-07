"""Serve one trusted lab simulator to the ``autophys`` binary over a pipe.

``python -m autophys.worker [--root DIR] mypkg.module:project`` is an internal
protocol endpoint, not a user command: ``autophys mcp --project
mypkg.module:project`` spawns it so the Rust tools can drive a simulator
written in Python (cli.md CLI-11). Users never run it themselves.

Protocol (version 1): newline-delimited JSON. Requests arrive on stdin and
frames leave on the original stdout; everything else (user ``print`` calls,
warnings, C-level writes to fd 1) goes to stderr, so user code cannot corrupt
the stream. The first frame describes the project, or the load error::

    {"protocol": "autophys-worker", "version": 1, "ok": true, "project": {...}}
    {"protocol": "autophys-worker", "version": 1, "ok": false, "error": {"kind": "load", "message": "..."}}

Then one reply per request, in order::

    {"id": 1, "op": "simulate", "params": {...}, "experiment": {...}, "options": {"rtol": .., "atol": .., "seed": null}}
    {"id": 1, "ok": true, "result": {"y": {"t": [...], "<output>": [...]}, "u": {"<input>": [...]}}}
    {"id": 1, "ok": false, "error": {"kind": "bounds|simulation|invalid|budget|protocol", "message": "..."}}

Non-finite floats travel as Python's ``NaN``/``Infinity`` tokens. The worker
never charges a call budget; the caller counts calls. It exits 0 when stdin
closes.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Mapping

PROTOCOL = "autophys-worker"
VERSION = 1


def _plain(o: Any):
    """json.dumps ``default``: NumPy scalars and arrays as Python values."""
    import numpy as np

    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, (tuple, set, frozenset)):
        return list(o)
    raise TypeError(f"{type(o).__name__} is not JSON serializable")


def dumps(frame: Mapping) -> str:
    return json.dumps(frame, default=_plain, allow_nan=True)


def describe(project) -> dict:
    """The project as the binary rebuilds it: schema, settings and identities."""
    from dataclasses import asdict

    sim = project.simulator
    display = None
    if sim.display is not None:
        d = sim.display
        display = {"channels": d.channels, "params": d.params, "settings": d.settings,
                   "experiments": d.experiments, "default_view": d.default_view}
    return {
        "name": project.name,
        "simulator": {**sim.schema(), "source_hash": sim.source_hash, "description": sim.description},
        "display": display,
        "initial": {k: float(v) for k, v in project.initial.items()},
        "fixed": list(project.fixed),
        "catalog": project.catalog,
        "noise": asdict(project.noise),
        "budgets": asdict(project.budgets),
        "stop": project.config()["stop"],
        "policy": asdict(project.policy),
        "n_starts": project.n_starts,
        "config_version": project.config_version,
    }


def simulate(sim, request: Mapping) -> dict:
    """One uncounted call; the result the Python simulator returns."""
    import numpy as np
    from .simulator import FIT_OPTIONS, SimOptions

    params, experiment = request.get("params"), request.get("experiment")
    if not isinstance(params, Mapping) or not isinstance(experiment, Mapping):
        raise ValueError("simulate needs params and experiment objects")
    o = request.get("options") or {}
    options = SimOptions(float(o.get("rtol", FIT_OPTIONS.rtol)), float(o.get("atol", FIT_OPTIONS.atol)), o.get("seed"))
    out = sim(params, experiment, options=options, count=False)
    as_list = lambda v: np.asarray(v, dtype=float).tolist()
    return {"y": {k: as_list(v) for k, v in out.items()},
            "u": {k: as_list(v) for k, v in getattr(out, "u", {}).items()}}


def error_kind(exc: BaseException) -> str:
    from .simulator import BoundsError, SimulationBudgetExceeded, SimulationError

    if isinstance(exc, BoundsError):
        return "bounds"
    if isinstance(exc, SimulationBudgetExceeded):
        return "budget"
    if isinstance(exc, SimulationError):
        return "simulation"
    return "invalid"


def handle(sim, line: str) -> dict:
    try:
        request = json.loads(line)
    except ValueError as exc:
        return {"id": None, "ok": False, "error": {"kind": "protocol", "message": f"invalid JSON: {exc}"}}
    rid = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request, dict) or request.get("op") != "simulate":
        op = request.get("op") if isinstance(request, dict) else None
        return {"id": rid, "ok": False, "error": {"kind": "protocol", "message": f"unknown op {op!r}"}}
    try:
        return {"id": rid, "ok": True, "result": simulate(sim, request)}
    except Exception as exc:  # noqa: BLE001 - mapped to a typed error for the caller
        message = exc.args[0] if isinstance(exc, KeyError) and exc.args else str(exc)
        return {"id": rid, "ok": False, "error": {"kind": error_kind(exc), "message": str(message)}}


def _isolate_stdio():
    """Keep the protocol on private descriptors; fd 1 and sys.stdout become stderr."""
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    inp = os.fdopen(os.dup(0), "r", encoding="utf-8")
    os.dup2(2, 1)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdout = sys.stderr
    sys.stdin = open(os.devnull)
    return inp, out


def serve(reference: str, root: str | None, inp, out) -> int:
    def send(frame):
        out.write(dumps(frame) + "\n")
        out.flush()

    head = {"protocol": PROTOCOL, "version": VERSION}
    if root:
        sys.path.insert(0, os.path.abspath(root))
    try:
        from .project import load_project

        project = load_project(reference)
        description = describe(project)
        dumps(description)
    except Exception as exc:  # noqa: BLE001 - the binary reports it with the reference
        import traceback

        traceback.print_exc(file=sys.stderr)
        send({**head, "ok": False, "error": {"kind": "load", "message": f"{type(exc).__name__}: {exc}"}})
        return 1
    send({**head, "ok": True, "project": description})
    for line in inp:
        if line.strip():
            send(handle(project.simulator, line))
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m autophys.worker",
                                     description="internal: serve a lab simulator to autophys mcp")
    parser.add_argument("--root", help="directory to import the lab module from (prepended to sys.path)")
    parser.add_argument("project", help="battery_ecm or mypkg.module:project")
    args = parser.parse_args(argv)
    inp, out = _isolate_stdio()
    return serve(args.project, args.root, inp, out)


if __name__ == "__main__":
    sys.exit(main())
