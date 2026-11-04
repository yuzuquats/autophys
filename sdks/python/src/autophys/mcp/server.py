"""Optional official MCP SDK adapter. Stdout is exclusively protocol traffic."""
from __future__ import annotations

import functools
import json
import math

from .session import MCPSession


def compact(value):
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [compact(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def create_server(session: MCPSession):
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        raise RuntimeError("MCP support requires: pip install 'autophys[mcp]'") from None
    server = FastMCP("autophys", instructions=(
        "Calibrate with autophys's numerical tools. Identified parameters come only from its SVD rule. "
        "Proposals need human approval in the browser. No approve/reject tool exists. "
        "Use status without blocking; attach_data only after approval."))
    descriptions = {
        "describe_project": "Describe parameter units/bounds, experiments, editable settings and workbook.",
        "import_measurements": "Import a lab CSV as a versioned measurement. columns maps t/output/current to CSV headers; sigma is required unless declared by the project. Battery defaults: time/current/voltage. Must match declared experiment.",
        "fit": "Fit current train measurements using bounded weighted least squares; returns compact diagnostics.",
        "identifiability": "Run autophys's SVD rule; returns the verdict per parameter and unresolved combinations.",
        "rank_experiments": "Rank catalog experiments by added Fisher information: min_eig or d_opt.",
        "propose_experiment": "Write a proposed experiment with its outlook grid; returns IDs and where the human approves.",
        "status": "Read the latest proposal state without waiting.",
        "attach_data": "Attach a CSV to an approved/edited proposal. Store enforces approval. columns and sigma follow import_measurements.",
        "report": "Compute and record the outcome with autophys's guardrail-checked identified list.",
    }
    for name, description in descriptions.items():
        method = getattr(session, name)

        def wrap(fn):
            @functools.wraps(fn)
            def call(*args, **kwargs):
                with session.lock:
                    return json.dumps(compact(fn(*args, **kwargs)), allow_nan=False, separators=(",", ":"))
            return call

        server.tool(name=name, description=description)(wrap(method))
    return server
