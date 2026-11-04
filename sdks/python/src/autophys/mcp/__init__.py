"""Local Muse Code integration. MCP is an optional dependency.

Numerics and the approval state machine remain in the ordinary SDK.
"""
from .session import MCPSession, load_project

__all__ = ["MCPSession", "load_project"]
