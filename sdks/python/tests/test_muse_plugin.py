"""The Muse Code plugin bundle (plugins/muse-autophys), offline.

The bundle launches the Rust ``autophys mcp`` server (cli.md CLI-1, phase B).
Builder tests need no binary; the protocol tests are opt-in: set
``AUTOPHYS_RUST_BIN`` to a built ``autophys`` binary.
"""
import asyncio
import csv
import hashlib
import json
import os
from pathlib import Path
import runpy
import shlex
import shutil
import subprocess

import pytest

from autophys.models.battery import battery_ecm, current
from autophys.playbook import load_playbook

SOURCE = Path(__file__).resolve().parents[3] / "plugins/muse-autophys"
BIN = os.environ.get("AUTOPHYS_RUST_BIN")
TOOLS = {"describe_project", "import_measurements", "fit", "identifiability",
         "rank_experiments", "propose_experiment", "status", "attach_data", "report"}
TRUTH = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}


def builder():
    if not SOURCE.exists():
        pytest.skip("plugin sources are not part of the Python wheel")
    return runpy.run_path(str(SOURCE / "build.py"))["build"]


def write_csv(path, experiment):
    settings = battery_ecm.experiment(experiment)
    pred = battery_ecm(TRUTH, settings)
    cur = current(settings)
    with path.open("w") as out:
        w = csv.writer(out)
        w.writerow(("time", "current", "voltage"))
        w.writerows((t, cur(t), v) for t, v in zip(pred["t"], pred["v"]))


def test_builder_keeps_canonical_skill_and_paths_in_config(tmp_path):
    build = builder()
    result = build(tmp_path / "bundle", autophys="/opt/autophys/bin/autophys", project="battery_ecm",
                   root=str(tmp_path), workbook=str(tmp_path / "books"))
    canonical = load_playbook()
    data = (result / "skills/autophys/SKILL.md").read_bytes()
    assert data == canonical.data
    assert json.loads((result / "playbook.json").read_text())["sha256"] == hashlib.sha256(data).hexdigest()
    manifest = json.loads((result / ".muse-plugin/plugin.json").read_text())
    assert manifest["capabilities"]["mcpServers"][0]["command"] == ["./mcp-stdio.sh"]
    script = (result / "mcp-stdio.sh").read_text()
    assert "exec /opt/autophys/bin/autophys mcp" in script
    assert "python" not in script
    assert '--config "$plugin_root/mcp-config.json"' in script
    assert '--playbook "$plugin_root/skills/autophys/SKILL.md"' in script
    assert "--expected-playbook-sha256 " + canonical.sha256 in script
    assert json.loads((result / "mcp-config.json").read_text())["root"] == str(tmp_path)
    with pytest.raises(FileExistsError):
        build(result)


def test_source_launcher_runs_autophys_from_path():
    if not SOURCE.exists():
        pytest.skip("plugin sources are not part of the Python wheel")
    script = (SOURCE / "mcp-stdio.sh").read_text()
    assert 'exec autophys mcp --playbook "$plugin_root/skills/autophys/SKILL.md"' in script
    assert "python" not in script


