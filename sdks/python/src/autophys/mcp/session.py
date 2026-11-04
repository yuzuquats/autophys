"""Stateful, model-free facade over Investigation's numerical tools."""
from __future__ import annotations

import importlib
import threading
import time
from pathlib import Path

from ..agent import Decision, Investigation, ProposalRunner, ToolError
from .playbook import load_playbook
from ..client import connect
from ..data import Dataset
from ..models.battery import battery_ecm
from ..project import NoiseConfig, Project
from .measurements import read_csv


def load_project(ref: str) -> Project:
    """Load a trusted lab module's Project (or decorated Simulator)."""
    if ref == "battery_ecm":
        return Project("battery_ecm", battery_ecm, noise=NoiseConfig(bias="off"),
                       initial={"R0": 0.03, "R1": 0.04, "C1": 1500.0})
    from ..simulator import Simulator

    module, sep, attr = ref.partition(":")
    if not sep:
        raise ValueError("project must be battery_ecm or mypkg.module:project")
    obj = getattr(importlib.import_module(module), attr)
    if isinstance(obj, Simulator):
        return Project(obj.name, obj)
    if not isinstance(obj, Project):
        raise ValueError("project reference must name a Project or @ap.simulator")
    return obj


class MCPPolicy:
    """Never runs a model; Muse supplies decisions through named MCP tools."""
    name = "muse-code-mcp"

    def __init__(self, playbook=None):
        self.playbook = load_playbook(playbook)

    def meta(self) -> dict:
        book = self.playbook
        return {"playbook": {"name": book.name, "version": book.version, "sha256": book.sha256}}

    def decide(self, facts):
        raise RuntimeError("Muse Code drives MCP tools; this policy makes no model calls")


