#!/usr/bin/env python3
"""Build a native Muse bundle, copying the SDK playbook without rewriting it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import shlex


def build(output, *, python="autophys", project=None, workbook=None, root=None, playbook=None, ssh_host=None, source_root=None):
    if source_root and not ssh_host:
        raise SystemExit("--source-root is only used with --ssh-host")
    source = Path(__file__).resolve().parent
    canonical = Path(playbook) if playbook else source.parents[1] / "sdks/python/src/autophys/playbooks/default/SKILL.md"
    if not canonical.is_file() and not playbook:
        canonical = source / "skills/autophys/SKILL.md"
        expected = json.loads((source / "playbook.json").read_text())["sha256"]
        if hashlib.sha256(canonical.read_bytes()).hexdigest() != expected:
            raise SystemExit("bundled canonical snapshot hash mismatch")
    if not canonical.is_file():
        raise SystemExit("Canonical playbook is missing; pass --playbook PATH. No replacement strategy is generated.")
    output = Path(output).expanduser().resolve()
    if output != source:
        output.mkdir(parents=True, exist_ok=False)
        shutil.copytree(source / "commands", output / "commands")
        shutil.copy2(source / "README.md", output / "README.md")
    (output / ".muse-plugin").mkdir(exist_ok=True)
    skill = output / "skills/autophys/SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_bytes(canonical.read_bytes())
    command = [python] if python == "autophys" else [str(Path(python).expanduser().absolute()), "-m", "autophys.cli"]
    command += ["mcp"]
    config = {k: str(v) for k, v in (("project", project), ("workbook", workbook), ("root", root)) if v}
    if ssh_host:
        if python == "autophys":
            raise SystemExit("--ssh-host requires --python with the remote SDK interpreter path")
        # The wrapper is a normal hashed plugin source. It carries no credentials.
        remote = [python, "-m", "autophys.cli", "mcp"]
        for key, value in config.items():
            remote += ["--" + key, value]
        env = ["env", "PYTHONDONTWRITEBYTECODE=1"]
        if source_root:
            env += ["PYTHONPATH=" + source_root]
        script = "#!/bin/sh\nexec ssh " + shlex.quote(ssh_host) + " " + shlex.quote(shlex.join(env + remote)) + "\n"
        (output / "mcp-stdio.sh").write_text(script)
        command = ["sh", "mcp-stdio.sh"]
    elif config:
        # Muse validates path-like argv as package sources; put lab paths in JSON.
        (output / "mcp-config.json").write_text(json.dumps(config, indent=2) + "\n")
        command += ["--config", "mcp-config.json"]
    if not ssh_host:
        command += ["--playbook", "skills/autophys/SKILL.md"]
    manifest = {
        "schemaVersion": 1, "name": "autophys", "displayName": "autophys",
        "version": "0.1.0", "description": "Calibrate local simulators with honest identifiability and human-reviewed experiments.",
        "compat": {"source": "native", "manifestDir": ".muse-plugin"},
        "capabilities": {
            "skills": [{"id": "autophys", "path": "skills/autophys/SKILL.md", "enabledDefault": True}],
            "commands": [{"id": "calibrate", "path": "commands/calibrate.md", "enabledDefault": True}],
            "mcpServers": [{"id": "autophys", "transport": "stdio", "command": command}],
            "hooks": [], "reminders": []}}
    (output / ".muse-plugin/plugin.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "playbook.json").write_text(json.dumps({
        "source": "sdks/python/src/autophys/playbooks/default/SKILL.md",
        "sha256": hashlib.sha256(skill.read_bytes()).hexdigest()}, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="new output directory, or this source bundle to refresh")
    parser.add_argument("--python", default="autophys", help="absolute SDK venv Python (default autophys on PATH)")
    parser.add_argument("--project")
    parser.add_argument("--workbook")
    parser.add_argument("--root")
    parser.add_argument("--playbook", help="override canonical SKILL.md location")
    parser.add_argument("--ssh-host", help="optional SSH stdio bridge: SDK/simulator run on this host")
    parser.add_argument("--source-root", help="remote Python import root for an uninstalled SDK (SSH only)")
    args = vars(parser.parse_args())
    print(build(**args))
