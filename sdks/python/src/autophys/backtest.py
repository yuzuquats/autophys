"""Backtest examples: a hidden system a model must discover through the investigation loop.

A backtest is declared as data (``examples/<name>.backtest/``), and the Rust
SDK reads the same files:

* ``example.toml`` is what the model is told: the simulator, and each case's
  starting data and budget.
* ``hidden/cases.toml`` holds the truth, the noise, the held-out test
  experiments and how each case is scored. It reaches the
  :class:`~autophys.synthetic.Evaluator` and the runner's closure, never a
  policy.

The built-in backtests ship with this package (``autophys/backtests/``), as
copies of the repository's ``examples/*.backtest``; a test keeps them
byte-identical.

A case either generates data from the simulator at the hidden truth, or
replays recorded runs (``[[dataset]]``, decision EX-5): the experiment menu is
then exactly the recorded runs, and the score is prediction error on
held-out runs, plus parameter error when the truth is known. Dataset files
are fetched by URL and sha256 into the data directory (EX-7); a folder on
disk may also point at a local ``file``. The simulator is a built-in model or
the example's own Python project (``[system] project = "module:attr"``,
EX-6). ``drawn=True`` draws a generator case's truth per seed from
``[prior]`` (EX-4). The Rust SDK implements the same format and draws.

A reference is ``[SCHEME:]SOURCE[#CASE]`` (decision EX-10): ``builtin:NAME``
(a bare name is the same) or ``path:DIR`` (a source starting with ``./``,
``../``, ``/`` or ``~`` is the same). Built-in cases keep their stable ids
(``battery``, ``battery-short-only``, ...), which records, replay files and
results use; ``builtin:battery#full`` and ``battery`` name the same case.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

#: The built-in backtests, in suite order.
BUILTIN = ("oscillator", "thermal", "battery", "battery-recorded")
KINDS = ("template", "demo", "backtest")
_NAME = re.compile(r"[a-z0-9-]+\Z")


@dataclass(frozen=True)
class Ref:
    """A parsed reference. ``source`` is ``("builtin", name)`` or ``("path", dir)``."""

    scheme: str
    source: str
    case: str | None = None

    def canonical(self) -> str:
        text = f"{self.scheme}:{self.source}"
        return f"{text}#{self.case}" if self.case else text


def split_kind(dir_name: str) -> tuple[str, str] | None:
    """``NAME.KIND`` as ``(name, kind)``, when the suffix is a kind."""
    name, dot, kind = dir_name.rpartition(".")
    return (name, kind) if dot and kind in KINDS and _NAME.match(name) else None


def _builtin_name(name: str, text: str) -> str:
    split = split_kind(name)
    name = split[0] if split else name
    if not _NAME.match(name):
        raise ValueError(f"{text!r}: a built-in example name is lowercase letters, digits and -")
    return name


def parse_ref(text: str) -> Ref:
    source, hash_, case = text.partition("#")
    if hash_ and not _NAME.match(case):
        raise ValueError(f"{text!r}: the case after # must be lowercase letters, digits and -")
    case = case or None
    if source.startswith("builtin:"):
        return Ref("builtin", _builtin_name(source[len("builtin:"):], text), case)
    if source.startswith("path:"):
        if not source[len("path:"):]:
            raise ValueError(f"{text!r}: path: needs a directory")
        return Ref("path", os.path.expanduser(source[len("path:"):]), case)
    if source.startswith(("./", "../", "/", "~")) or source in (".", ".."):
        return Ref("path", os.path.expanduser(source), case)
    if ":" in source:
        raise ValueError(f"{text!r}: unknown scheme {source.split(':', 1)[0]!r}; use builtin:NAME or path:DIR")
    return Ref("builtin", _builtin_name(source, text), case)


@dataclass
class CaseSpec:
    """One case: what the model is told, plus its hidden scoring."""

    name: str
    id: str
    suite: bool
    max_experiments: int
    max_test_hours: float | None
    train: list
    validation: list
    bias: dict = field(default_factory=dict)
    missing: float = 0.0
    combos: dict = field(default_factory=dict)
    expected_non_identified: set = field(default_factory=set)
    note: str = ""
    source: str = "generator"
    test_datasets: list = field(default_factory=list)


@dataclass
class DatasetSpec:
    """A recorded run (``[[dataset]]``)."""

    name: str
    settings: dict
    file: str | None
    url: str | None
    sha256: str
    columns: dict
    sigma: dict
    provenance: str
    hidden: bool = False


def _numbers(table: Any, what: str) -> dict[str, float]:
    if not isinstance(table, dict):
        raise ValueError(f"{what} must be a table of numbers")
    out = {}
    for k, v in table.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{what}.{k} must be a number")
        out[k] = v
    return out


def _experiments(items: Any, what: str) -> list:
    if items is None:
        return []
    if not isinstance(items, list) or not all(isinstance(e, (str, dict)) for e in items):
        raise ValueError(f"{what}: each entry is a catalog name or a settings table")
    return items


def simulator(model: str):
    """The built-in simulator a backtest names (decision EX-6)."""
    from .models import oscillator, thermal_rc
    from .models.battery import battery_ecm

    sims = {"battery_ecm": battery_ecm, "oscillator": oscillator, "thermal_rc": thermal_rc}
    if model not in sims:
        raise ValueError(f"unknown model {model!r}; use battery_ecm, oscillator or thermal_rc, "
                         'or [system] project = "module:attr"')
    return sims[model]


def datasets_dir() -> Path:
    """``AUTOPHYS_DATASETS_DIR``, else ``$XDG_DATA_HOME/tento/autophys/datasets``, else ``~/.local/share/...``."""
    if os.environ.get("AUTOPHYS_DATASETS_DIR"):
        return Path(os.environ["AUTOPHYS_DATASETS_DIR"])
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "tento" / "autophys" / "datasets"


def _datasets(items: Any, hidden: bool, what: str) -> list[DatasetSpec]:
    out = []
    for d in items or []:
        dw = f"{what} dataset {d.get('name')}"
        if ("file" in d) == ("url" in d):
            raise ValueError(f"{dw}: give exactly one of file or url")
        sha = d.get("sha256", "")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", sha):
            raise ValueError(f"{dw}: sha256 must be 64 hex digits")
        columns = d.get("columns") or {}
        if "t" not in columns or len(columns) < 2:
            raise ValueError(f"{dw}: columns needs t (the time column) and at least one channel")
        sigma = _numbers(d.get("sigma"), f"{dw} sigma")
        missing = next((c for c in columns if c != "t" and c not in sigma), None)
        if missing:
            raise ValueError(f"{dw}: channel {missing} has no sigma")
        if d.get("provenance") not in ("synthetic", "measured"):
            raise ValueError(f"{dw}: provenance is synthetic or measured")
        if d["provenance"] == "measured" and not (d.get("license") and d.get("source")):
            raise ValueError(f"{dw}: measured data needs a license and a source")
        out.append(DatasetSpec(d["name"], dict(d["settings"]), d.get("file"), d.get("url"), sha.lower(),
                               dict(columns), sigma, d["provenance"], hidden))
    return out


def _interp(x: float, xp, fp) -> float:
    """``numpy.interp`` for one point, in the Rust SDK's arithmetic order."""
    if x <= xp[0]:
        return fp[0]
    if x >= xp[-1]:
        return fp[-1]
    import bisect

    j = bisect.bisect_right(xp, x) - 1
    slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j])
    return slope * (x - xp[j]) + fp[j]


