"""Observations and versioned datasets.

An :class:`Observation` is one experiment's measured channels on a time grid,
with a known noise standard deviation per channel and a split label. Missing
samples are NaN and are excluded from every objective. A :class:`Dataset`
only grows; each addition bumps its version, and every fit records the
version it used.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

import numpy as np

SPLITS = ("train", "validation", "test")


def _type_name(v: Any) -> str:
    t = type(v)
    return t.__qualname__ if t.__module__ == "builtins" else f"{t.__module__}.{t.__qualname__}"


def _json_problem(v: Any, path: str, leaf: str) -> tuple[str, str] | None:
    """The first non-JSON value under ``v`` as ``(path, reason)``, or None.

    Accepts exactly what ``json.dumps(..., allow_nan=False)`` encodes without
    a ``default`` hook and without changing a value's type: so the record
    digest and the replayed record see the settings the live run used.
    """
    if v is None or isinstance(v, (str, bool, int)):
        return None
    if isinstance(v, float):
        if np.isfinite(v):
            return None
        return path, f"must be a JSON value (got {v!r}); JSON has no NaN or infinity, use a finite number or None"
    if isinstance(v, (list, tuple)):
        for i, x in enumerate(v):
            if (bad := _json_problem(x, f"{path}[{i}]", f"{leaf}[{i}]")) is not None:
                return bad
        return None
    if isinstance(v, Mapping):
        for k, x in v.items():
            if not isinstance(k, str):
                return path, (f"must be a JSON value (key {k!r} is {_type_name(k)}); "
                              f"JSON object keys are strings, e.g. {str(k)!r}")
            if (bad := _json_problem(x, f"{path}.{k}", k)) is not None:
                return bad
        return None
    got = f"must be a JSON value (got {_type_name(v)})"
    if isinstance(v, np.ndarray):
        return path, f"{got}; use a list, e.g. {leaf}.tolist()"
    if isinstance(v, np.generic):
        return path, f"{got}; use a plain Python value, e.g. {leaf}.item()"
    return path, f"{got}; use a dict, list, str, int, float, bool or None"


def check_settings(experiment: str, settings: Any) -> None:
    """Raise ValueError naming the experiment and setting unless ``settings``
    is a mapping of JSON values (G7-VAL). Values are never converted."""
    if not isinstance(settings, Mapping):
        raise ValueError(f"experiment {experiment!r}: settings must be a mapping (got {_type_name(settings)})")
    for k, v in settings.items():
        if not isinstance(k, str):
            raise ValueError(f"experiment {experiment!r}: setting names must be strings (got {k!r})")
        if (bad := _json_problem(v, k, k)) is not None:
            raise ValueError(f"experiment {experiment!r}: setting {bad[0]!r} {bad[1]}")


@dataclass
class Observation:
    experiment: str
    settings: dict
    t: np.ndarray
    y: dict[str, np.ndarray]
    sigma: dict[str, float]
    split: str = "train"
    source: str = "measured"
    meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.split not in SPLITS:
            raise ValueError(f"split must be one of {SPLITS}")
        self.t = np.asarray(self.t, dtype=float)
        self.y = {k: np.asarray(v, dtype=float) for k, v in self.y.items()}
        self.validate()

    def validate(self) -> None:
        if self.split not in SPLITS:
            raise ValueError(f"split must be one of {SPLITS}")
        check_settings(self.experiment, self.settings)
        for ch, v in self.y.items():
            if v.shape != self.t.shape:
                raise ValueError(f"channel {ch}: shape {v.shape} != t {self.t.shape}")
            if ch not in self.sigma or not np.isfinite(self.sigma[ch]) or not self.sigma[ch] > 0:
                raise ValueError(f"channel {ch}: need a finite positive sigma")

    @property
    def n_samples(self) -> int:
        return int(sum(np.isfinite(v).sum() for v in self.y.values()))

    def to_dict(self) -> dict:
        self.validate()
        def arr(a):
            return [None if not np.isfinite(x) else float(x) for x in a]

        return {
            "experiment": self.experiment,
            "settings": self.settings,
            "t": arr(self.t),
            "y": {k: arr(v) for k, v in self.y.items()},
            "sigma": self.sigma,
            "split": self.split,
            "source": self.source,
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Observation":
        def arr(a):
            return np.array([np.nan if x is None else x for x in a], dtype=float)

        return cls(
            experiment=d["experiment"],
            settings=dict(d["settings"]),
            t=arr(d["t"]),
            y={k: arr(v) for k, v in d["y"].items()},
            sigma=dict(d["sigma"]),
            split=d.get("split", "train"),
            source=d.get("source", "measured"),
            meta=dict(d.get("meta", {})),
        )

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(self.to_dict(), sort_keys=True).encode()).hexdigest()[:16]


class Dataset:
    """Append-only list of observations with a monotonically increasing version."""

    def __init__(self, observations: Iterable[Observation] = ()) -> None:
        self._obs: list[Observation] = []
        self.version = 0
        for o in observations:
            self.add(o)

    def add(self, obs: Observation) -> int:
        obs.validate()
        if obs.split == "test":
            raise ValueError("the test split is evaluator-only and never enters an agent dataset")
        self._obs.append(obs)
        self.version += 1
        return self.version

    def __iter__(self):
        return iter(list(self._obs))

    def __len__(self) -> int:
        return len(self._obs)

    def split(self, name: str) -> list[Observation]:
        return [o for o in self._obs if o.split == name]

    def noise(self) -> dict[str, float]:
        """Median declared sigma per channel, used for candidate experiments."""
        by: dict[str, list[float]] = {}
        for o in self._obs:
            o.validate()
            for ch, s in o.sigma.items():
                by.setdefault(ch, []).append(s)
        return {ch: float(np.median(v)) for ch, v in by.items()}

    def digest(self) -> str:
        h = hashlib.sha256()
        for o in self._obs:
            h.update(o.digest().encode())
        return h.hexdigest()[:16]
