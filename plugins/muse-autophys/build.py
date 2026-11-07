#!/usr/bin/env python3
"""Build a native Muse bundle, copying the SDK playbook without rewriting it.

The MCP server is the Rust ``autophys mcp`` command (cli.md CLI-1, phase B).
A ``--project mypkg.module:project`` (a Project or ``@ap.simulator``) is served
through a Python SDK worker (CLI-11); ``--python`` names its interpreter.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import shlex


DEFAULT_AUTOPHYS = "autophys"  # the autophys binary on PATH


def build(output, *, autophys=DEFAULT_AUTOPHYS, project=None, workbook=None, root=None, playbook=None, ssh_host=None,
          python=None):
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
    digest = hashlib.sha256(skill.read_bytes()).hexdigest()
    config = {k: str(v) for k, v in (("project", project), ("workbook", workbook), ("root", root), ("python", python)) if v}
    if ssh_host:
        # The wrapper is a normal hashed plugin source. It carries no credentials;
        # the autophys binary, workbook and lab are on the remote host.
        remote = [autophys, "mcp", "--expected-playbook-sha256", digest]
        for key, value in config.items():
            remote += ["--" + key, value]
        script = "#!/bin/sh\nexec ssh " + shlex.quote(ssh_host) + " " + shlex.quote(shlex.join(remote)) + "\n"
    else:
        executable = autophys if autophys == DEFAULT_AUTOPHYS else str(Path(autophys).expanduser().absolute())
        if config:
            # Muse validates path-like argv as package sources; put lab paths in JSON.
            (output / "mcp-config.json").write_text(json.dumps(config, indent=2) + "\n")
        # Muse relocates a package-relative executable in argv[0], not arbitrary
        # argument strings. Resolve package resources inside that executable,
        # without changing the lab cwd used by relative paths.
        script = '#!/bin/sh\nplugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit\n'
        script += "exec " + shlex.join([executable, "mcp"])
        if config:
            script += ' --config "$plugin_root/mcp-config.json"'
        script += ' --playbook "$plugin_root/skills/autophys/SKILL.md" --expected-playbook-sha256 ' + digest + '\n'
    (output / "mcp-stdio.sh").write_text(script)
    (output / "mcp-stdio.sh").chmod(0o755)
    manifest = {
        "schemaVersion": 1, "name": "autophys", "displayName": "autophys",
        "version": "0.1.0", "description": "Calibrate local simulators with honest identifiability and human-reviewed experiments.",
        "compat": {"source": "native", "manifestDir": ".muse-plugin"},
        "capabilities": {
            "skills": [{"id": "autophys", "path": "skills/autophys/SKILL.md", "enabledDefault": True}],
            "commands": [{"id": "calibrate", "path": "commands/calibrate.md", "enabledDefault": True}],
            "mcpServers": [{"id": "autophys", "transport": "stdio", "command": ["./mcp-stdio.sh"]}],
            "hooks": [], "reminders": []}}
    (output / ".muse-plugin/plugin.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "playbook.json").write_text(json.dumps({
        "source": "sdks/python/src/autophys/playbooks/default/SKILL.md",
        "sha256": digest}, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="new output directory, or this source bundle to refresh")
    parser.add_argument("--autophys", default=DEFAULT_AUTOPHYS,
                        help="the autophys binary (default autophys on PATH; with --ssh-host, its path on the remote host)")
    parser.add_argument("--project", help="battery_ecm, or mypkg.module:project for your Python simulator")
    parser.add_argument("--python", help="interpreter with the autophys SDK and the lab's dependencies, for a module:project "
                        "(default AUTOPHYS_PYTHON, else python3; with --ssh-host, its path on the remote host)")
    parser.add_argument("--workbook")
    parser.add_argument("--root")
    parser.add_argument("--playbook", help="override canonical SKILL.md location")
    parser.add_argument("--ssh-host", help="optional SSH stdio bridge: autophys runs on this host")
    args = vars(parser.parse_args())
    print(build(**args))