@dataclass
class Backtest:
    name: str
    scheme: str
    source: str
    title: str
    summary: str
    model: str
    setup_hours: float | None
    cases: list[CaseSpec]
    truth: dict
    sigma: dict
    test: list
    project: str | None = None
    prior: dict = field(default_factory=dict)
    datasets: list = field(default_factory=list)

    @classmethod
    def parse(cls, name: str, scheme: str, source: str, example: str, hidden: str) -> "Backtest":
        what = f"{name}.backtest"
        ex = tomllib.loads(example)
        hid = tomllib.loads(hidden)
        if ex.get("kind") != "backtest":
            raise ValueError(f"{what}: kind is {ex.get('kind')!r}, not 'backtest'")
        system = ex.get("system") or {}
        model, project = system.get("model"), system.get("project")
        if (model is None) == (project is None):
            raise ValueError(f"{what}: [system] needs exactly one of model or project")
        if model is not None:
            simulator(model)
        elif scheme != "path":
            raise ValueError(f"{what}: a built-in backtest uses a built-in model (EX-6)")
        elif ":" not in project:
            raise ValueError(f'{what}: project is "module:attr"')
        cost = system.get("experiment_cost")
        setup_hours = None if cost is None else cost["setup_hours"]
        truth = _numbers(hid.get("truth", {}), f"{what} [truth]")
        prior = {}
        for k, v in (hid.get("prior") or {}).items():
            pw = f"{what} prior.{k}"
            if k not in truth:
                raise ValueError(f"{pw}: [truth] has no {k}")
            kinds = [x for x in ("uniform", "log_uniform") if x in v]
            lo, hi = (v[kinds[0]] + [None, None])[:2] if len(kinds) == 1 else (None, None)
            if (len(kinds) != 1 or len(v[kinds[0]]) != 2 or not lo < hi
                    or (kinds[0] == "log_uniform" and not lo > 0)):
                raise ValueError(f"{pw}: give uniform = [lo, hi] or log_uniform = [lo, hi] (0 < lo < hi)")
            if not lo <= truth[k] <= hi:
                raise ValueError(f"{pw}: the fixed truth {truth[k]} is outside [{lo}, {hi}]")
            prior[k] = (kinds[0], float(lo), float(hi))
        sigma = _numbers((hid.get("noise") or {}).get("sigma", {}), f"{what} noise.sigma")
        test = _experiments(hid.get("test"), f"{what} [[test]]")
        datasets = _datasets(ex.get("dataset"), False, what) + _datasets(hid.get("dataset"), True, f"{what} (hidden)")
        seen = set()
        for d in datasets:
            if d.name in seen:
                raise ValueError(f"{what}: dataset {d.name} declared twice")
            seen.add(d.name)
            if d.file and scheme == "builtin":
                raise ValueError(f"{what}: dataset {d.name}: a built-in backtest fetches data by url (EX-7)")
        hidden_cases = hid.get("case") or {}
        cases: list[CaseSpec] = []
        for c in ex.get("case") or []:
            case_name = c.get("name", "")
            cw = f"{what}#{case_name}"
            if not _NAME.match(case_name):
                raise ValueError(f"{cw}: a case name is lowercase letters, digits and -")
            if any(x.name == case_name for x in cases):
                raise ValueError(f"{cw}: case declared twice")
            case_id = c["id"] if scheme == "builtin" else Ref(scheme, source, case_name).canonical()
            budget = c.get("budget") or {}
            max_experiments = budget.get("max_experiments", 0)
            if isinstance(max_experiments, bool) or not isinstance(max_experiments, int) or max_experiments < 0:
                raise ValueError(f"{cw}: budget.max_experiments must be a whole number")
            max_test_hours = budget.get("max_test_hours")
            if case_name not in hidden_cases:
                raise ValueError(f"{cw}: hidden/cases.toml has no [case.{case_name}]")
            h = hidden_cases[case_name]
            combos = {k: _numbers(v, f"{cw} combos.{k}") for k, v in (h.get("combos") or {}).items()}
            for combo, powers in combos.items():
                missing_param = next((p for p in powers if p not in truth), None)
                if missing_param:
                    raise ValueError(f"{cw}: combo {combo} names {missing_param}, which [truth] lacks")
            source_kind = c.get("source", "generator")
            train = _experiments(c.get("train"), f"{cw} train")
            validation = _experiments(c.get("validation"), f"{cw} validation")
            test_datasets = list(h.get("test", []))
            if source_kind == "generator":
                if not truth or not sigma:
                    raise ValueError(f"{cw}: a generator case needs [truth] and [noise] sigma in hidden/cases.toml")
                if not combos:
                    raise ValueError(f"{cw}: a generator case scores combos")
            elif source_kind == "datasets":
                by_name = {d.name: d for d in datasets}
                for n in train + validation:
                    if not isinstance(n, str) or n not in by_name:
                        raise ValueError(f"{cw}: no dataset {n}")
                    if by_name[n].hidden:
                        raise ValueError(f"{cw}: hidden dataset {n} can only be a test")
                if not test_datasets:
                    raise ValueError(f"{cw}: a dataset case names held-out runs: [case.{case_name}] test = [...]")
                missing_test = next((n for n in test_datasets if n not in by_name), None)
                if missing_test:
                    raise ValueError(f"{cw}: no dataset {missing_test}")
            else:
                raise ValueError(f"{cw}: source {source_kind!r}: use generator or datasets")
            cases.append(CaseSpec(
                name=case_name, id=case_id, suite=c.get("suite", True),
                max_experiments=max_experiments, max_test_hours=max_test_hours,
                train=train, validation=validation, source=source_kind, test_datasets=test_datasets,
                bias=_numbers(h.get("bias", {}), f"{cw} bias"), missing=h.get("missing", 0.0),
                combos=combos, expected_non_identified=set(h.get("expected_non_identified", [])),
                note=h.get("note", ""),
            ))
        if not cases:
            raise ValueError(f"{what}: no [[case]]")
        extra = next((k for k in hidden_cases if not any(c.name == k for c in cases)), None)
        if extra:
            raise ValueError(f"{what}: hidden [case.{extra}] has no [[case]] in example.toml")
        return cls(name, scheme, source, ex["title"], ex["summary"], model, setup_hours, cases, truth, sigma, test,
                   project=project, prior=prior, datasets=datasets)

    @classmethod
    def builtin(cls, name: str) -> "Backtest":
        if name not in BUILTIN:
            raise KeyError(f"no built-in backtest {name!r}; built-in: {', '.join(BUILTIN)}")
        base = resources.files("autophys").joinpath("backtests", f"{name}.backtest")
        return cls.parse(name, "builtin", name, base.joinpath("example.toml").read_text(encoding="utf-8"),
                         base.joinpath("hidden", "cases.toml").read_text(encoding="utf-8"))

    @classmethod
    def load_dir(cls, path: str | Path) -> "Backtest":
        d = Path(path).resolve(strict=True)
        split = split_kind(d.name)
        if not split or split[1] != "backtest":
            raise ValueError(f"{d}: a backtest folder is named NAME.backtest")
        return cls.parse(split[0], "path", str(d), (d / "example.toml").read_text(encoding="utf-8"),
                         (d / "hidden" / "cases.toml").read_text(encoding="utf-8"))

    @classmethod
    def load(cls, ref: Ref) -> "Backtest":
        return cls.builtin(ref.source) if ref.scheme == "builtin" else cls.load_dir(ref.source)

    def case(self, name: str) -> CaseSpec:
        for c in self.cases:
            if c.name == name:
                return c
        raise KeyError(f"{self.name} has no case {name!r}; cases: {', '.join(c.name for c in self.cases)}")

    def reference(self, case: CaseSpec) -> str:
        return Ref(self.scheme, self.source, case.name).canonical()

    def simulator(self):
        """The built-in model, or the example's own Python project (imported from its folder)."""
        if self.project is None:
            return simulator(self.model)
        from .project import load_project

        if self.source not in sys.path:
            sys.path.insert(0, self.source)
        return load_project(self.project).simulator

    def truth_for(self, seed: int, drawn: bool = False) -> dict:
        """The fixed ``[truth]``, or ``[prior]`` parameters drawn in ``[truth]`` order from ``default_rng([seed, 3])``."""
        if not drawn or not self.prior:
            return dict(self.truth)
        import numpy as np

        rng = np.random.default_rng([seed, 3])
        out = {}
        for k, v in self.truth.items():
            if k not in self.prior:
                out[k] = v
                continue
            kind, lo, hi = self.prior[k]
            u = float(rng.random())
            out[k] = lo + (hi - lo) * u if kind == "uniform" else math.exp(math.log(lo) + (math.log(hi) - math.log(lo)) * u)
        return out

    def dataset(self, name: str) -> DatasetSpec:
        for d in self.datasets:
            if d.name == name:
                return d
        raise KeyError(f"{self.name}: no dataset {name}")

    def dataset_bytes(self, d: DatasetSpec) -> bytes:
        """A dataset's bytes, checked against its sha256 (a local ``file``, or a ``url`` cached once)."""
        def check(data: bytes, where: str) -> bytes:
            got = hashlib.sha256(data).hexdigest()
            if got != d.sha256:
                raise ValueError(f"dataset {d.name} from {where} has sha256 {got}, not {d.sha256}")
            return data

        if d.file:
            if self.scheme != "path":
                raise ValueError("a built-in backtest fetches data by url")
            path = Path(self.source) / d.file
            return check(path.read_bytes(), str(path))
        cache = datasets_dir() / d.sha256
        if cache.exists():
            data = cache.read_bytes()
            if hashlib.sha256(data).hexdigest() == d.sha256:
                return data
        url = d.url or ""
        if url.startswith("file://"):
            data = Path(url[len("file://"):]).read_bytes()
        elif url.startswith(("https://", "http://")):
            with urllib.request.urlopen(url) as response:  # noqa: S310 - the url and sha256 come from the manifest
                data = response.read()
        else:
            raise ValueError(f"dataset {d.name}: url must be https://, http:// or file://")
        data = check(data, url)
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_name(f".{d.sha256}.{os.getpid()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cache)
        return data

    def recorded(self, name: str, split: str):
        """A recorded run as an observation on its settings' time grid."""
        import csv
        import io

        from .data import Observation
        from .simulator import time_grid

        d = self.dataset(name)
        what = f"dataset {name}"
        rows = list(csv.reader(io.StringIO(self.dataset_bytes(d).decode("utf-8-sig"))))
        rows = [r for r in rows if any(cell.strip() for cell in r)]
        if not rows:
            raise ValueError(f"{what}: empty CSV")
        header = [h.strip() for h in rows[0]]
        cols = {h: [] for h in header}
        for i, r in enumerate(rows[1:]):
            if len(r) != len(header):
                raise ValueError(f"{what}: row {i + 2} has {len(r)} cells, not {len(header)}")
            for h, cell in zip(header, r):
                cols[h].append(float(cell))

        def col(key):
            if d.columns[key] not in cols:
                raise ValueError(f"{what}: no column {d.columns[key]!r}")
            return cols[d.columns[key]]

        t = col("t")
        if len(t) < 2 or any(b <= a for a, b in zip(t, t[1:])):
            raise ValueError(f"{what}: time must strictly increase")
        grid = [float(x) for x in time_grid(d.settings)]
        tol = max(0.5, 1e-6 * abs(grid[-1]))
        if t[0] > grid[0] + tol or t[-1] < grid[-1] - tol:
            raise ValueError(f"{what}: covers {t[0]}..{t[-1]} s; its settings run {grid[0]}..{grid[-1]} s")
        y = {ch: [_interp(x, t, col(ch)) for x in grid] for ch in d.columns if ch != "t"}
        return Observation(experiment=name, settings=dict(d.settings), t=grid, y=y, sigma=dict(d.sigma),
                           split=split, source=d.provenance, meta={"dataset": name, "sha256": d.sha256})

    def build(self, case: CaseSpec, seed: int, *, max_experiments: int | None = None,
              bias: dict | None = None, missing: float | None = None, drawn: bool = False):
        """The case's view (for the policy) and evaluator (for scoring)."""
        from .synthetic import CaseView, Evaluator, NoiseModel, RecordedRunner, _build

        sim = self.simulator()

        def cost(settings):
            return None if self.setup_hours is None else self.setup_hours + settings["duration"] / 3600.0

        budget = case.max_experiments if max_experiments is None else max_experiments
        if case.source == "datasets":
            import copy

            from .data import Dataset

            used = {*case.train, *case.validation, *case.test_datasets}
            menu = [d for d in self.datasets if not d.hidden and d.name not in used]
            sim = copy.copy(sim)
            sim.experiments = {d.name: dict(d.settings) for d in self.datasets if not d.hidden}
            ds = Dataset()
            for split, names in (("train", case.train), ("validation", case.validation)):
                for n in names:
                    ds.add(self.recorded(n, split))
            runner = RecordedRunner({d.name: self.recorded(d.name, "train") for d in menu})
            view = CaseView(case.id, sim, ds, runner, budget)
            view.max_test_hours = case.max_test_hours
            view.catalog = {d.name: {"max_runs": 1, **({} if self.setup_hours is None else {"cost_hours": cost(d.settings)})}
                            for d in menu}
            ev = Evaluator(case.id, dict(self.truth), [self.recorded(n, "test") for n in case.test_datasets],
                           {k: dict(v) for k, v in case.combos.items()}, set(case.expected_non_identified), case.note)
            return view, ev
        noise = NoiseModel(dict(self.sigma), dict(case.bias) if bias is None else bias,
                           case.missing if missing is None else missing)
        view, ev = _build(case.id, sim, self.truth_for(seed, drawn), noise, seed,
                          train=list(case.train), validation=list(case.validation), test=list(self.test),
                          max_experiments=budget,
                          combos={k: dict(v) for k, v in case.combos.items()},
                          expected=set(case.expected_non_identified), note=case.note)
        view.max_test_hours = case.max_test_hours
        if self.setup_hours is not None:
            view.catalog = {n: {"max_runs": None, "cost_hours": cost(e)} for n, e in sim.experiments.items()}
        return view, ev


def builtins() -> list[Backtest]:
    return [Backtest.builtin(n) for n in BUILTIN]


def suite() -> list[str]:
    """The default suite's case ids, in order."""
    return [c.id for b in builtins() for c in b.cases if c.suite]


def planted() -> list[str]:
    return [c.id for b in builtins() for c in b.cases if not c.suite and c.source == "generator"]


def resolve_case(text: str) -> tuple[Backtest, str]:
    """A case by stable id (``battery``) or reference (``battery#full``, ``./x.backtest#c``)."""
    for b in builtins():
        for c in b.cases:
            if c.id == text:
                return b, c.name
    ref = parse_ref(text)
    b = Backtest.load(ref)
    if ref.case:
        return b, b.case(ref.case).name
    if len(b.cases) == 1:
        return b, b.cases[0].name
    raise KeyError(f"{text!r} has several cases; pick one with #CASE ({', '.join(c.name for c in b.cases)})")


def expand(references: list[str]) -> list[str]:
    """``--example`` references as case ids; a reference without a case names every case."""
    ids: list[str] = []
    for text in references:
        ref = parse_ref(text)
        b = Backtest.load(ref)
        for c in [b.case(ref.case)] if ref.case else b.cases:
            if c.id not in ids:
                ids.append(c.id)
    return ids


def reference_of(case_id: str) -> str | None:
    """The canonical reference of a case id, for result rows."""
    try:
        b, name = resolve_case(case_id)
    except (KeyError, ValueError, OSError):
        return None
    return b.reference(b.case(name))