class MCPSession:
    def __init__(self, project: Project, target: str | None = None, *, root: str | Path = ".",
                 investigation: str | None = None, playbook: str | Path | None = None):
        self.project = project
        self.root = Path(root).expanduser().resolve()
        self.client = connect(target)
        self.workbook = self.client.project(project)
        self.policy = MCPPolicy(playbook)
        self.lock = threading.RLock()
        self.inv = self.workbook.investigation(investigation, policy=self.policy) if investigation else None
        self.target = str(getattr(self.workbook.store, "path", target or self.root))
        self.approval = {"workbook": self.target, "instruction":
                         "Open this workbook in the autophys browser viewer and approve or edit the proposal there."}
        if target and target.startswith(("http://", "https://")):
            self.approval["url"] = target.rstrip("/") + "/app"

    def close(self):
        self.client.close()

    def _require(self) -> Investigation:
        if self.inv is None:
            raise ToolError("import_measurements first, or restart with --investigation ID")
        return self.inv

    def _current_fit(self) -> Investigation:
        inv = self._require()
        inv._need_fit()
        if inv.fit.dataset_version != inv.dataset.version:
            raise ToolError("measurements changed: call fit before using diagnostics or reporting")
        return inv

    def describe_project(self) -> dict:
        config = self.project.config()
        return {"name": self.project.name, "config_version": self.project.config_version,
                "parameters": config["params"], "outputs": list(self.project.simulator.outputs), "csv_root": str(self.root),
                "catalog": {name: {"settings": {k: v for k, v in self.project.simulator.experiment(name).items()
                                         if not isinstance(v, (list, tuple, dict))}, **lim}
                            for name, lim in self.project.catalog.items()},
                "rule": self.project.stop.rule.describe(), "approval": self.approval,
                "investigation": self.inv.id if self.inv else None}

    def import_measurements(self, path: str, experiment: str, columns: dict[str, str] | None = None, sigma: dict[str, float] | None = None, split: str = "train") -> dict:
        if experiment not in self.project.catalog:
            raise ValueError("experiment must be a declared catalog name")
        if self.inv is not None and self.inv.pending:
            state = self.inv.proposal(self.inv.pending)["status"]
            if state in ("proposed", "approved", "edited"):
                raise ToolError("a proposal is pending: use attach_data after browser approval")
        obs = read_csv(self.project, self.root, path, experiment, columns=columns, sigma=sigma, split=split)
        if self.inv is None:
            self.inv = self.workbook.investigate(Dataset([obs]), ProposalRunner(), policy=self.policy)
            # M-2 does this in Investigation; retain blob pinning on older SDKs.
            if hasattr(self.workbook.store, "put_blob"):
                self.workbook.store.put_blob(self.policy.playbook.data, "text/markdown")
        else:
            inv = self.inv
            data = Dataset([*inv.dataset, obs])
            inv.store.append(inv.id, "measurement", {"version": data.version, "digest": data.digest(),
                                                     "observation": obs.to_dict()})
            self.inv = self.workbook.investigation(inv.id, policy=self.policy)
        records = self.inv.records("measurement")
        return {"investigation": self.inv.id, "measurement_id": records[-1].id,
                "measurement_version": self.inv.dataset.version, "samples": obs.n_samples, "split": split}

    def _action(self, action: str, arguments: dict, *, rationale="", expected_information="") -> dict:
        inv = self._require()
        if inv.steps >= inv.budgets.max_steps:
            raise ToolError("step budget exhausted")
        decision = Decision.parse({"hypothesis": rationale, "evidence": [], "action": action,
                    "arguments": arguments, "expected_information": expected_information},
                    param_names=inv.sim.param_names, catalog=list(inv.project.catalog))
        if inv.pending:
            state = inv.proposal(inv.pending)["status"]
            if state in ("rejected", "withdrawn"):
                self.inv = inv = self.workbook.investigation(inv.id, policy=self.policy)
            elif action == "request_experiment":
                raise ToolError("a proposal is already pending")
        sims0 = inv.simulations
        for sim in inv.variants.values():
            sim.budget = inv.call_budget
        t0 = time.perf_counter()
        inv.steps += 1
        step = {"index": inv.steps, "policy": self.policy.name, "fit_id": inv.fit_id,
                "valid": True, "decision": decision.to_dict()}
        try:
            if action == "stop":
                inv.tool_analyze_sensitivity()
                result = inv.tool_validate_predictions()
            else:
                result = inv._dispatch(decision)
            step["result"] = result
            inv.last_error = ""
        except Exception as exc:
            step["result"] = {"error": str(exc)}
            inv.last_error = str(exc)
            raise
        finally:
            step["simulations"] = inv.simulations - sims0
            try:
                inv._record("step", step)
            finally:
                for sim in inv.variants.values():
                    sim.budget = None
                if action != "stop":
                    inv.wall += time.perf_counter() - t0
        if action == "stop":
            return inv._finish("awaiting_data" if inv.pending else "validated",
                               ["proposal awaits browser approval and data"] if inv.pending else [],
                               t0, claimed=None).to_dict()
        return result

    def fit(self, n_starts: int = 4, loss: str = "linear") -> dict:
        return self._action("optimize_parameters", {"n_starts": n_starts, "loss": loss})

    def identifiability(self) -> dict:
        inv = self._current_fit()
        result = self._action("analyze_sensitivity", {})
        result["parameters"] = {n: {"identified": n in result["identified"]}
                                for n in inv.sim.param_names}
        result["rule"] = inv.rule.describe()
        return result

    def rank_experiments(self, criterion: str = "min_eig") -> dict:
        self._current_fit()
        return self._action("rank_experiments", {"criterion": criterion})

    def propose_experiment(self, experiment: str, rationale: str, expected_information: str = "") -> dict:
        inv = self._current_fit()
        result = self._action("request_experiment", {"experiment": experiment},
                              rationale=rationale, expected_information=expected_information)
        return {**result, "investigation": inv.id, "approval": self.approval}

    def status(self, proposal_id: str | None = None) -> dict:
        inv = self._require()
        pid = proposal_id or inv.pending
        if not pid:
            return {"investigation": inv.id, "proposal_id": None, "status": "no_pending_proposal"}
        state = inv.proposal(pid)
        # Omit events, outlook grids and custom setting arrays from diagnostics.
        return {"investigation": inv.id, "proposal_id": pid, "status": state["status"],
                "experiment": state.get("experiment"), "approval": self.approval}

    def attach_data(self, proposal_id: str, path: str, columns: dict[str, str] | None = None, sigma: dict[str, float] | None = None) -> dict:
        inv = self._require()
        state = inv.proposal(proposal_id)
        if state["status"] not in ("approved", "edited"):
            raise ToolError(f"proposal is {state['status']}; browser approval is required before attach_data")
        obs = read_csv(self.project, self.root, path, state["experiment"],
                       settings=state["settings"], columns=columns, sigma=sigma)
        # Restore pending state if a separate process wrote approval or earlier data.
        inv = self.workbook.investigation(inv.id, policy=self.policy)
        inv.attach_data(proposal_id, obs)
        self.inv = inv
        return {"investigation": inv.id, "proposal_id": proposal_id, "status": "data_attached",
                "measurement_version": inv.dataset.version, "samples": obs.n_samples}

    def report(self) -> dict:
        self._current_fit()
        # No identified/status/summary input: _finish computes the verdict itself.
        return self._action("stop", {"status": "validated"})
