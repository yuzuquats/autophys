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

A reference is ``[SCHEME:]SOURCE[#CASE]`` (decision EX-10): ``builtin:NAME``
(a bare name is the same) or ``path:DIR`` (a source starting with ``./``,
``../``, ``/`` or ``~`` is the same). Built-in cases keep their stable ids
(``battery``, ``battery-short-only``, ...), which records, replay files and
results use; ``builtin:battery#full`` and ``battery`` name the same case.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

#: The built-in backtests, in suite order.
BUILTIN = ("oscillator", "thermal", "battery")
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
        raise ValueError(f"unknown model {model!r}; a backtest uses battery_ecm, oscillator or thermal_rc")
    return sims[model]


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

    @classmethod
    def parse(cls, name: str, scheme: str, source: str, example: str, hidden: str) -> "Backtest":
        what = f"{name}.backtest"
        ex = tomllib.loads(example)
        hid = tomllib.loads(hidden)
        if ex.get("kind") != "backtest":
            raise ValueError(f"{what}: kind is {ex.get('kind')!r}, not 'backtest'")
        system = ex.get("system") or {}
        model = system.get("model")
        simulator(model)
        cost = system.get("experiment_cost")
        setup_hours = None if cost is None else cost["setup_hours"]
        truth = _numbers(hid.get("truth"), f"{what} [truth]")
        sigma = _numbers((hid.get("noise") or {}).get("sigma"), f"{what} noise.sigma")
        test = _experiments(hid.get("test"), f"{what} [[test]]")
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
            cases.append(CaseSpec(
                name=case_name, id=case_id, suite=c.get("suite", True),
                max_experiments=max_experiments, max_test_hours=max_test_hours,
                train=_experiments(c.get("train"), f"{cw} train"),
                validation=_experiments(c.get("validation"), f"{cw} validation"),
                bias=_numbers(h.get("bias", {}), f"{cw} bias"), missing=h.get("missing", 0.0),
                combos=combos, expected_non_identified=set(h.get("expected_non_identified", [])),
                note=h.get("note", ""),
            ))
        if not cases:
            raise ValueError(f"{what}: no [[case]]")
        extra = next((k for k in hidden_cases if not any(c.name == k for c in cases)), None)
        if extra:
            raise ValueError(f"{what}: hidden [case.{extra}] has no [[case]] in example.toml")
        return cls(name, scheme, source, ex["title"], ex["summary"], model, setup_hours, cases, truth, sigma, test)

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

    def build(self, case: CaseSpec, seed: int, *, max_experiments: int | None = None,
              bias: dict | None = None, missing: float | None = None):
        """The case's view (for the policy) and evaluator (for scoring)."""
        from .synthetic import NoiseModel, _build

        sim = simulator(self.model)
        noise = NoiseModel(dict(self.sigma), dict(case.bias) if bias is None else bias,
                           case.missing if missing is None else missing)
        view, ev = _build(case.id, sim, dict(self.truth), noise, seed,
                          train=list(case.train), validation=list(case.validation), test=list(self.test),
                          max_experiments=case.max_experiments if max_experiments is None else max_experiments,
                          combos={k: dict(v) for k, v in case.combos.items()},
                          expected=set(case.expected_non_identified), note=case.note)
        view.max_test_hours = case.max_test_hours
        if self.setup_hours is not None:
            view.catalog = {n: {"max_runs": None, "cost_hours": self.setup_hours + e["duration"] / 3600.0}
                            for n, e in sim.experiments.items()}
        return view, ev


def builtins() -> list[Backtest]:
    return [Backtest.builtin(n) for n in BUILTIN]


def suite() -> list[str]:
    """The default suite's case ids, in order."""
    return [c.id for b in builtins() for c in b.cases if c.suite]


def planted() -> list[str]:
    return [c.id for b in builtins() for c in b.cases if not c.suite]


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
