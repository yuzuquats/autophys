"""No model calls: real MCP protocol, SDK numerics and another workbook writer."""
import asyncio
import csv
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest

pytest.importorskip("mcp")
from mcp.shared.memory import create_connected_server_and_client_session

from autophys.agent import ToolError
from autophys.mcp import MCPSession, load_project
from autophys.mcp.server import create_server
from autophys.models.battery import current
from autophys.mcp.playbook import load_playbook
from autophys.sensitivity import jacobian, report_from_jacobian

TOOLS = {"describe_project", "import_measurements", "fit", "identifiability",
         "rank_experiments", "propose_experiment", "status", "attach_data", "report"}
TRUTH = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}


def write_csv(path, project, experiment, settings=None, headers=("time", "current", "voltage")):
    settings = settings or project.simulator.experiment(experiment)
    pred = project.simulator(TRUTH, settings)
    cur = current(settings)
    with path.open("w") as out:
        w = csv.writer(out)
        w.writerow(headers)
        w.writerows((t, cur(t), v) for t, v in zip(pred["t"], pred["v"]))


@pytest.fixture
def session(tmp_path):
    project = load_project("battery_ecm")
    write_csv(tmp_path / "pulses.csv", project, "pulse_2A")
    s = MCPSession(project, str(tmp_path / "books"), root=tmp_path)
    yield s
    s.close()


def child_env():
    import autophys
    return {**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(Path(autophys.__file__).resolve().parent.parent)}


def invoke(coro):
    return asyncio.run(coro)


async def call(client, name, arguments=None, error=False):
    result = await client.call_tool(name, arguments or {})
    assert bool(result.isError) == error, result.content
    text = result.content[0].text
    return text if error else json.loads(text)


def test_tool_catalog_has_no_approval_and_object_mappings(session):
    async def check():
        async with create_connected_server_and_client_session(create_server(session)) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            assert set(tools) == TOOLS
            assert not any("approve" in n or "reject" in n for n in tools)
            assert not hasattr(session, "approve") and not hasattr(session, "reject")
            props = tools["import_measurements"].inputSchema["properties"]
            assert any(x.get("type") == "object" for x in props["sigma"]["anyOf"])
            assert tools["report"].inputSchema["properties"] == {}
            info = await call(client, "describe_project")
            assert info["parameters"]["R0"]["unit"] == "ohm"
            assert set(info["catalog"]) == set(session.project.catalog)
    invoke(check())


