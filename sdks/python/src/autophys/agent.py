"""The investigation loop: a policy picks one structured decision per step.

A step is: build *facts* (a compact, array-free summary of the state) →
``policy.decide(facts)`` returns a decision ``{hypothesis, evidence[],
action, arguments, expected_information}`` → the code validates it against
the action catalog → runs the tool → records the step. Policies never run
code and never see raw arrays, the evaluator or the test split.

Terminal states:

* ``validated``: the policy stopped, the latest fit converged, the
  validation split passed at the latest fit, and the identifiability rule
  identifies every parameter.
* ``inconclusive``: the policy stopped without all of that (the reasons are
  listed in the outcome).
* ``budget_exhausted``: steps or simulations ran out.
* ``awaiting_data``: a real (proposal) runner turned ``request_experiment``
  into a proposal; :meth:`Investigation.approve` and
  :meth:`Investigation.attach_data` then :meth:`Investigation.run` resume.
* ``failed``: the policy produced three unusable decisions in a row.

Guardrail: the outcome's ``identified`` list is the policy's claim
intersected with the identifiability rule at the final estimate; any claim
the rule rejects is listed in ``guardrail_overrides`` and never reported as
identified.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Protocol

import numpy as np

from .data import Dataset, Observation
from .design import outlook, rank_experiments
from .fit import FitResult, fit
from .reasoner import Reasoner, ReasonerError, parse_json_content
from .sensitivity import SensitivityReport, jacobian, report_from_jacobian
from .project import Project, policy_from_config
from .simulator import CallBudget, SimulationBudgetExceeded, SimulationError, Simulator
from .store import MemoryStore, Store, StoreError

LOSSES = ("linear", "soft_l1", "huber", "cauchy", "arctan")

ACTIONS: dict[str, dict] = {
    "inspect_data": {"doc": "summarise observations: splits, sample counts, missing samples, ranges, sigma", "args": {}},
    "optimize_parameters": {
        "doc": "weighted least-squares fit on the train split (multistart within bounds)",
        "args": {"n_starts": "integer 1..16, optional", "loss": f"one of {list(LOSSES)}, optional (robust losses resist outliers)"},
    },
    "analyze_sensitivity": {"doc": "log-parameter Jacobian SVD at the current fit; names non-identifiable combinations", "args": {}},
    "rank_experiments": {
        "doc": "score catalog experiments by Fisher information added at the current fit",
        "args": {"criterion": "min_eig (default) or d_opt, optional"},
    },
    "request_experiment": {"doc": "run (or propose) one catalog experiment; its data joins the train split", "args": {"experiment": "catalog name, required"}},
    "compare_models": {
        "doc": "fit every model variant (e.g. with a constant sensor bias) and compare by BIC",
        "args": {"adopt": "boolean, optional, default true: switch to the best variant"},
    },
    "validate_predictions": {"doc": "chi2/N of the current fit on the validation split", "args": {}},
    "stop": {
        "doc": "finish; the code checks the claim against validation and the identifiability rule",
        "args": {"status": "validated or inconclusive, required", "identified": "list of parameter names you claim are uniquely identified, optional", "summary": "string, optional"},
    },
}

DECISION_SCHEMA = {
    "type": "object",
    "required": ["hypothesis", "evidence", "action", "arguments", "expected_information"],
    "additionalProperties": False,
    "properties": {
        "hypothesis": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "action": {"type": "string", "enum": list(ACTIONS)},
        "arguments": {"type": "object"},
        "expected_information": {"type": "string"},
    },
}


class DecisionError(ValueError):
    pass


class ToolError(RuntimeError):
    pass


@dataclass
class Decision:
    hypothesis: str
    evidence: list[str]
    action: str
    arguments: dict
    expected_information: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def parse(cls, d: Any, *, param_names: list[str], catalog: list[str]) -> "Decision":
        if not isinstance(d, dict):
            raise DecisionError("decision must be an object")
        missing = [k for k in DECISION_SCHEMA["required"] if k not in d]
        extra = [k for k in d if k not in DECISION_SCHEMA["properties"]]
        if missing or extra:
            raise DecisionError(f"decision keys: missing {missing}, unexpected {extra}")
        if not isinstance(d["hypothesis"], str) or not isinstance(d["expected_information"], str):
            raise DecisionError("hypothesis and expected_information must be strings")
        if not isinstance(d["evidence"], list) or not all(isinstance(e, str) for e in d["evidence"]):
            raise DecisionError("evidence must be a list of strings")
        action, args = d["action"], d["arguments"]
        if action not in ACTIONS:
            raise DecisionError(f"unknown action {action!r}; choose one of {list(ACTIONS)}")
        if not isinstance(args, dict):
            raise DecisionError("arguments must be an object")
        allowed = ACTIONS[action]["args"]
        bad = [k for k in args if k not in allowed]
        if bad:
            raise DecisionError(f"{action}: unexpected arguments {bad}; allowed {list(allowed)}")
        if action == "optimize_parameters":
            if "n_starts" in args and not (isinstance(args["n_starts"], int) and 1 <= args["n_starts"] <= 16):
                raise DecisionError("n_starts must be an integer in 1..16")
            if "loss" in args and args["loss"] not in LOSSES:
                raise DecisionError(f"loss must be one of {list(LOSSES)}")
        if action == "rank_experiments" and args.get("criterion", "min_eig") not in ("min_eig", "d_opt"):
            raise DecisionError("criterion must be min_eig or d_opt")
        if action == "request_experiment" and args.get("experiment") not in catalog:
            raise DecisionError(f"experiment must be one of {catalog}")
        if action == "compare_models" and not isinstance(args.get("adopt", True), bool):
            raise DecisionError("adopt must be a boolean")
        if action == "stop":
            if args.get("status") not in ("validated", "inconclusive"):
                raise DecisionError("stop.status must be validated or inconclusive")
            ids = args.get("identified", [])
            if not isinstance(ids, list) or any(p not in param_names for p in ids):
                raise DecisionError(f"stop.identified must list parameters from {param_names}")
        return cls(d["hypothesis"], list(d["evidence"]), action, dict(args), d["expected_information"])


class Policy(Protocol):
    name: str

    def decide(self, facts: dict) -> tuple[Any, dict]:
        """Return (decision object or dict, trace with evidence_text / raw_output)."""


class ProposalRunner:
    """Real-use runner: ``request_experiment`` becomes a proposal awaiting approval and data."""

    kind = "proposal"


@dataclass
class Outcome:
    status: str
    reasons: list[str]
    estimate: dict[str, float]
    units: dict[str, str]
    fixed: list[str]
    identified: list[str]
    non_identified: list[str]
    non_identifiable_combinations: list[str]
    guardrail_overrides: list[str]
    model: str
    fit: dict | None
    validation: dict | None
    steps: int
    simulations: int
    experiments: int
    wall_s: float
    investigation: str
    proposal_id: str | None = None
    summary: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _fmt(v: float) -> str:
    if v is None:
        return "n/a"
    if not np.isfinite(v):
        return "inf"
    return f"{v:.4g}"


# --------------------------------------------------------------------------


class Investigation:
    """One investigation of a :class:`~autophys.project.Project`, pinned to its config version.

    ``free`` (optional) overrides which parameters are free; the rest are held
    at the project's ``initial`` values. It is the only per-investigation
    override and is recorded on the investigation.
    """

    def __init__(
        self,
        project: Project,
        dataset: Dataset,
        runner: Any,
        *,
        policy: Policy | None = None,
        reasoner: Reasoner | None = None,
        free: list[str] | None = None,
        store: Store | None = None,
        seed: int = 0,
        title: str = "",
    ) -> None:
        self._setup(project, dataset, runner, policy=policy, reasoner=reasoner, free=free, store=store, seed=seed)
        self.project_id = self.store.ensure_project(project.name)
        self.config_version = self.store.put_config_version(self.project_id, project.config_version, project.config())
        meta = {
            "project_id": self.project_id,
            "config_version": self.config_version,
            "title": title,
            "overrides": {"free": self.free, "fixed": self.fixed},
            "policy": getattr(self.policy, "name", type(self.policy).__name__),
            "seed": seed,
            "variants": {k: v.source_hash for k, v in self.variants.items()},
        }
        meta.update(getattr(self.policy, "meta", lambda: {})())
        self.id = self.store.create_investigation(meta)
        for obs in dataset:
            self._record_measurement(obs)

    def _setup(self, project: Project, dataset: Dataset, runner: Any, *, policy: Policy | None,
               reasoner: Reasoner | None, free: list[str] | None, store: Store | None, seed: int) -> None:
        """State shared by a new and a resumed investigation; writes nothing."""
        self.project = project
        self.dataset = dataset
        self.runner = runner
        self.policy = policy or policy_from_config(project.policy, reasoner)
        self.budgets = project.budgets
        self.store = store if store is not None else MemoryStore()
        self.rule = project.stop.rule
        self.n_starts = project.n_starts
        self.validation_threshold = project.stop.validation_threshold
        self.misfit_threshold = project.stop.misfit_threshold
        self.noise_cfg = project.noise
        self.seed = seed
        self.free, self.fixed = project.resolve_free(free)
        base = project.simulator.with_fixed(**self.fixed) if self.fixed else project.simulator
        self.variants = self._variants(base, project.noise.bias)
        self.model = next(iter(self.variants))
        self.limits = {n: lim.get("max_runs") for n, lim in project.catalog.items()}
        self.runs_per_experiment: dict[str, int] = {}
        self.call_budget = CallBudget(self.budgets.max_simulations)
        self.fit: FitResult | None = None
        self.fit_id = 0
        self.fit_model = None
        self.sens: SensitivityReport | None = None
        self.sens_fit = -1
        self.jac: np.ndarray | None = None
        self.ranking: list | None = None
        self.ranking_fit = -1
        self.ranking_criterion = "min_eig"
        self.validation: dict | None = None
        self.validation_fit = -1
        self.compared = False
        self.experiments_used = 0
        self.steps = 0
        self.history: list[str] = []
        self.last_error = ""
        self.pending: str | None = None
        self.pending_experiment: str | None = None
        self.wall = 0.0
        self.outcome: Outcome | None = None

    # --- resuming from records ----------------------------------------------
    @classmethod
    def resume(cls, project: Project, store: Store, investigation_id: str, runner: Any = None, *,
               policy: Policy | None = None, reasoner: Reasoner | None = None) -> "Investigation":
        """Rebuild an investigation from its records, in any process.

        The project must be the one the investigation is pinned to (same config
        version, so the same simulator source). Restored: the measurements, the
        step, simulation and experiment counts, the adopted model variant, the
        pending proposal, the last fit (including its warm start) and the last
        outcome. Sensitivities, rankings and validation are recomputed.
        ``runner`` defaults to a :class:`ProposalRunner`.
        """
        recs = store.records(investigation_id)
        if not recs or recs[0].kind != "investigation":
            raise StoreError(f"unknown investigation {investigation_id}")
        head = recs[0].payload
        if head.get("config_version") != project.config_version:
            raise StoreError(f"{investigation_id} is pinned to config version {head.get('config_version')}; "
                             f"this project is {project.config_version}")
        i = 1
        while i < len(recs) and recs[i].kind == "measurement":
            i += 1
        initial = Dataset(Observation.from_dict(r.payload["observation"]) for r in recs[1:i])
        self = cls.__new__(cls)
        overrides = head.get("overrides") or {}
        self._setup(project, initial, runner if runner is not None else ProposalRunner(), policy=policy,
                    reasoner=reasoner, free=overrides.get("free"), store=store, seed=int(head.get("seed", 0)))
        self.id = investigation_id
        self.project_id = head["project_id"]
        self.config_version = head["config_version"]
        self._replay(recs[i:])
        return self

    def _replay(self, recs: list) -> None:
        proposals: dict[str, dict] = {}
        unclaimed: list[Observation] = []  # a measurement not yet tied to a proposal

        def count(name: str) -> None:
            self.experiments_used += 1
            self.runs_per_experiment[name] = self.runs_per_experiment.get(name, 0) + 1

        def settle() -> None:
            while unclaimed:
                count(unclaimed.pop().experiment)  # a runner's direct measurement

        for r in recs:
            p = r.payload
            if r.kind == "measurement":
                settle()
                obs = Observation.from_dict(p["observation"])
                self.dataset.add(obs)
                unclaimed.append(obs)
                continue
            if r.kind == "proposal" and p.get("event") == "data_attached":
                unclaimed.clear()
                count(proposals.get(p["proposal_id"], {}).get("experiment") or "")
                self.outcome = None  # as attach_data does
            else:
                settle()
            if r.kind == "proposal":
                st = proposals.setdefault(p["proposal_id"], {})
                st["status"] = p["event"]
                if p["event"] == "proposed":
                    st["experiment"] = p.get("experiment")
                    self.ranking_criterion = p.get("criterion") or self.ranking_criterion
            elif r.kind == "run":
                self.fit_id = int(p["fit_id"])
                self.fit_model = p["model"]
                self.model = self.fit_model
                self.fit = FitResult.from_dict({k: v for k, v in p.items() if k not in ("fit_id", "model", "simulator")})
            elif r.kind == "step":
                self.outcome = None  # a later run superseded the last outcome
                self.steps += 1
                self.call_budget.used += int(p.get("simulations", 0))
                d = p.get("decision") or {}
                res = p.get("result") or {}
                if d.get("action") == "compare_models":
                    self.compared = True
                    if res.get("adopted") and res.get("best") in self.variants:
                        self.model = res["best"]
                if d.get("action"):
                    self.history.append(f"{d['action']}: " + (f"error {res['error']}" if "error" in res else "ok"))
            elif r.kind == "outcome":
                self.outcome = Outcome(**p)
                self.wall = float(p.get("wall_s", 0.0))
        settle()
        for pid, st in proposals.items():
            if st.get("status") in ("proposed", "approved", "edited"):
                self.pending, self.pending_experiment = pid, st.get("experiment")

    def records(self, kind: str | None = None) -> list:
        """This investigation's records, in order (optionally one kind)."""
        return self.store.records(self.id, kind)

    def proposal(self, proposal_id: str) -> dict:
        """A proposal's folded state: ``status``, ``experiment``, ``settings``, ``events``."""
        return self.store.proposal_status(self.id, proposal_id)

    # --- setup ------------------------------------------------------------
    def _variants(self, sim: Simulator, bias: str) -> dict[str, Simulator]:
        biased = {}
        chans = sorted({ch for o in self.dataset for ch in o.y})
        for ch in chans:
            vals = np.concatenate([o.y[ch][np.isfinite(o.y[ch])] for o in self.dataset if ch in o.y])
            span = max(float(np.ptp(vals)) if vals.size else 1.0, 1e-9)
            biased[f"sensor_bias_{ch}"] = sim.with_bias(ch, -span, span)
        if bias == "off" or not biased:
            return {"base": sim}
        if bias == "fit":
            # every channel offset fitted from the start
            out = sim
            for ch in chans:
                vals = np.concatenate([o.y[ch][np.isfinite(o.y[ch])] for o in self.dataset if ch in o.y])
                span = max(float(np.ptp(vals)) if vals.size else 1.0, 1e-9)
                out = out.with_bias(ch, -span, span)
            return {"sensor_bias": out}
        return {"base": sim, **biased}

    def noise_scale(self) -> float:
        """sqrt(chi2/N) of the latest fit when the project estimates the noise scale, else 1."""
        if self.noise_cfg.estimate and self.fit is not None and self.fit.chi2_per_n > 0:
            return float(np.sqrt(self.fit.chi2_per_n))
        return 1.0

    def declared_noise(self) -> dict[str, float]:
        noise = self.dataset.noise()
        noise.update(self.noise_cfg.sigma or {})
        return noise

    def available_experiments(self) -> list[str]:
        return [n for n, lim in self.limits.items() if lim is None or self.runs_per_experiment.get(n, 0) < lim]

    @property
    def sim(self) -> Simulator:
        return self.variants[self.model]

    @property
    def simulations(self) -> int:
        return self.call_budget.used

    def _record(self, kind: str, payload: dict):
        return self.store.append(self.id, kind, payload)

    def _measurement_payload(self, obs: Observation) -> dict:
        return {"version": self.dataset.version, "digest": self.dataset.digest(), "observation": obs.to_dict()}

    def _record_measurement(self, obs: Observation) -> None:
        self._record("measurement", self._measurement_payload(obs))

    # --- facts ------------------------------------------------------------
    def facts(self) -> dict:
        sim = self.sim
        f: dict[str, Any] = {
            "model": {
                "name": sim.name,
                "variant": self.model,
                "variants": list(self.variants),
                "params": [{"name": p.name, "unit": p.unit, "lo": p.lo, "hi": p.hi} for p in sim.params.values()],
            },
            "measurements": {
                "version": self.dataset.version,
                "observations": [
                    {"experiment": o.experiment, "split": o.split, "n": o.n_samples,
                     "missing": int(sum((~np.isfinite(v)).sum() for v in o.y.values())), "sigma": o.sigma}
                    for o in self.dataset
                ],
            },
            "budget": {
                "steps_left": self.budgets.max_steps - self.steps,
                "simulations_left": self.budgets.max_simulations - self.simulations,
                "experiments_left": self.budgets.max_experiments - self.experiments_used,
                "experiments_requested": self.experiments_used,
            },
            "catalog": self.available_experiments(),
            "fixed": self.fixed,
            "noise_scale": self.noise_scale(),
            "compared": self.compared,
            "rule": self.rule.describe(),
            "history": self.history[-6:],
            "last_error": self.last_error,
            "fit": None,
            "sensitivity": None,
            "ranking": None,
            "validation": None,
        }
        if self.fit is not None:
            current = self.fit.dataset_version == self.dataset.version and self.fit_model == self.model
            f["fit"] = {
                "current": current,
                "params": {k: v for k, v in self.fit.params.items()},
                "chi2_per_n": self.fit.chi2_per_n,
                "converged": self.fit.success,
                "nfev": self.fit.nfev,
                "at_bounds": self.fit.at_bounds,
                "loss": self.fit.loss_kind,
            }
        if self.sens is not None:
            f["sensitivity"] = {
                "current": self.sens_fit == self.fit_id,
                "condition_number": self.sens.condition_number,
                "identified": self.sens.identified,
                "non_identified": self.sens.non_identified,
                "directions": [{"kind": d.kind, "log_std": d.log_std, "combination": d.combination} for d in self.sens.directions],
            }
        if self.ranking is not None:
            f["ranking"] = {
                "current": self.ranking_fit == self.fit_id,
                "top": [{"experiment": c.experiment, "min_eig": c.min_eig, "d_opt": c.d_opt, "min_eig_gain": c.min_eig_gain} for c in self.ranking[:5]],
            }
        if self.validation is not None:
            f["validation"] = {**self.validation, "current": self.validation_fit == self.fit_id}
        return f

    # --- tools ------------------------------------------------------------
    def tool_inspect_data(self) -> dict:
        obs = []
        for o in self.dataset:
            chans = {}
            for ch, y in o.y.items():
                m = np.isfinite(y)
                chans[ch] = {"min": float(np.min(y[m])) if m.any() else None, "max": float(np.max(y[m])) if m.any() else None,
                             "missing": int((~m).sum()), "sigma": o.sigma[ch]}
            obs.append({"experiment": o.experiment, "split": o.split, "n": len(o.t), "duration": float(o.t[-1] - o.t[0]), "channels": chans})
        return {"version": self.dataset.version, "observations": obs}

    def tool_optimize_parameters(self, n_starts: int | None = None, loss: str = "linear") -> dict:
        train = self.dataset.split("train")
        if not train:
            raise ToolError("no train observations")
        initial = self.fit.params if (self.fit is not None and self.fit_model == self.model) else None
        if initial is None and all(k in self.project.initial for k in self.free):
            initial = {k: self.project.initial[k] for k in self.free}
            initial.update({k: 0.0 for k in self.sim.params if k not in initial})  # bias offsets start at zero
        if n_starts is None:
            n_starts = self.n_starts if initial is None else max(1, self.n_starts // 2)
        seed = self.seed * 1000 + self.fit_id
        r = fit(self.sim, train, initial=initial, n_starts=n_starts, loss=loss, seed=seed, dataset_version=self.dataset.version)
        self._adopt_fit(r, self.model)
        return {"params": r.params, "chi2_per_n": r.chi2_per_n, "converged": r.success, "nfev": r.nfev, "at_bounds": r.at_bounds}

    def _adopt_fit(self, r: FitResult, model: str) -> None:
        self.fit, self.fit_model = r, model
        self.fit_id += 1
        self._record("run", {"fit_id": self.fit_id, "model": model, "simulator": self.variants[model].name, **r.to_dict()})

    def _need_fit(self) -> FitResult:
        if self.fit is None or self.fit_model != self.model:
            raise ToolError("no fit for the current model: call optimize_parameters first")
        return self.fit

    def tool_analyze_sensitivity(self) -> dict:
        r = self._need_fit()
        J = jacobian(self.sim, r.params, self.dataset.split("train")) / self.noise_scale()
        self.jac = J
        self.sens = report_from_jacobian(self.sim.param_names, J, self.rule, r.params)
        self.sens_fit = self.fit_id
        return {
            "condition_number": self.sens.condition_number,
            "identified": self.sens.identified,
            "non_identified": self.sens.non_identified,
            "non_identifiable": [d.combination for d in self.sens.non_identifiable_directions],
        }

    def tool_rank_experiments(self, criterion: str = "min_eig") -> dict:
        r = self._need_fit()
        if self.sens_fit != self.fit_id:
            self.tool_analyze_sensitivity()
        cands = self.available_experiments()
        if not cands:
            raise ToolError("every catalog experiment is at its run limit")
        scale = self.noise_scale()
        noise = {ch: s * scale for ch, s in self.declared_noise().items()}
        self.ranking = rank_experiments(self.sim, r.params, self.dataset.split("train"), noise,
                                        candidates=cands, criterion=criterion, J0=self.jac)
        self.ranking_fit = self.fit_id
        self.ranking_criterion = criterion
        return {"criterion": criterion, "ranking": [(c.experiment, c.min_eig, c.d_opt) for c in self.ranking]}

    def proposal_outlook(self, experiment: str, settings: dict) -> tuple[dict, float, int]:
        """E-1: the outlook grid of a proposed experiment, at the latest fit.

        Returns ``(outlook, score, simulations)``. The score uses the latest
        ranking's criterion (``min_eig`` unless the policy ranked by
        ``d_opt``). Before any fit the estimate is the project's initial
        values (bounds midpoints in fitting coordinates otherwise). The grid's
        simulations are not charged to the investigation's simulation budget:
        they inform the reviewer, not the investigation; their count is
        returned and recorded on the step.
        """
        sim = self.sim
        train = self.dataset.split("train")
        scale = self.noise_scale()
        noise = {ch: s * scale for ch, s in self.declared_noise().items()}
        if self.fit is not None:
            params = dict(self.fit.params)
            J0 = self.jac if self.sens_fit == self.fit_id else None
        else:
            lo, hi = sim.x_bounds()
            mid = sim.from_x((lo + hi) / 2)
            params = {k: (self.project.initial_value(k) if k in self.project.simulator.params else mid[k]) for k in sim.param_names}
            J0 = None
        edit = (self.project.catalog.get(experiment) or {}).get("edit") or {}
        saved = {n: v.budget for n, v in self.variants.items()}
        calls0 = sim.calls
        for v in self.variants.values():
            v.budget = None
        try:
            grid, score, _ = outlook(sim, params, train, noise, settings, edit,
                                     criterion=self.ranking_criterion, J0=J0,
                                     max_simulations=self.budgets.max_outlook_simulations,
                                     at="fit" if self.fit is not None else "initial", jacobian_scale=scale)
        except (ValueError, SimulationError) as e:
            raise ToolError(f"cannot compute the outlook for {experiment}: {e}") from None
        finally:
            for n, v in self.variants.items():
                v.budget = saved[n]
        return grid, score, sim.calls - calls0

    def tool_request_experiment(self, experiment: str, decision: Decision | None = None) -> dict:
        if self.experiments_used >= self.budgets.max_experiments:
            raise ToolError(f"experiment budget of {self.budgets.max_experiments} is spent")
        if experiment not in self.available_experiments():
            raise ToolError(f"{experiment} is not in the catalog or is at its run limit")
        settings = self.sim.experiment(experiment)
        if getattr(self.runner, "kind", "") == "proposal":
            pid = "prop_" + uuid.uuid4().hex[:12]
            grid, score, outlook_sims = self.proposal_outlook(experiment, settings)
            self._record("proposal", {
                "proposal_id": pid, "event": "proposed", "experiment": experiment, "settings": settings,
                "rationale": decision.hypothesis if decision else "",
                "expected_information": decision.expected_information if decision else "",
                "criterion": self.ranking_criterion, "score": score, "outlook": grid,
            })
            self.pending = pid
            self.pending_experiment = experiment
            return {"proposal_id": pid, "status": "proposed", "outlook_simulations": outlook_sims,
                    "outlook_points": {a["name"]: len(a["values"]) for a in grid["axes"]}}

        obs = self.runner.run(experiment)
        obs.split = "train"
        self.dataset.add(obs)
        self._record_measurement(obs)
        self.experiments_used += 1
        self.runs_per_experiment[experiment] = self.runs_per_experiment.get(experiment, 0) + 1
        return {"experiment": experiment, "n": obs.n_samples, "measurement_version": self.dataset.version}

    def tool_compare_models(self, adopt: bool = True) -> dict:
        train = self.dataset.split("train")
        n = sum(o.n_samples for o in train)
        table = []
        fits = {}
        for name, sim in self.variants.items():
            init = self.fit.params if (self.fit is not None and self.fit_model == name) else None
            r = fit(sim, train, initial=init, n_starts=self.n_starts, seed=self.seed * 1000 + 500 + len(table), dataset_version=self.dataset.version)
            k = len(sim.params)
            fits[name] = r
            table.append({"variant": name, "k": k, "chi2": r.loss, "chi2_per_n": r.chi2_per_n,
                          "aic": r.loss + 2 * k, "bic": r.loss + k * np.log(max(n, 1)), "converged": r.success})
        best = min(table, key=lambda row: row["bic"])["variant"]
        self.compared = True
        if adopt:
            self.model = best
            self._adopt_fit(fits[best], best)
        return {"table": table, "best": best, "adopted": adopt}

    def tool_validate_predictions(self) -> dict:
        r = self._need_fit()
        val = self.dataset.split("validation")
        if not val:
            self.validation = {"available": False, "passed": False}
        else:
            chi2, sq, cnt = 0.0, 0.0, 0
            for o in val:
                pred = self.sim(r.params, o.settings)
                for ch, y in o.y.items():
                    m = np.isfinite(y)
                    d = y[m] - pred[ch][m]
                    chi2 += float(np.sum((d / o.sigma[ch]) ** 2))
                    sq += float(np.sum(d**2))
                    cnt += int(m.sum())
            chi = chi2 / max(cnt, 1) / self.noise_scale() ** 2
            self.validation = {"available": True, "chi2_per_n": chi, "rmse": float(np.sqrt(sq / max(cnt, 1))),
                               "n": cnt, "threshold": self.validation_threshold, "passed": chi <= self.validation_threshold}
        self.validation_fit = self.fit_id
        return dict(self.validation)

    # --- proposals --------------------------------------------------------
    def approve(self, proposal_id: str, *, by: str = "user", settings: dict | None = None) -> None:
        self._require_pending(proposal_id)
        ev = "edited" if settings is not None else "approved"
        payload = {"proposal_id": proposal_id, "event": ev, **self._decision_actor(by)}
        if settings is not None:
            payload["settings"] = self.sim.experiment(settings)
        self._record("proposal", payload)

    def reject(self, proposal_id: str, *, by: str = "user", reason: str = "") -> None:
        self._require_pending(proposal_id)
        self._record("proposal", {"proposal_id": proposal_id, "event": "rejected", **self._decision_actor(by), "reason": reason})
        self.pending = self.pending_experiment = None
        self.history.append(f"proposal {proposal_id} rejected: {reason}")

    def _decision_actor(self, by: str) -> dict:
        actor = {"by": by, "via": "sdk"}
        key_id = getattr(self.store, "key_id", None)
        if key_id is not None:
            actor["key_id"] = key_id
        return actor

    def withdraw(self, proposal_id: str, *, by: str = "user", reason: str = "") -> None:
        """Withdraw the pending, still-proposed experiment before approval."""
        self._require_pending(proposal_id)
        self._record("proposal", {"proposal_id": proposal_id, "event": "withdrawn",
                                  **self._decision_actor(by), "reason": reason})
        self.pending = self.pending_experiment = None
        self.history.append(f"proposal {proposal_id} withdrawn: {reason}")

    def attach_data(self, proposal_id: str, observation: Observation) -> None:
        self._require_pending(proposal_id)
        status = self.store.proposal_status(self.id, proposal_id)["status"]
        if status not in ("approved", "edited"):
            raise ToolError(f"proposal {proposal_id} is {status}; approve it before attaching data")
        observation.split = "train"
        self.dataset.add(observation)
        # The measurement and its data_attached event commit together, so a
        # crash cannot leave a measurement without its attribution.
        self.store.append_batch(self.id, [
            ("measurement", self._measurement_payload(observation)),
            ("proposal", {"proposal_id": proposal_id, "event": "data_attached", "measurement_version": self.dataset.version,
                          "digest": observation.digest()}),
        ])
        self.experiments_used += 1
        name = self.pending_experiment
        self.pending_experiment = None
        if name:
            self.runs_per_experiment[name] = self.runs_per_experiment.get(name, 0) + 1
        self.pending = None
        self.outcome = None
        self.history.append(f"data attached for {proposal_id} ({observation.experiment})")

    def wait_for_approval(self, *, timeout: float = 3600, interval: float = 5, sleep=time.sleep, clock=time.monotonic) -> dict:
        """Block until the pending proposal is approved, edited or rejected (e.g. on the dashboard).

        A store with its own ``wait_for_approval`` (``HttpStore``: the
        daemon's record stream, polling as a fallback) serves the wait;
        otherwise the store's records are polled every ``interval`` seconds.
        """
        if not self.pending:
            raise ToolError("no pending proposal")
        waiter = getattr(self.store, "wait_for_approval", None)
        if waiter is not None:
            st = waiter(self.id, self.pending, timeout=timeout, interval=interval, sleep=sleep, clock=clock)
            if st["status"] in ("rejected", "withdrawn"):
                self.pending = self.pending_experiment = None
            return st
        deadline = clock() + timeout
        while True:
            st = self.store.proposal_status(self.id, self.pending)

            if st["status"] != "proposed":
                if st["status"] in ("rejected", "withdrawn"):
                    self.pending = self.pending_experiment = None
                return st
            if clock() >= deadline:
                raise TimeoutError(f"proposal {self.pending} still awaiting approval")
            sleep(interval)

    def _require_pending(self, proposal_id: str) -> None:
        if self.pending != proposal_id:
            raise ToolError(f"{proposal_id} is not the pending proposal")

    # --- loop -------------------------------------------------------------
    def run(self) -> Outcome:
        if self.pending:
            raise ToolError(f"awaiting data for proposal {self.pending}")
        for sim in self.variants.values():
            sim.budget = self.call_budget
        t0 = time.perf_counter()
        failures = 0
        try:
            while True:
                if self.steps >= self.budgets.max_steps:
                    return self._finish("budget_exhausted", [f"step budget of {self.budgets.max_steps} spent"], t0)
                facts = self.facts()
                self.steps += 1
                step: dict[str, Any] = {"index": self.steps, "policy": getattr(self.policy, "name", "?"), "fit_id": self.fit_id}
                try:
                    raw, trace = self.policy.decide(facts)
                    step.update(trace)
                    decision = raw if isinstance(raw, Decision) else Decision.parse(
                        raw, param_names=self.sim.param_names, catalog=list(self.limits))
                except (ReasonerError, DecisionError) as e:
                    failures += 1
                    self.last_error = f"{type(e).__name__}: {e}"
                    step.update({"valid": False, "error": self.last_error})
                    self._record("step", step)
                    if failures >= 3:
                        return self._finish("failed", ["three unusable decisions in a row"], t0)
                    continue
                failures = 0
                step["decision"] = decision.to_dict()
                step["valid"] = True
                if decision.action == "stop":
                    self._record("step", step)
                    a = decision.arguments
                    return self._finish(a["status"], [], t0, claimed=a.get("identified"), summary=a.get("summary", ""))
                sims0 = self.simulations
                try:
                    result = self._dispatch(decision)
                    self.last_error = ""
                    self.history.append(f"{decision.action}: ok")
                except ToolError as e:
                    result = {"error": str(e)}
                    self.last_error = f"{decision.action}: {e}"
                    self.history.append(f"{decision.action}: error {e}")
                except SimulationBudgetExceeded as e:
                    step.update({"result": {"error": str(e)}, "simulations": self.simulations - sims0})
                    self._record("step", step)
                    return self._finish("budget_exhausted", [str(e)], t0)
                step.update({"result": result, "simulations": self.simulations - sims0})
                self._record("step", step)
                if self.pending:
                    return self._finish("awaiting_data", [f"proposal {self.pending} awaits approval and data"], t0)
        finally:
            for sim in self.variants.values():
                sim.budget = None

    def _dispatch(self, d: Decision) -> dict:
        a = d.arguments
        if d.action == "inspect_data":
            return self.tool_inspect_data()
        if d.action == "optimize_parameters":
            return self.tool_optimize_parameters(a.get("n_starts"), a.get("loss", "linear"))
        if d.action == "analyze_sensitivity":
            return self.tool_analyze_sensitivity()
        if d.action == "rank_experiments":
            return self.tool_rank_experiments(a.get("criterion", "min_eig"))
        if d.action == "request_experiment":
            return self.tool_request_experiment(a["experiment"], d)
        if d.action == "compare_models":
            return self.tool_compare_models(a.get("adopt", True))
        if d.action == "validate_predictions":
            return self.tool_validate_predictions()
        raise ToolError(f"no tool for {d.action}")

    def _finish(self, status: str, reasons: list[str], t0: float, *, claimed: list[str] | None = None, summary: str = "") -> Outcome:
        self.wall += time.perf_counter() - t0
        reasons = list(reasons)
        sens = self.sens if self.sens_fit == self.fit_id else None
        if self.fit is not None and self.fit_model == self.model and sens is None:
            try:
                self.tool_analyze_sensitivity()
                sens = self.sens
            except SimulationBudgetExceeded:
                reasons.append("no simulations left to check identifiability at the final estimate")
        rule_ids = list(sens.identified) if sens else []
        names = self.sim.param_names
        non_ids = [p for p in names if p not in rule_ids]
        if claimed is None:
            claimed = rule_ids
        overrides = [p for p in claimed if p not in rule_ids]
        identified = [p for p in claimed if p in rule_ids]
        if status == "validated":
            if self.fit is None or not self.fit.success:
                reasons.append("latest fit did not converge" if self.fit else "no fit")
            if not (self.validation and self.validation_fit == self.fit_id and self.validation.get("passed")):
                reasons.append("validation split not passed at the latest fit")
            if non_ids:
                reasons.append("not identified by the rule: " + ", ".join(non_ids))
            if reasons:
                status = "inconclusive"
        elif status == "inconclusive" and not reasons:
            if non_ids:
                reasons.append("not identified by the rule: " + ", ".join(non_ids))
            if not (self.validation and self.validation_fit == self.fit_id and self.validation.get("passed")):
                reasons.append("validation split not passed at the latest fit")
        if overrides:
            reasons.append("guardrail: claimed identified but the rule disagrees: " + ", ".join(overrides))
        out = Outcome(
            status=status,
            reasons=reasons,
            estimate={**self.fixed, **(dict(self.fit.params) if self.fit else {})},
            units={**{k: self.project.simulator.params[k].unit for k in self.fixed}, **{p.name: p.unit for p in self.sim.params.values()}},
            fixed=sorted(self.fixed),
            identified=identified,
            non_identified=[p for p in names if p not in identified],
            non_identifiable_combinations=[d.combination for d in sens.non_identifiable_directions] if sens else [],
            guardrail_overrides=overrides,
            model=self.model,
            fit={"chi2_per_n": self.fit.chi2_per_n, "converged": self.fit.success, "nfev": self.fit.nfev} if self.fit else None,
            validation=dict(self.validation) if self.validation else None,
            steps=self.steps,
            simulations=self.simulations,
            experiments=self.experiments_used,
            wall_s=self.wall,
            investigation=self.id,
            proposal_id=self.pending,
            summary=summary,
        )
        self._record("outcome", out.to_dict())
        self.outcome = out
        return out


# --------------------------------------------------------------------------
# Rendering facts as compact text (shared by every policy's evidence record)


def render_facts(f: dict) -> str:
    m = f["model"]
    lines = [
        "MODEL: {} variant={} variants={}".format(m["name"], m["variant"], ",".join(m["variants"])),
        "PARAMS: " + "; ".join(f"{p['name']} [{p['unit']}] in [{_fmt(p['lo'])}, {_fmt(p['hi'])}]" for p in m["params"]),
        "MEASUREMENTS: version={} ".format(f["measurements"]["version"]) + "; ".join(
            f"{o['split']} {o['experiment']} n={o['n']} missing={o['missing']} sigma=" + ",".join(f"{k}={_fmt(v)}" for k, v in o["sigma"].items())
            for o in f["measurements"]["observations"]),
        "BUDGET: " + " ".join(f"{k}={v}" for k, v in f["budget"].items()),
        "FIXED: " + (", ".join(f"{k}={_fmt(v)}" for k, v in f["fixed"].items()) or "none"),
        "NOISE_SCALE: " + _fmt(f["noise_scale"]),
        "CATALOG: " + (", ".join(f["catalog"]) or "none (every experiment at its run limit)"),
        "COMPARED: " + ("yes" if f["compared"] else "no"),
    ]
    fit = f["fit"]
    if fit is None:
        lines.append("FIT: none")
    else:
        lines.append("FIT: {} chi2/N={} converged={} nfev={} at_bounds={} params ".format(
            "current" if fit["current"] else "stale", _fmt(fit["chi2_per_n"]), "yes" if fit["converged"] else "no",
            fit["nfev"], ",".join(fit["at_bounds"]) or "none") + ", ".join(f"{k}={_fmt(v)}" for k, v in fit["params"].items()))
    s = f["sensitivity"]
    if s is None:
        lines.append("SENSITIVITY: none")
    else:
        lines.append("SENSITIVITY: {} cond={} identified={} non_identified={}".format(
            "current" if s["current"] else "stale", _fmt(s["condition_number"]),
            ",".join(s["identified"]) or "none", ",".join(s["non_identified"]) or "none"))
        for d in s["directions"]:
            lines.append(f"  direction {d['kind']} log_std={_fmt(d['log_std'])}: {d['combination']}")
    r = f["ranking"]
    if r is None:
        lines.append("RANKING: none")
    else:
        lines.append("RANKING: {} top={} ".format("current" if r["current"] else "stale", r["top"][0]["experiment"] if r["top"] else "none")
                     + "; ".join(f"{c['experiment']} min_eig={_fmt(c['min_eig'])} gain={_fmt(c['min_eig_gain'])} d_opt={_fmt(c['d_opt'])}" for c in r["top"]))
    v = f["validation"]
    if v is None:
        lines.append("VALIDATION: none")
    elif not v.get("available", True):
        lines.append("VALIDATION: {} available=no passed=no".format("current" if v["current"] else "stale"))
    else:
        lines.append("VALIDATION: {} passed={} chi2/N={} rmse={} threshold={}".format(
            "current" if v["current"] else "stale", "yes" if v["passed"] else "no", _fmt(v["chi2_per_n"]), _fmt(v["rmse"]), _fmt(v["threshold"])))
    lines.append("RULE: " + f["rule"])
    if f["history"]:
        lines.append("HISTORY: " + " | ".join(f["history"]))
    if f["last_error"]:
        lines.append("ERROR: " + f["last_error"])
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Policies


class ScriptedPolicy:
    """No-LLM baseline: fit -> sensitivity -> rank -> request best -> refit -> validate -> stop.

    Repeats rank/request while the rule names a non-identified parameter and
    experiments remain; compares model variants once when the fit misfits
    (chi2/N above ``misfit``).
    """

    name = "scripted"

    def __init__(self, misfit: float = 2.0) -> None:
        self.misfit = misfit

    def decide(self, f: dict) -> tuple[Decision, dict]:
        d = self._choose(f)
        return d, {"evidence_text": render_facts(f), "raw_output": None}

    def _choose(self, f: dict) -> Decision:
        def dec(action, args, hyp, ev, info):
            return Decision(hyp, ev, action, args, info)

        fit, sens, rank, val, bud = f["fit"], f["sensitivity"], f["ranking"], f["validation"], f["budget"]
        if fit is None or not fit["current"]:
            return dec("optimize_parameters", {}, "the model can be calibrated to the current train data",
                       [f"measurement version {f['measurements']['version']}", "no current fit"], "best-fit parameters and chi2/N")
        if fit["chi2_per_n"] > self.misfit and not f["compared"] and len(f["model"]["variants"]) > 1:
            return dec("compare_models", {"adopt": True}, "the misfit comes from a model error such as a sensor offset",
                       [f"chi2/N={_fmt(fit['chi2_per_n'])} > {self.misfit}"], "which variant the data supports (BIC)")
        if sens is None or not sens["current"]:
            return dec("analyze_sensitivity", {}, "some parameter combinations may be undetermined by this data",
                       [f"fit chi2/N={_fmt(fit['chi2_per_n'])}"], "identified parameters and non-identifiable directions")
        need_more = bool(sens["non_identified"]) or bud["experiments_requested"] == 0
        if need_more and bud["experiments_left"] > 0 and f["catalog"]:
            if rank is None or not rank["current"]:
                return dec("rank_experiments", {"criterion": "min_eig"}, "a catalog experiment can resolve the weakest direction",
                           [f"non_identified={','.join(sens['non_identified']) or 'none'}"], "Fisher-information score per experiment")
            best = rank["top"][0]["experiment"]
            return dec("request_experiment", {"experiment": best}, f"{best} adds the most information on the weakest direction",
                       [f"{best} min_eig={_fmt(rank['top'][0]['min_eig'])}"], "data that tightens the worst-determined direction")
        if val is None or not val["current"]:
            return dec("validate_predictions", {}, "the calibrated model predicts the validation split",
                       [f"fit chi2/N={_fmt(fit['chi2_per_n'])}"], "validation chi2/N")
        ok = val.get("passed") and not sens["non_identified"]
        return dec("stop", {"status": "validated" if ok else "inconclusive", "identified": list(sens["identified"]),
                            "summary": "scripted baseline finished"},
                   "the investigation has answered what this budget allows",
                   [f"validation passed={val.get('passed')}", f"non_identified={','.join(sens['non_identified']) or 'none'}"], "none")


SYSTEM_PROMPT = """You direct a model-calibration investigation for an engineer.
Each turn you see compact diagnostics (no raw data) and choose exactly ONE action.
Reply with a JSON object only: {"hypothesis": str, "evidence": [str], "action": str, "arguments": {}, "expected_information": str}.
Ground every evidence item in a line of the diagnostics. Never claim a parameter is identified unless the
SENSITIVITY line lists it as identified; the code will override such claims. Prefer: fit before sensitivity,
sensitivity before ranking, request the top-ranked experiment only while a parameter is non-identified and
experiments remain, validate at the latest fit before stopping. Stop with status "inconclusive" when the budget
cannot resolve a non-identified parameter, and say which combination the data does determine.
Actions:
"""


def system_prompt() -> str:
    return SYSTEM_PROMPT + "\n".join(
        f"- {k}: {v['doc']}; arguments: " + (", ".join(f"{a} ({d})" for a, d in v["args"].items()) or "none")
        for k, v in ACTIONS.items())


class ReasonLanePolicy:
    """Asks a :class:`~autophys.reasoner.Reasoner` for each decision, from text diagnostics only."""

    name = "reason-lane"

    def __init__(self, reasoner: Reasoner, *, effort: str | None = "low", max_tokens: int = 2400) -> None:
        self.reasoner = reasoner
        self.effort = effort
        self.max_tokens = max_tokens
        self._system = system_prompt()

    def meta(self) -> dict:
        return {"system_prompt_sha256": hashlib.sha256(self._system.encode()).hexdigest(), "reasoner": repr(self.reasoner)}

    def decide(self, f: dict) -> tuple[dict, dict]:
        text = render_facts(f)
        messages = [{"role": "developer", "content": self._system}, {"role": "user", "content": text}]
        trace: dict[str, Any] = {"evidence_text": text}
        reply = self.reasoner.complete(messages, response_schema=DECISION_SCHEMA, effort=self.effort, max_tokens=self.max_tokens)
        trace.update({"raw_output": reply.content, "model": reply.model, "usage": reply.usage, "elapsed_ms": reply.elapsed_ms})
        return parse_json_content(reply.content), trace
