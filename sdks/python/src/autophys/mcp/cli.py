"""CLI configuration for a trusted lab project."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .session import MCPSession, load_project


def add_parser(sub):
    parser = sub.add_parser("mcp", help="serve local calibration tools over MCP stdio (requires autophys[mcp])")
    parser.add_argument("--project", help="battery_ecm or mypkg.module:project")
    parser.add_argument("--workbook", help="directory, .ap-workbook file, or daemon URL; same as ap.connect")
    parser.add_argument("--investigation", help="resume an existing investigation")
    parser.add_argument("--root", help="lab root for module loading and CSV access (default cwd)")
    parser.add_argument("--playbook", help="canonical SKILL.md from the installed plugin (default SDK playbook)")
    parser.add_argument("--expected-playbook-sha256", help="refuse a different local/remote strategy before opening a workbook")
    parser.add_argument("--config", help="JSON configuration (default .autophys-mcp.json in cwd)")
    return parser


def run(args, out=None):
    from .server import create_server

    path = Path(args.config or ".autophys-mcp.json").expanduser().resolve()
    config = json.loads(path.read_text()) if path.exists() else {}
    if args.config and not path.exists():
        raise ValueError(f"configuration does not exist: {path}")
    unknown = set(config) - {"project", "workbook", "investigation", "root", "playbook"}
    if unknown:
        raise ValueError(f"unknown MCP configuration fields: {sorted(unknown)}")
    root = Path(args.root or config.get("root") or Path.cwd()).expanduser().resolve()
    from .playbook import load_playbook, require_digest
    playbook = args.playbook or config.get("playbook")
    expected = getattr(args, "expected_playbook_sha256", None)
    # Check before project imports or workbook/client acquisition. Session checks
    # the bytes it actually adopts again to cover a changed file at the boundary.
    require_digest(load_playbook(playbook), expected)
    # Project modules are trusted local code, exactly as in the ordinary SDK.
    sys.path.insert(0, str(root))
    session = MCPSession(load_project(args.project or config.get("project") or "battery_ecm"),
                         args.workbook or config.get("workbook"), root=root,
                         investigation=args.investigation or config.get("investigation"),
                         playbook=playbook, expected_playbook_sha256=expected)
    try:
        create_server(session).run(transport="stdio")
    finally:
        session.close()
    return 0
