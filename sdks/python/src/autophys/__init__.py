"""autophys: AI-guided calibration of physics simulators.

Declare a simulator with :func:`simulator`, wrap it in a :class:`Project`
(parameter, catalog, noise, budget and policy configuration), open its
workbook with ``connect(...).project(project)``, then run an
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
from .client import Client, LocalClient, RemoteClient, Workbook, connect
from .data import Dataset, Observation
from .design import rank_experiments
from .fit import FitResult, fit
from .project import Budgets, NoiseConfig, PolicyConfig, Project, StopRules
from .playbook import Playbook, load_playbook
from .reasoner import (BudgetError, ChatReasoner, FakeReasoner, HttpReasoner, ModelSpec, MUSE_SPARK, MUSE_WONDER,
                       Reasoner, RecordingReasoner, ReplayReasoner, reasoner_for, reasoner_from_env)
from .sensitivity import DEFAULT_RULE, IdentifiabilityRule, SensitivityReport, analyze
from .simulator import FIT_OPTIONS, TRUTH_OPTIONS, ParamSpec, SimOptions, Simulator, simulator
from .store import JsonlStore, MemoryStore, Store, StoreError
from .workbook import WorkbookError, WorkbookStore

__version__ = "0.1.0"

__all__ = [
    "ModelSpec", "MUSE_SPARK", "MUSE_WONDER", "BudgetError", "ChatReasoner", "Playbook", "load_playbook",
    "RecordingReasoner", "ReplayReasoner", "reasoner_for", "reasoner_from_env",
    "ACTIONS", "DECISION_SCHEMA", "DEFAULT_RULE", "Budgets", "Client", "Dataset", "Decision", "FIT_OPTIONS", "FakeReasoner",
    "FitResult", "HttpReasoner", "IdentifiabilityRule", "Investigation", "JsonlStore", "LocalClient", "MemoryStore", "NoiseConfig",
    "Observation", "Outcome", "ParamSpec", "PolicyConfig", "Project", "ProposalRunner", "ReasonLanePolicy", "Reasoner",
    "RemoteClient", "ScriptedPolicy", "SensitivityReport", "SimOptions", "Simulator", "StopRules", "Store", "StoreError",
    "TRUTH_OPTIONS", "Workbook", "WorkbookError", "WorkbookStore", "analyze", "connect", "fit", "rank_experiments", "render_facts", "simulator",
]