def test_protocol_cycle_and_external_approval(session, tmp_path):
    async def check():
        async with create_connected_server_and_client_session(create_server(session)) as client:
            imported = await call(client, "import_measurements", {
                "path": "pulses.csv", "experiment": "pulse_2A", "sigma": {"v": 0.002}})
            assert imported["measurement_version"] == 1
            fit = await call(client, "fit", {"n_starts": 1})
            assert fit["converged"]
            for key, truth in TRUTH.items():
                assert fit["params"][key] == pytest.approx(truth, rel=0.02)
            verdict = await call(client, "identifiability")
            inv = session.inv
            independent = report_from_jacobian(inv.sim.param_names,
                jacobian(inv.sim, inv.fit.params, inv.dataset.split("train")), inv.rule, inv.fit.params)
            assert verdict["identified"] == independent.identified
            ranked = await call(client, "rank_experiments")
            name = ranked["ranking"][0][0]
            proposed = await call(client, "propose_experiment", {
                "experiment": name, "rationale": "Measure the weakest parameter direction."})
            pid = proposed["proposal_id"]
            assert proposed["investigation"] == imported["investigation"]
            assert session.inv.records("proposal")[-1].payload["outlook"]["score"]
            assert (await call(client, "status"))["status"] == "proposed"
            before = len(session.inv.records())
            message = await call(client, "attach_data", {
                "proposal_id": pid, "path": "does-not-exist.csv", "sigma": {"v": 0.002}}, error=True)
            assert "approval" in message
            assert len(session.inv.records()) == before
            from autophys.store import StoreError
            with pytest.raises(StoreError):
                session.workbook.store.append(session.inv.id, "proposal", {
                    "proposal_id": pid, "event": "data_attached", "measurement_version": 2})
            await call(client, "import_measurements", {
                "path": "pulses.csv", "experiment": "pulse_2A", "sigma": {"v": 0.002}}, error=True)
            # The second process stands for the human browser writer; no MCP approval tool.
            code = """from autophys.workbook import WorkbookStore
import sys
with WorkbookStore(sys.argv[1], create=False) as store:
    store.append(sys.argv[2], "proposal", {"proposal_id": sys.argv[3],
        "event": "approved", "by": "browser-reviewer", "via": "browser"})
"""
            subprocess.run([sys.executable, "-c", code, session.target, session.inv.id, pid],
                           check=True, env=child_env())
            assert (await call(client, "status"))["status"] == "approved"
            settings = session.inv.proposal(pid)["settings"]
            write_csv(tmp_path / "approved.csv", session.project, name, settings)
            attached = await call(client, "attach_data", {
                "proposal_id": pid, "path": "approved.csv", "sigma": {"v": 0.002}})
            assert attached["measurement_version"] == 2
            await call(client, "report", error=True)  # stale fit cannot claim identification
            await call(client, "fit", {"n_starts": 1})
            verdict = await call(client, "identifiability")
            report = await call(client, "report")
            assert report["identified"] == verdict["identified"]
            assert report["status"] == "inconclusive"  # no independent validation split
            assert report["guardrail_overrides"] == []
            head = session.inv.records()[0].payload
            book = load_playbook()
            assert head["playbook"]["sha256"] == book.sha256
            assert session.workbook.verify()["ok"]
            # Recorded outcome survives reconnect, with its fit pinned to current measurements.
            resumed = MCPSession(session.project, session.target, root=tmp_path,
                                 investigation=session.inv.id)
            try:
                assert resumed.inv.outcome.identified == report["identified"]
                assert resumed.inv.dataset.version == 2
            finally:
                resumed.close()
    invoke(check())


@pytest.mark.parametrize("change,match", [
    ("current", "current differs"), ("time", "time grid"), ("nan", "finite")])
def test_csv_rejects_wrong_physics(session, tmp_path, change, match):
    path = tmp_path / "pulses.csv"
    rows = list(csv.reader(path.open()))
    rows[2][{"time": 0, "current": 1, "nan": 2}[change]] = "nan" if change == "nan" else "0.123"
    with path.open("w") as out:
        csv.writer(out).writerows(rows)
    with pytest.raises(ValueError, match=match):
        session.import_measurements("pulses.csv", "pulse_2A", sigma={"v": 0.002})
    assert session.inv is None


def test_csv_mapping_validation_and_root(session, tmp_path):
    write_csv(tmp_path / "renamed.csv", session.project, "pulse_2A",
              headers=("seconds", "amps", "volts"))
    with pytest.raises(ValueError, match="inside"):
        session.import_measurements("../outside.csv", "pulse_2A", sigma={"v": 0.002})
    with pytest.raises(ValueError, match="evaluator"):
        session.import_measurements("pulses.csv", "pulse_2A", sigma={"v": 0.002}, split="test")
    with pytest.raises(ValueError, match="sigma"):
        session.import_measurements("pulses.csv", "pulse_2A")
    result = session.import_measurements("renamed.csv", "pulse_2A",
        columns={"t": "seconds", "current": "amps", "v": "volts"}, sigma={"v": 0.002})
    assert result["measurement_version"] == 1
    session.import_measurements("renamed.csv", "pulse_2A",
        columns={"t": "seconds", "current": "amps", "v": "volts"},
        sigma={"v": 0.002}, split="validation")
    assert session.inv.dataset.version == 2


def test_step_budget_is_enforced(session):
    from dataclasses import replace
    session.import_measurements("pulses.csv", "pulse_2A", sigma={"v": 0.002})
    session.inv.budgets = replace(session.inv.budgets, max_steps=0)
    with pytest.raises(ToolError, match="step budget"):
        session.fit()