def test_launchers_resolve_installed_resources_and_keep_lab_cwd(tmp_path):
    """Execute the manifest after relocation, with no provider or remote call."""
    build = builder()
    lab = tmp_path / "lab"
    lab.mkdir()
    bins = tmp_path / "bin"
    bins.mkdir()
    recorder = bins / "autophys recorder"
    recorder.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                        "from pathlib import Path\n"
                        "args=sys.argv[1:]\n"
                        "config=Path(args[args.index('--config')+1])\n"
                        "playbook=Path(args[args.index('--playbook')+1])\n"
                        "print(json.dumps({'argv':args,'cwd':os.getcwd(),"
                        "'config':json.loads(config.read_text()),"
                        "'playbook':playbook.read_text()}))\n")
    recorder.chmod(0o755)
    local = build(tmp_path / "local", autophys=str(recorder), project="battery_ecm",
                  root=".", workbook="relative books")
    installed = tmp_path / "relocated install"
    shutil.move(str(local), installed)
    argv = json.loads((installed / ".muse-plugin/plugin.json").read_text())["capabilities"]["mcpServers"][0]["command"]
    result = subprocess.run([str(installed / argv[0])], cwd=lab, text=True, capture_output=True, check=True)
    received = json.loads(result.stdout)
    assert received["argv"][0] == "mcp"
    assert received["cwd"] == str(lab)
    assert received["config"] == {"project": "battery_ecm", "root": ".", "workbook": "relative books"}
    assert received["playbook"].encode() == load_playbook().data
    for flag in ["--config", "--playbook"]:
        assert Path(received["argv"][received["argv"].index(flag) + 1]).is_relative_to(installed)

    ssh = bins / "ssh"
    ssh.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                   "print(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd()}))\n")
    ssh.chmod(0o755)
    remote = build(tmp_path / "remote", autophys="/remote/my bin/autophys", project="battery_ecm",
                   root="relative lab", workbook="relative books", ssh_host="lab-alias")
    installed_remote = tmp_path / "relocated remote"
    shutil.move(str(remote), installed_remote)
    argv = json.loads((installed_remote / ".muse-plugin/plugin.json").read_text())["capabilities"]["mcpServers"][0]["command"]
    result = subprocess.run([str(installed_remote / argv[0])], cwd=lab, text=True, capture_output=True, check=True,
                            env={**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"]})
    received = json.loads(result.stdout)
    assert received["cwd"] == str(lab)
    assert received["argv"][0] == "lab-alias"
    assert shlex.split(received["argv"][1]) == [
        "/remote/my bin/autophys", "mcp", "--expected-playbook-sha256", load_playbook().sha256,
        "--project", "battery_ecm", "--workbook", "relative books", "--root", "relative lab"]
    assert (installed_remote / "skills/autophys/SKILL.md").read_bytes() == load_playbook().data


rust = pytest.mark.skipif(not BIN, reason="set AUTOPHYS_RUST_BIN to a built autophys binary")


async def _call(client, name, arguments=None, error=False):
    result = await client.call_tool(name, arguments or {})
    assert bool(result.isError) == error, result.content
    text = result.content[0].text
    return text if error else json.loads(text)


@rust
def test_bundle_serves_the_rust_mcp_tools_over_stdio(tmp_path):
    pytest.importorskip("mcp")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    lab = tmp_path / "lab"
    lab.mkdir()
    write_csv(lab / "pulses.csv", "pulse_2A")
    bundle = builder()(tmp_path / "bundle", autophys=BIN, project="battery_ecm", root=str(lab),
                       workbook=str(tmp_path / "books"))

    async def check():
        params = StdioServerParameters(command=str(bundle / "mcp-stdio.sh"), cwd=str(lab), env=dict(os.environ))
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                tools = {t.name: t for t in (await client.list_tools()).tools}
                assert set(tools) == TOOLS
                assert not any("approve" in n or "reject" in n for n in tools)
                props = tools["import_measurements"].inputSchema["properties"]
                assert any(x.get("type") == "object" for x in props["sigma"]["anyOf"])
                assert tools["report"].inputSchema["properties"] == {}
                info = await _call(client, "describe_project")
                assert info["parameters"]["R0"]["unit"] == "ohm" and info["csv_root"] == str(lab)
                imported = await _call(client, "import_measurements",
                                       {"path": "pulses.csv", "experiment": "pulse_2A", "sigma": {"v": 0.002}})
                assert imported["samples"] == 601
                fit = await _call(client, "fit", {"n_starts": 2})
                assert fit["converged"]
                ident = await _call(client, "identifiability")
                assert set(ident["parameters"]) == {"R0", "R1", "C1"}
                proposed = await _call(client, "propose_experiment",
                                       {"experiment": "discharge_1A", "rationale": "long trace"})
                assert (await _call(client, "status"))["proposal_id"] == proposed["proposal_id"]
                assert "browser approval" in await _call(client, "attach_data", {"proposal_id": proposed["proposal_id"],
                                                                                 "path": "pulses.csv"}, error=True)
                report = await _call(client, "report")
                assert report["status"] == "awaiting_data"
    asyncio.run(check())


@rust
def test_remote_wrapper_refuses_a_distinct_strategy_before_opening_books(tmp_path):
    lab = tmp_path / "remote lab ' quoted"
    lab.mkdir()
    bins = tmp_path / "offline bins"
    bins.mkdir()
    # Execute the remote shell command locally; nothing resolves or connects to a host.
    ssh = bins / "ssh"
    ssh.write_text("#!/usr/bin/env python3\nimport os,sys\nassert sys.argv[1]=='offline-lab'\n"
                   "os.execv('/bin/sh',['/bin/sh','-c',sys.argv[2]])\n")
    ssh.chmod(0o755)
    custom = lab / "custom strategy.md"
    custom.write_bytes(load_playbook().data + b"\nLocal strategy identity probe.\n")
    refused = builder()(tmp_path / "refused", autophys=BIN, project="battery_ecm", root=str(lab),
                        workbook=str(lab / "must not exist"), playbook=custom, ssh_host="offline-lab")
    env = {**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(refused / "mcp-stdio.sh")], input="", cwd=lab, env=env,
                            text=True, capture_output=True, timeout=30)
    assert result.returncode != 0
    assert "playbook digest mismatch" in result.stderr
    assert not (lab / "must not exist").exists()
