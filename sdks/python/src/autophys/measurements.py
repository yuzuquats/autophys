"""Lab CSV import with explicit channel/noise mapping and declared input checks.

The Rust counterpart is ``autophys::measurements::read_csv`` (used by ``autophys mcp``).
"""
from __future__ import annotations

import csv
import hashlib
import io
from pathlib import Path

import numpy as np

from .data import Observation
from .models.battery import battery_ecm, current
from .project import Project
from .simulator import time_grid


def read_csv(project: Project, root: Path, path: str, experiment: str, *,
             settings: dict | None = None, columns: dict[str, str] | None = None,
             sigma: dict[str, float] | None = None, split: str = "train") -> Observation:
    """Map logical t/output/current names to CSV headers; never infer sigma."""
    if split not in ("train", "validation"):
        raise ValueError("split must be train or validation; test data is evaluator-only")
    file = (root / path).expanduser().resolve()
    if not file.is_relative_to(root.resolve()):
        raise ValueError("CSV must be inside the configured lab root")
    if file.stat().st_size > 1 << 20:
        raise ValueError("CSV exceeds 1 MiB; split it into smaller measurements")
    raw = file.read_bytes()
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    names = reader.fieldnames or []
    if len(names) != len(set(names)):
        raise ValueError("CSV headers must be unique")
    battery = project.simulator.fn is battery_ecm.fn
    mapping = dict(columns or ({"t": "time", "current": "current", "v": "voltage"} if battery
                               else {"t": "time", **{ch: ch for ch in project.simulator.outputs}}))
    outputs = project.simulator.outputs
    required = {"t", *outputs, *(("current",) if battery else ())}
    if set(mapping) != required or any(v not in names for v in mapping.values()):
        raise ValueError(f"columns must map {sorted(required)} to existing CSV headers")
    try:
        rows = list(reader)
        if not 2 <= len(rows) <= 10000:
            raise ValueError("CSV needs 2..10000 rows")
        values = {key: np.array([float(row[header]) for row in rows]) for key, header in mapping.items()}
    except (TypeError, KeyError, ValueError) as exc:
        raise ValueError(f"invalid numeric CSV: {exc}") from None
    if any(not np.isfinite(v).all() for v in values.values()):
        raise ValueError("CSV values must be finite")
    t = values["t"]
    if t[0] != 0 or np.any(np.diff(t) <= 0):
        raise ValueError("time must start at zero and increase strictly (seconds)")
    supplied_settings = settings is not None
    settings = dict(settings if supplied_settings else project.simulator.experiment(experiment))
    grid = time_grid(settings)
    if grid.shape != t.shape or not np.allclose(grid, t, rtol=1e-9, atol=1e-9):
        raise ValueError("CSV time grid differs from the declared/approved experiment")
    if battery:
        expected = np.array([current(settings)(tt) for tt in t])
        if not np.allclose(values["current"], expected, rtol=1e-5, atol=1e-6):
            raise ValueError("CSV current differs from the declared/approved battery waveform; declare a matching experiment")
    noise = dict(sigma if sigma is not None else project.noise.sigma or {})
    if set(noise) != set(outputs) or any(not np.isfinite(s) or s <= 0 for s in noise.values()):
        raise ValueError(f"sigma must declare a finite positive standard deviation for {list(outputs)}")
    return Observation(experiment, settings, t, {ch: values[ch] for ch in outputs}, noise,
                       split=split, source="csv", meta={"path": str(file.relative_to(root.resolve())),
                       "csv_sha256": hashlib.sha256(raw).hexdigest(), "columns": mapping})
