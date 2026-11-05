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