def test_stdio_cli_handshake(tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def check():
        params = StdioServerParameters(command=sys.executable,
            args=["-m", "autophys.cli", "mcp", "--project", "battery_ecm",
                  "--workbook", str(tmp_path / "stdio"), "--root", str(tmp_path)],
            env=child_env())
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                assert {t.name for t in (await client.list_tools()).tools} == TOOLS
                assert (await call(client, "describe_project"))["name"] == "battery_ecm"
    invoke(check())

def test_small_residual_is_not_identification(session):
    session.import_measurements("pulses.csv", "pulse_2A", sigma={"v": 10.0})
    session.fit(n_starts=1)
    report = session.report()
    assert report["fit"]["converged"]
    assert report["fit"]["chi2_per_n"] < 1e-4
    assert report["identified"] == []
    assert set(report["non_identified"]) == set(TRUTH)
    assert report["status"] == "inconclusive"


def test_independent_validation_permits_validated_report(session):
    session.import_measurements("pulses.csv", "pulse_2A", sigma={"v": 0.002})
    write_csv(session.root / "validation.csv", session.project, "pulse_train")
    session.import_measurements("validation.csv", "pulse_train", sigma={"v": 0.002}, split="validation")
    session.fit(n_starts=1)
    report = session.report()
    assert report["status"] == "validated"
    assert set(report["identified"]) == set(TRUTH)
    assert report["validation"]["passed"]


def test_plugin_builder_keeps_canonical_skill_and_paths_in_config(tmp_path):
    import hashlib
    import runpy
    source = Path(__file__).resolve().parents[3] / "plugins/muse-autophys"
    if not source.exists():
        pytest.skip("plugin sources are not part of the Python wheel")
    build = runpy.run_path(str(source / "build.py"))["build"]
    result = build(tmp_path / "bundle", python=sys.executable, project="battery_ecm",
                   root=str(tmp_path), workbook=str(tmp_path / "books"))
    canonical = load_playbook()
    data = (result / "skills/autophys/SKILL.md").read_bytes()
    assert data == canonical.data
    assert json.loads((result / "playbook.json").read_text())["sha256"] == hashlib.sha256(data).hexdigest()
    manifest = json.loads((result / ".muse-plugin/plugin.json").read_text())
    argv = manifest["capabilities"]["mcpServers"][0]["command"]
    assert argv == [str(Path(sys.executable).absolute()), "-m", "autophys.cli", "mcp",
                    "--config", "mcp-config.json", "--playbook", "skills/autophys/SKILL.md"]
    assert json.loads((result / "mcp-config.json").read_text())["root"] == str(tmp_path)
    with pytest.raises(FileExistsError):
        build(result)


def test_ssh_bundle_keeps_simulator_on_remote_host_and_quotes_paths(tmp_path):
    import runpy
    import shlex
    source = Path(__file__).resolve().parents[3] / "plugins/muse-autophys"
    if not source.exists():
        pytest.skip("plugin sources are not part of the Python wheel")
    build = runpy.run_path(str(source / "build.py"))["build"]
    result = build(tmp_path / "ssh", python="/remote/venv/bin/python", project="battery_ecm",
                   root="/remote/my lab", workbook="/remote/my books", ssh_host="rwc-dev-01",
                   source_root="/remote/sdk/src")
    script = (result / "mcp-stdio.sh").read_text().splitlines()[1]
    local_args = shlex.split(script)
    assert local_args[:3] == ["exec", "ssh", "rwc-dev-01"]
    remote_args = shlex.split(local_args[3])
    assert remote_args[:4] == ["env", "PYTHONDONTWRITEBYTECODE=1", "PYTHONPATH=/remote/sdk/src",
                              "/remote/venv/bin/python"]
    assert remote_args[-1] == "/remote/my lab"
    assert "/remote/my books" in remote_args


def test_canonical_snapshot_pins_without_m2_loader(tmp_path, monkeypatch):
    import hashlib
    import sys
    from autophys.mcp.playbook import load_playbook as compatible
    canonical = compatible()
    file = tmp_path / "SKILL.md"
    file.write_bytes(canonical.data)
    monkeypatch.setitem(sys.modules, "autophys.playbook", None)
    snapshot = compatible(file)
    assert snapshot.sha256 == hashlib.sha256(canonical.data).hexdigest()
    assert snapshot.name == canonical.name
    project = load_project("battery_ecm")
    write_csv(tmp_path / "pulse.csv", project, "pulse_2A")
    with_session = MCPSession(project, str(tmp_path / "books"), root=tmp_path, playbook=file)
    try:
        with_session.import_measurements("pulse.csv", "pulse_2A", sigma={"v": 0.002})
        assert with_session.inv.records()[0].payload["playbook"]["sha256"] == snapshot.sha256
        assert with_session.workbook.verify()["ok"]
    finally:
        with_session.close()


def test_plugin_launchers_resolve_installed_resources_and_keep_lab_cwd(tmp_path):
    """Execute the manifest after relocation, with no provider or remote call."""
    import os
    import runpy
    import shutil
    import subprocess
    source = Path(__file__).resolve().parents[3] / "plugins/muse-autophys"
    if not source.exists():
        pytest.skip("plugin sources are not part of the Python wheel")
    build = runpy.run_path(str(source / "build.py"))["build"]
    lab = tmp_path / "lab"
    lab.mkdir()
    bins = tmp_path / "bin"
    bins.mkdir()
    recorder = bins / "python recorder"
    recorder.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                        "from pathlib import Path\n"
                        "args=sys.argv[1:]\n"
                        "config=Path(args[args.index('--config')+1])\n"
                        "playbook=Path(args[args.index('--playbook')+1])\n"
                        "print(json.dumps({'argv':args,'cwd':os.getcwd(),"
                        "'config':json.loads(config.read_text()),"
                        "'playbook':playbook.read_text()}))\n")
    recorder.chmod(0o755)
    local = build(tmp_path / "local", python=str(recorder), project="user_sim:project",
                  root=".", workbook="relative books")
    installed = tmp_path / "relocated install"
    shutil.move(str(local), installed)
    argv = json.loads((installed / ".muse-plugin/plugin.json").read_text())["capabilities"]["mcpServers"][0]["command"]
    assert argv == ["./mcp-stdio.sh"]
    # Muse resolves a path-like executable against the installed package.
    result = subprocess.run([str(installed / argv[0])], cwd=lab, text=True,
                            capture_output=True, check=True)
    received = json.loads(result.stdout)
    assert received["cwd"] == str(lab)
    assert received["config"] == {"project": "user_sim:project", "root": ".", "workbook": "relative books"}
    assert received["playbook"].encode() == load_playbook().data
    for flag in ["--config", "--playbook"]:
        assert Path(received["argv"][received["argv"].index(flag) + 1]).is_relative_to(installed)

    ssh = bins / "ssh"
    ssh.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                   "print(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd()}))\n")
    ssh.chmod(0o755)
    remote = build(tmp_path / "remote", python="/remote/my venv/python", project="user_sim:project",
                   root="relative lab", workbook="relative books", ssh_host="lab-alias",
                   source_root="/remote/sdk src")
    installed_remote = tmp_path / "relocated remote"
    shutil.move(str(remote), installed_remote)
    argv = json.loads((installed_remote / ".muse-plugin/plugin.json").read_text())["capabilities"]["mcpServers"][0]["command"]
    result = subprocess.run([str(installed_remote / argv[0])], cwd=lab, text=True,
                            capture_output=True, check=True,
                            env={**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"]})
    received = json.loads(result.stdout)
    import shlex
    assert received["cwd"] == str(lab)
    assert received["argv"][0] == "lab-alias"
    assert shlex.split(received["argv"][1]) == [
        "env", "PYTHONDONTWRITEBYTECODE=1", "PYTHONPATH=/remote/sdk src",
        "/remote/my venv/python", "-m", "autophys.cli", "mcp",
        "--project", "user_sim:project", "--workbook", "relative books", "--root", "relative lab"]
    assert (installed_remote / "skills/autophys/SKILL.md").read_bytes() == load_playbook().data
