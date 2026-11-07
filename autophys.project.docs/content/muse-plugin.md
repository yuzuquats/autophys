# autophys meets engineers inside the agent they already use

Status: offline integration built, rev 3, 2026-11-06. The MCP server is the
Rust `autophys mcp` command (one-CLI plan phase B, [cli.md](cli.md)); it
replaced the Python `autophys.mcp` server with the same nine tools, input
schemas and JSON results. Since the CLI-11 decision (operator, 2026-11-06)
it serves a user's Python simulator through a Python SDK worker. Live Meta
execution awaits an operator-approved token budget; the echo provider does
not exercise MCP.

An engineer opens Muse Code in a lab repo and asks it to calibrate a cell
from `pulses.csv`. Muse imports measurements, fits the local simulator,
checks which parameters the measurements determine, and proposes the next
experiment. The proposal appears in the existing autophys workbook and
browser. Approval stays with the engineer.

## Where the calculation and the decision live

```
lab repo / pulses.csv → Muse Code + canonical playbook
                              │ stdio MCP
                              ▼
                 autophys mcp (Rust SDK)
                  fit → SVD → rank → proposal
                              │ ap.connect(target)
                              ▼
                      project.ap-workbook ← browser approval
                              │
                      attach data → checked report
```

The process runs next to the measurements. It serves the built-in
`battery_ecm` project or a Python `mypkg.module:project` reference (a
`Project` or `@ap.simulator` under `--root`): for the latter it starts
`python -m autophys.worker` in the interpreter named by `--python`
(default `AUTOPHYS_PYTHON`, else `python3`) and calls the simulator there,
while the fit, SVD, ranking and proposals run in the binary (cli.md CLI-11).
Neither the daemon nor Muse runs numerical code on behalf of the server. The
optional SSH bridge keeps the same stdio transport while running `autophys
mcp` on a remote host (the hackathon's split-host setup).

`--workbook` accepts the same directory, `.ap-workbook` file or daemon URL
as `ap.connect(...)`. A local workbook becomes visible when the viewer's
daemon serves its collection. A daemon URL uses the ordinary SDK credentials
and pairing flow; no credential is bundled.

## Install and use in an engineer's lab

From a checkout on the machine that holds the measurements, build the
`autophys` binary and a bundle that launches it:

```sh
cargo build --release --bin autophys
python3 plugins/muse-autophys/build.py --output /tmp/autophys-lab-plugin \
  --autophys "$PWD/target/release/autophys" --project battery_ecm \
  --workbook "$HOME/autophys" --root /absolute/path/to/lab
muse plugins install /tmp/autophys-lab-plugin
muse plugins approve autophys
cd /absolute/path/to/lab
muse
```

Use an absent output directory. `--autophys` defaults to `autophys` on PATH;
an explicit path is made absolute. With `--ssh-host`, it names the binary on
the remote host.

The plugin installation is one command; Muse's separate approval trusts the
MCP capability definition, as required for third-party plugins. It does not
approve any experiment. The source bundle can also be installed directly
with `muse plugins install plugins/muse-autophys`: it launches
`autophys mcp` from PATH and reads `.autophys-mcp.json` in the working
directory. The supported keys are `project`, `workbook`, `root`,
`investigation`, `playbook` and `python`. CLI flags override the file.
`build.py --project mylab.cell:project --python /lab/.venv/bin/python`
writes both into the generated bundle's configuration.

Tell Muse:

> Use the autophys calibration guide. Calibrate this cell from pulses.csv,
> experiment pulse_2A, voltage noise sigma 0.002 V. Fit, check
> identifiability, rank experiments and propose the most informative feasible
> next experiment. Give me the investigation and proposal IDs and stop for my
> browser approval. Do not approve it yourself.

Battery CSV defaults are `time` (seconds), `current` (A, positive
discharging) and `voltage` (V). The logical channel is `v`, so sigma is
`{"v":0.002}`. A column mapping is
`{"t":"seconds","current":"amps","v":"volts"}`. Sigma must be supplied or
declared by the project; it is never invented from the fit residual.

For the built-in path, the CSV must match a declared experiment's time grid
and current waveform: `discharge_1A`, `pulse_2A` or `pulse_train`.
Import refuses a mismatch, non-finite values, a test split, or a CSV outside
the configured lab root. Arbitrary measured current traces are not supported
by the built-in battery model; declare an appropriate simulator/catalog for
those. CSVs are limited to 1 MiB and 10,000 rows.

In the browser, the investigation contains versioned measurements, fits and
steps. Its proposed experiment carries the catalog settings, rationale,
criterion, score and E-1 outlook grid. Editable axes exist only when the
project declares them; the built-in shortcut has a one-point outlook.
Approve or edit there. On return to Muse, ask it to read `status`, attach
the new CSV, refit and report. It reports `inconclusive` without a passing
independent validation split even when all parameters are identified.

To reconnect to an investigation after restarting Muse, set
`investigation` in the config or start the server with
`--investigation inv_...`. The server reconstructs the fit and measurements
from the workbook, checks for stale fits and reads approvals from the store.

## Tool surface

```review-table
| Tool | Input | Compact result |
| ---- | ----- | -------------- |
| describe_project | none | parameter units/bounds, catalog/settings/edit limits, CSV root, workbook |
| import_measurements | path, catalog experiment, columns, sigma, train/validation split | investigation/measurement IDs, measurement version and sample count |
| fit | n_starts (1..16), loss | parameter estimates, convergence, chi2/N, bounds |
| identifiability | none | SVD rule, verdict per parameter, unresolved combinations |
| rank_experiments | min_eig or d_opt criterion | catalog names and Fisher scores |
| propose_experiment | catalog experiment, rationale, expected_information | investigation/proposal IDs, proposed state, approval location |
| status | optional proposal ID | current folded proposal state, without waiting |
| attach_data | proposal ID, CSV path, columns and sigma | data_attached state, measurement version and sample count |
| report | none | SDK outcome with guardrail-checked identified list |
```

There is no approve or reject tool, and `report` accepts no identified
claim or status from the agent. It recomputes sensitivity and validation,
then calls the ordinary SDK finish guardrail. Measurement arrays and outlook
grids stay in the workbook rather than in MCP replies. Numerical calls share
the investigation's step/simulation budgets and record structured steps.
Initial CSV import is refused while a proposal awaits approval or data, so
that tool cannot stand in for `attach_data`.

## Choices and alternatives

Muse Code 1.4.14's bundled native plugin reference explicitly accepts
`capabilities.mcpServers` with `transport: "stdio"` and structured command
argv in `.muse-plugin/plugin.json`. Its `muse mcp --help` describes HTTP
OAuth only; it is not the transport capability list. Native validation
confirmed stdio support.

Agent-chosen, pending operator review. These choices add no workbook format.

```review-table
| Id | Choice and reason | Strongest alternative | Reverse |
| -- | ----------------- | --------------------- | ------- |
| MP-1 | Stdio, supported by Muse; no listener or separate server lifecycle | Streamable HTTP on 127.0.0.1 needs process supervision | replace adapter and manifest |
| MP-2 | (rev 2) Official MCP 1.x SDK in optional autophys[mcp], tested with 1.30.0. **Superseded in rev 3** by CLI-1: a line-delimited JSON-RPC server in `src/devtools/mcp.rs` with the tool schemas FastMCP generated, checked against the Python server's responses and with the official Python MCP client (cli.md phase B) | keep the Python server and the `mcp` extra | restore `autophys.mcp` from history |
| MP-3 | Nine tools delegate to Investigation; no approve/reject or agent-supplied identified list | Generic Python execution widens the surface | change registrations |
| MP-4 | Builder copies canonical M-2 SKILL.md byte for byte and records sha256 | A second strategy would drift | rebuild from canonical source |
| MP-5 | CSV must match a declared battery waveform and grid | Guessing inputs risks fitting the wrong physics | add measured-waveform support with SDK owner |
| MP-6 | Lab paths go in generated mcp-config.json; optional SSH uses a hashed wrapper | Putting shell strings/path-like arguments directly in manifest failed Muse validation | change builder only |
```

The canonical skill is
`sdks/python/src/autophys/playbooks/default/SKILL.md`, supplied by M-2.
The canonical bytes were available in the shared tree before M-2’s commit,
so this bundle carries that exact snapshot rather than a guessed strategy.
Its copied bytes currently hash to
`cd65c7b3bb19471f3a76e42a9b331a1134cc46f176ca599f5a0466bcc1e0e35a`.
The investigation pins `playbook {name, version, sha256}`; M-2's
Investigation stores the skill blob for local workbooks. While M-2’s loader
is not installed, a small MCP compatibility reader loads the same bundled
bytes and pins the same metadata/blob; it contains no strategy of its own.
Local manifests pass the installed SKILL.md explicitly via `--playbook`;
the native SDK loader takes over when available. The builder can rebuild
from the hash-checked snapshot before canonical source lands. The plugin’s
`calibrate` command maps conceptual playbook actions to MCP tool names; it
does not maintain a second strategy or replace the guardrail.

The M-2 loader itself is still the Python owner’s uncommitted work at this
receipt; the committed plugin works independently through the compatibility
reader. The Python owner retains the canonical playbook, numerics, battery case
suite and evaluator. This integration owns the MCP package and native bundle.
Rust, daemon and browser UI retain their owners.

## What was verified

All source reads, writes and Python tests ran over SSH on rwc-dev-01 in
`~/workspace/autophys`. Tests used `~/.cache/autophys/venv` and
`PYTHONDONTWRITEBYTECODE=1`. MCP 1.30.0 was installed there as the optional
extra's dependency. The integration suite uses a real in-memory MCP client
and a real stdio subprocess, without a reasoner or model call.

The 13 integration tests cover the exact tool list (including absence of
approve/reject), JSON object mappings, synthetic battery fit → SVD → ranking
→ proposed outlook, rejected attachment before approval (including direct
store refusal), approval by a second process, attachment/refit/report,
resume, canonical skill pin, waveform/time/noise/path checks, budgets, a
small-residual yet non-identified case, independent validation, and bundle
generation with correct venv and SSH quoting, and pinning without M-2’s loader.

An initial full SDK run passed 350 tests with 2 opt-in skips in 93.45 s.
After the compatibility check and concurrent SDK additions, the final shared
suite passed 358 tests with 2 skips in 93.45 s. The integration subset passed
13 in 5.90 s. A clean `git archive` snapshot of committed HEAD (9b6b854), with
no M-2 working-tree files, passed its entire Python suite: 324 passed, 2
skipped in 84.19 s. Its bundle also rebuilt from the canonical snapshot with
byte-identical skill contents. No branch or Git worktree was created.
The full suite's skips are live reason-lane and opt-in Rust cross-writer
integration, as documented in the SDK README.

Muse commands were run on the laptop at `~/.local/bin/muse`. Apart from
help/version, every command set all three XDG roots to temporary directories
under `/tmp/autophys-muse-check.uallNI`: config, data and cache. No plugin
was installed into the user's real configuration. The copies and temporary
install were deleted after verification, including their XDG configuration,
data, cache and logs. The remote bridge/probe and clean archive were removed
after their checks.

The exact discovery commands were:

```sh
~/.local/bin/muse --version
~/.local/bin/muse --help
~/.local/bin/muse plugins --help
~/.local/bin/muse mcp --help
~/.local/bin/muse plugins inspect --help
~/.local/bin/muse exec --help
```

They returned 1.4.14 (1.4.14-R7309.1), native install/validate/inspect and
runtime capability trust commands, and the deterministic echo provider.

For the remaining commands below, the exact common environment prefix was:

```sh
XDG_CONFIG_HOME=/tmp/autophys-muse-check.uallNI/config \
XDG_DATA_HOME=/tmp/autophys-muse-check.uallNI/data \
XDG_CACHE_HOME=/tmp/autophys-muse-check.uallNI/cache
```

With that prefix before `~/.local/bin/muse`, the commands and results were:

```review-table
| Arguments | Result |
| --------- | ------ |
| skills validate /tmp/autophys-muse-check.uallNI/bundle/skills/autophys --json | valid true, diagnostics empty |
| plugins validate /tmp/autophys-muse-check.uallNI/bundle --json | valid true, diagnostics empty |
| plugins install /tmp/autophys-muse-check.uallNI/bridge --json (first attempt) | rejected a shell command string as missing-capability-path |
| plugins inspect autophys --json (after rejected install) | unknown-plugin |
| plugins install /tmp/autophys-muse-check.uallNI/bridge --json (after wrapper correction) | installed, native, enabled; MCP review_needed |
| plugins inspect autophys --json | valid/active, command and skill effective, MCP review_needed |
| plugins approve autophys --json | isolated MCP definition trusted and enabled |
| plugins inspect autophys --json (after approval) | MCP trusted_enabled |
| plugins validate /tmp/autophys-muse-check.uallNI/generated --json | configured local variant valid, diagnostics empty |
| plugins validate /tmp/autophys-muse-check.uallNI/final-generated --json | generated SSH variant valid, diagnostics empty |
| plugins validate /tmp/autophys-muse-check.uallNI/bundle --json (after explicit skill pin) | final source variant valid, diagnostics empty |
| plugins validate /tmp/autophys-muse-check.uallNI/final-local --json | final configured variant preserves venv path; valid, diagnostics empty |
```

The exact echo command (same prefix) was:

```sh
~/.local/bin/muse exec --provider echo \
  --workspace /tmp/autophys-muse-check.uallNI/lab --trust-workspace \
  --disable-sandbox --disable-shell --disable-write --approval-judge off \
  --no-foreign-personal-context --disable-reminders --disable-web-tools \
  --disable-request-user-input --no-session-log --json \
  'Check autophys plugin startup without model calls.'
```

It exited zero, returned the deterministic echo, and reported zero input and
output tokens. Muse reported 57 loaded skills and its bundled catalog-size
warning. The plugin was installed and visible in Muse's active capability
snapshot, rather than merely validated. However, echo did not launch the MCP
process (no workbook was created), so actual Muse-to-MCP dispatch remains
unverified. The SDK stdio client did initialize the real server and enumerate
all nine tools. There were no Meta API, live reasoner, model-judge or
`muse --provider meta` calls.

## Live demo on the current split-host setup

The operator can run this sequence on the laptop after approving a token
budget. It creates explicitly synthetic pulse data on rwc-dev-01; replace it
with a matching measured CSV for a real lab demonstration. The default daemon
must be serving `/home/james/autophys` for browser review. The generated
plugin uses SSH stdio because Muse exists on the laptop and the `autophys`
binary and the measurements are on rwc-dev-01 (rev 3: the server is
`autophys mcp`; the CSV step still uses the Python SDK's battery model).

```sh
demo_remote_dir=$(ssh rwc-dev-01 'mktemp -d /tmp/autophys-muse-demo.XXXXXX')
ssh rwc-dev-01 "cd ~/workspace/autophys && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=sdks/python/src ~/.cache/autophys/venv/bin/python - '$demo_remote_dir'" <<'PY'
import csv
from pathlib import Path
import sys
from autophys.models.battery import battery_ecm, current
root = Path(sys.argv[1])
settings = battery_ecm.experiment("pulse_2A")
prediction = battery_ecm({"R0": 0.025, "R1": 0.045, "C1": 1600.0}, settings)
cur = current(settings)
with (root / "pulses.csv").open("w") as out:
    writer = csv.writer(out)
    writer.writerow(["time", "current", "voltage"])
    writer.writerows((t, cur(t), v) for t, v in zip(prediction["t"], prediction["v"]))
PY
ssh rwc-dev-01 "cd ~/workspace/autophys && python3 plugins/muse-autophys/build.py \
  --output '$demo_remote_dir/plugin' --ssh-host rwc-dev-01 \
  --autophys /path/to/an/autophys/build/on/rwc-dev-01 \
  --project battery_ecm --workbook /home/james/autophys --root '$demo_remote_dir'"
demo_local_dir=$(mktemp -d /tmp/autophys-muse-demo.XXXXXX)
scp -r "rwc-dev-01:$demo_remote_dir/plugin" "$demo_local_dir/plugin"
mkdir "$demo_local_dir/lab"
~/.local/bin/muse plugins install "$demo_local_dir/plugin"
~/.local/bin/muse plugins approve autophys
cd "$demo_local_dir/lab"
~/.local/bin/muse
```

Use the calibration prompt above. The relative CSV path is resolved on the
remote server against its configured root; `describe_project` reports that
root. Open the existing autophys viewer and select the battery_ecm workbook,
investigation and proposal returned by the tool. If needed, reach the daemon
in a separate terminal with
`ssh -N -L 14794:127.0.0.1:4794 rwc-dev-01` and open
`http://127.0.0.1:14794/app`.

After human approval and acquisition of the proposed experiment's real data,
copy its CSV into the same remote lab root, ask Muse to call `status` and
`attach_data`, and refit/report. An approved edit changes the waveform/grid
against which attachment is checked. Do not represent generated demo
measurements as physical validation.

```review-callout
kind: risk
title: The remaining live boundary
Plugin validation, isolated install/trust and SDK protocol execution are
measured. A live Muse Code model choosing and dispatching the tools, and a
browser approval during that live interaction, are not measured here.
The no-token echo provider did not start MCP. A real Muse run could still
expose runtime discovery or permission behavior that the SDK client cannot
test; that is the first live check once a budget is approved.
```
