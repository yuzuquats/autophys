"""autophys: AI-guided calibration of physics simulators.

Declare a simulator with :func:`simulator`, wrap it in a :class:`Project`
(parameter, catalog, noise, budget and policy configuration), then run an
:class:`Investigation` over measurements with a policy that fits, diagnoses
identifiability and chooses the next experiment.
"""

from .agent import (
    ACTIONS,
    DECISION_SCHEMA,
    Decision,
    Investigation,
    Outcome,
    ProposalRunner,
    ReasonLanePolicy,
    ScriptedPolicy,
    render_facts,
)
from .data import Dataset, Observation
from .design import rank_experiments
from .fit import FitResult, fit
from .project import Budgets, NoiseConfig, PolicyConfig, Project, StopRules
from .reasoner import FakeReasoner, HttpReasoner, Reasoner
from .sensitivity import DEFAULT_RULE, IdentifiabilityRule, SensitivityReport, analyze
from .simulator import FIT_OPTIONS, TRUTH_OPTIONS, ParamSpec, SimOptions, Simulator, simulator
from .store import JsonlStore, MemoryStore, Store

__version__ = "0.1.0"

__all__ = [
    "ACTIONS", "DECISION_SCHEMA", "DEFAULT_RULE", "Budgets", "Dataset", "Decision", "FIT_OPTIONS", "FakeReasoner",
    "FitResult", "HttpReasoner", "IdentifiabilityRule", "Investigation", "JsonlStore", "MemoryStore", "NoiseConfig",
    "Observation", "Outcome", "ParamSpec", "PolicyConfig", "Project", "ProposalRunner", "ReasonLanePolicy", "Reasoner",
    "ScriptedPolicy", "SensitivityReport", "SimOptions", "Simulator", "StopRules", "Store", "TRUTH_OPTIONS", "analyze",
    "fit", "rank_experiments", "render_facts", "simulator",
]
