/**
 * The landing's documentation: one markdown page, drawn by tento-ui's std-documentation,
 * placed in the document flow after the viewport-height deck and before the cookbook footer,
 * so scrolling past the pitch reaches the manual. Sources: README.md, sdks/python/README.md
 * and autophys.project.docs/content (architecture.md, muse-plugin.md, sdk.md, rust-sdk.md);
 * the Reference section is checked against src/scripts.rs, src/server.rs, src/admin.rs,
 * sdks/python/src/autophys (cli.py, __init__.py) and sdks/rust/src at the committed tree.
 * Keep every claim checkable there; numbers that need a real run stay out of this page (the
 * deck's TBDs cover them).
 *
 * std-documentation renders through tento's ProseMirror bundle, which tento-ui loads from
 * InstanceUrl.staticUrl("/js/prosemirror.min.js"). autophys serves no static subdomain, so the
 * static base is this origin and the bundle ships beside this file as js/prosemirror.min.js
 * (the committed tento-plugins-js build other tento apps serve, sha256 b4c9b9e4c64d…).
 *
 * Code blocks are coloured by tento-ui's own tokenizers (shell, Python, TOML) and a local Rust
 * one (rust-tokenizer.ts), registered for their fence names and drawn with Code's static
 * rendering: the committed CodeMirror bundle predates `streamLanguage`, so the editor path
 * would draw a registered language plain. Static output
 * is read-only text with tok-* spans, which is all a documentation page needs.
 */
import "@tento-ui/components/documentation/documentation";
import { Documentation } from "@tento-ui/components/documentation/documentation";
import { Code } from "@tento-ui/components/code/code";
import { shellTokenizer } from "@tento-ui/components/code/languages/shell";
import { pythonTokenizer } from "@tento-ui/components/code/languages/python";
import { tomlTokenizer } from "@tento-ui/components/code/languages/toml";
import { rustTokenizer } from "./rust-tokenizer.ts";
import { inlineCodeTokenizer } from "./inline-code.ts";
import { MUSE_PEEK_CSS, museSectionPeek } from "./muse-peek.ts";
import { LispExampleView } from "@tento-ui/components/lisp-example/lisp-example-view";
import { ReviewFence } from "@tento-ui/components/review-notes/review-fence";
import { LOOPS_FENCE, LoopsFigureView } from "./loops-figure.ts";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { InstanceUrl } from "@tento-core/instance-url";
import type { Cookbook } from "@tento-cookbook/lib.ts";

export const DOCS_MARKDOWN = `# How autophys works

autophys fits a physical model to your measurements, then tells you which parameters those measurements actually pin down, and which experiment to run next.

## Overview

A parameter counts as **identified** only if the data determines it to better than ±10%. That verdict comes from a sensitivity analysis (an SVD of the log-Jacobian), not from how good the fit looks.

When parameters are tied together, autophys ranks the candidate experiments by Fisher information and proposes the one that would separate them. An agent (Muse Spark, or a scripted policy) can drive that loop, and a person approves each experiment in this workbench before it runs.

## Quick start: fit a battery cell

You need Python 3.10 or newer. There are no accounts or keys.

\`\`\`sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys/examples/battery_fit
./run.sh                              # fits the bundled demo cell, writes fit.png
./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
\`\`\`

\`examples/battery_fit/README.md\` covers inputs, sample data, expected output and how to read the result, including the R1 ↔ C1 trade-off that a single pulse leaves unresolved.

## The closed loop

1. Fit the model to the measurements you have.
2. Check identifiability: each parameter is either identified or tied to others.
3. Rank the catalogue experiments by how well they would separate the tied parameters.
4. The agent proposes one, with its rationale and expected information.
5. You approve, edit or reject it here in the workbench.
6. The new data is attached to the proposal, and the loop fits again.

A proposal moves from \`proposed\` to \`approved\`, \`edited\` or \`rejected\` (or \`withdrawn\` by the SDK), then to \`data_attached\`. The final report's identified list is always recomputed and checked in code; the agent cannot assert it.

## Python SDK

Wrap your simulator with \`@ap.simulator\`, describe the project and its budgets, and run an investigation. It stops at \`awaiting_data\` at the first proposal; any later process can resume it from the records.

\`\`\`python
import autophys as ap

@ap.simulator(params={"C": ("J/K", 10, 1e5), "R": ("K/W", 0.01, 100)},
              experiments={"step": {"kind": "step", "power": 10, "duration": 120, "rate": 1}},
              outputs=("T",))
def block(params, experiment, options=ap.FIT_OPTIONS):
    ...  # return {"t": t, "T": temperature}

project = ap.Project("heated-block", block, budgets=ap.Budgets(max_experiments=2))
wb = ap.connect("~/autophys").project(project)
inv = wb.investigate(measurements, ap.ProposalRunner(), policy=ap.ScriptedPolicy())
outcome = inv.run()            # ends "awaiting_data" at the first proposal

# later, in any process:
inv = ap.connect("~/autophys").project(project).investigation(outcome.investigation)
inv.wait_for_approval()        # your approve/edit in the workbench lands in the workbook
inv.attach_data(outcome.proposal_id, observation)
inv.run()
\`\`\`

| Call | What it does |
| --- | --- |
| \`ap.connect(target)\` | A directory, a \`.ap-workbook\` file, an \`http(s)://\` daemon URL, or nothing (\`$AUTOPHYS_HOME\`, default \`~/autophys\`). |
| \`client.project(project)\` | The project's workbook, created if new. |
| \`wb.investigate(…)\` | A new recorded investigation; \`.run()\` runs the loop. |
| \`wb.investigation(id)\` | Resume an investigation from its records. |
| \`inv.approve\`, \`inv.reject\`, \`inv.attach_data\` | The proposal verbs; \`wait_for_approval()\` blocks until a reviewer decides. |

## Workbooks

Each project lives in one workbook, \`<project>.ap-workbook\`, a SQLite file. Records are appended to a hash-chained log under the daemon's validation and proposal rules, so the SDK, a second process and this workbench can all write the same file. The Rust and Python SDKs implement the same format.

## Muse Code plugin

The plugin runs a local MCP server next to your simulator, so Muse can drive the calibration while the numerical work stays in the SDK.

\`\`\`sh
pip install -e 'sdks/python[mcp]'
muse plugins install plugins/muse-autophys
python -m autophys.cli mcp --project mypkg.module:project --workbook ~/autophys
\`\`\`

Tools: \`describe_project\`, \`import_measurements\`, \`fit\`, \`identifiability\`, \`rank_experiments\`, \`propose_experiment\`, \`status\`, \`attach_data\` and \`report\`. There is no approve or reject tool: experiments are approved here, in the browser.

## The workbench

Open the workbench from the top of this page. The sidebar lists projects and their investigations; the main pane draws measured data, parameter estimates and sensitivity; the details panel shows the selected record. The workbench reads the daemon's recorded investigation and updates live as records arrive.

It does not draw the fitted curve yet; use the battery example for curves.

## Repository map

| Path | What it is |
| --- | --- |
| \`examples/battery_fit\` | Fit a measured battery trace, check identifiability, plot the curve. |
| \`sdks/python\` | Python SDK: simulator, fit, identifiability, experiment ranking, agent loop, workbook. |
| \`sdks/rust\` | Rust SDK. |
| \`plugins/muse-autophys\` | Muse Code plugin (local MCP server). |
| \`src/\`, \`html/\` | Rust daemon and this browser workbench. |
| \`autophys.project.docs\` | Design notes and decisions. |

## How the loops nest

autophys has two loops. They are nested, not concurrent: the outer loop calls the inner one.

- **Investigation (inner).** One calibration: an agent fits the model, checks identifiability, ranks experiments, requests data and stops. Its strategy is a playbook, a \`SKILL.md\` file.
- **Research (outer).** \`autophys research\` improves that playbook. It scores a playbook by running complete investigations on synthetic cases with a hidden truth, asks a researcher model for an edit, and keeps the edit only if the score improves.

Each research step waits for all of its investigations before it decides. The investigations within a step are independent and run in parallel with \`--jobs\`.

\`\`\`autophys-loops
\`\`\`

The score is lexicographic: the number of runs whose status and diagnosis are correct, then the mean log parameter error, then cost. The held-out seeds are kept apart from the start and only used at the end. An edit that fails validation is logged and skipped, and still uses up an iteration.

Inside each evaluation, an investigation is not a fixed cycle. At every step the policy picks one action until it stops or a budget runs out, so the order depends on the policy. The figure shows the scripted policy's usual order. It also compares a sensor-bias variant of the model when the fit is poor.

| Mode | What runs | Where new data comes from |
| --- | --- | --- |
| \`autophys research\` | the outer loop, calling many investigations | a synthetic case's hidden truth, with no person in the loop |
| \`autophys bench\` | investigations across policies, cases and seeds, with no playbook search | the same synthetic truth |
| Workbench or Muse Code | one investigation at a time, on your measurements | an experiment you approve here and run on your hardware |

Live model calls are off by default: \`research\` and \`bench --policy reason\` need a recorded replay, or \`AUTOPHYS_ALLOW_LIVE_REASON=1\`. With the defaults (every built-in case, three train seeds and two held-out seeds), a research run evaluates three investigations per case for the baseline and for each valid edit, and four per case on the held-out seeds at the end (two seeds, for the starting and the final playbook).

Not built yet, and under discussion in the design notes: a research journal that feeds rejected edits back to the researcher, procedurally sampled and misspecified cases, a statistical acceptance rule, and model discovery, where the agent proposes rival model structures when validation fails.

## Reference

Two different programs are called \`autophys\`:

- The **daemon** is a Rust binary built from \`src/\`. It serves this workbench and the \`/api/v1\` endpoints, and manages device keys and workbooks. Its commands include \`serve\`, \`build-web\`, \`approve\` and \`verify\`.
- The **Python CLI** is the console script the Python SDK installs (\`autophys.cli:main\`). It pairs a device with a daemon, runs benchmarks and playbook research, and serves the Muse Code tools. Its commands include \`pair\`, \`bench\`, \`research\` and \`mcp\`.

Install them separately and call each one by path, so you always know which one runs. From the repository root:

\`\`\`sh
# The daemon (Rust)
cargo build --release --bin autophys
./target/release/autophys --help            # serve, build-web, projects, approve, verify, …

# The Python SDK and its CLI
python3 -m venv .venv
.venv/bin/pip install -e 'sdks/python[mcp]'
.venv/bin/autophys --help                   # pair, whoami, bench, research, mcp, …
\`\`\`

The examples below use \`./target/release/autophys\` for the daemon and \`.venv/bin/autophys\` for the Python CLI. If \`CARGO_TARGET_DIR\` is set, the daemon binary is under that directory instead of \`./target\`.

### Daemon CLI

\`\`\`sh
./target/release/autophys serve --collection ./autophys-demo   # open http://127.0.0.1:4794
\`\`\`

\`serve\` keeps running. In another terminal, run any of these on their own, replacing the investigation and proposal IDs with ones from your workbook:

\`\`\`sh
D=./target/release/autophys
$D investigations --target ./autophys-demo
$D records inv_fe6a6d95a665b172 --target ./autophys-demo --kind proposal --json
$D approve inv_fe6a6d95a665b172 prop_bd8b605925d9 --target ./autophys-demo --by james
$D verify --target ./autophys-demo --json
\`\`\`

\`--help\` lists the commands, \`--help --json\` prints the command tree as JSON, and \`--version\` prints the version and build commit. Every command accepts \`--json\`. The exit status is 0 on success, 1 on a failure (including a \`verify\` that finds a problem), and 2 for a usage error.

**Serving and building**

| Command | Options |
| --- | --- |
| \`serve\` | Serve the workbench and \`/api/v1\`. \`--addr\` (default \`127.0.0.1:4794\`, loopback only), \`--web-root DIR\` (a \`build-web\` output), \`--collection DIR\` (alias \`--db\`), \`--server-db FILE\`, \`--browser-origin ORIGIN\` (repeatable or comma-separated). Without \`--web-root\`, a packed binary serves its embedded web app; a plain build builds the app from this checkout (this needs Deno) and rebuilds it when the source changes. |
| \`build-web\` | Build the web app. \`--out DIR\` (default \`web/local.web\` in the app cache, \`~/.cache/tento/autophys/web/local.web\` on Linux), \`--bundle FILE\` (also write a single packed binary). |
| \`pack\` | Write one executable that holds the binary and a built web app. \`--web-root DIR\`, \`--out FILE\`, \`--no-maps\`. |

**Reading and reviewing workbooks**

These commands take \`--target\`: a collection directory, one \`.ap-workbook\` file, or an \`http(s)://\` daemon URL. The default is \`$AUTOPHYS_HOME\`, or \`~/autophys\` when that is unset. URL targets use pairing-key credentials from \`AUTOPHYS_API_KEY\` or \`~/.config/autophys/credentials\`.

| Command | Options |
| --- | --- |
| \`projects\` | List projects. |
| \`investigations\` | List investigations. \`--project NAME\`. |
| \`records INVESTIGATION\` | Print an investigation's records. \`--kind KIND\` filters by record kind. |
| \`approve INVESTIGATION PROPOSAL\` | Approve a proposal. \`--by NAME\` (default \`operator\`), \`--settings JSON\` (edited settings; leave it out to approve unchanged). |
| \`reject INVESTIGATION PROPOSAL\` | Reject a proposal. \`--by NAME\`, \`--reason TEXT\`. |
| \`verify\` | Check each workbook's hash chain and projections. \`--project NAME\`. |

**Administration**

The admin commands work on the daemon's own files. Each takes \`--collection DIR\` (alias \`--db\`) and \`--server-db FILE\`.

| Command | What it does |
| --- | --- |
| \`pair list\`, \`pair approve CODE\`, \`pair deny CODE\` | Review devices waiting to pair (a device starts this with the Python CLI's \`pair\`). |
| \`keys list\`, \`keys revoke KEY_ID\` | List or revoke paired devices' API keys. |
| \`db verify\` (or \`db check\`) | Verify the collection's workbooks. \`--rebuild\` rebuilds the projections, and \`--project NAME\` limits the check. |

**Environment.** \`serve\` also reads these variables; a flag takes precedence over its variable.

| Variable | Flag | Default |
| --- | --- | --- |
| \`AUTOPHYS_ADDR\` | \`--addr\` | \`127.0.0.1:4794\` |
| \`AUTOPHYS_WEB_ROOT\` | \`--web-root\` | embedded app, or a build from source |
| \`AUTOPHYS_HOME\` | \`--collection\` | \`~/autophys\` |
| \`AUTOPHYS_SERVER_DB\` | \`--server-db\` | \`server.db\` in the app's data directory |
| \`AUTOPHYS_BROWSER_ORIGINS\` | \`--browser-origin\` | none (comma-separated) |

### Python CLI

\`\`\`sh
P=.venv/bin/autophys
$P pair --server https://autophys.example.com --name lab-laptop
$P whoami
$P bench --seeds 5 --jobs 4
$P research --output-dir ./research-1 --replay policy.jsonl --researcher-replay researcher.jsonl
$P export-trajectories ./research-1 --output decisions.jsonl
$P mcp --project mypkg.module:project --workbook ~/autophys
\`\`\`

| Command | Options |
| --- | --- |
| \`pair\` | Pair this device with a daemon by device code. The daemon's operator then approves it with \`pair approve\`. \`--server URL\` (default \`$AUTOPHYS_SERVER\`, then the saved server, then \`http://127.0.0.1:4794\`), \`--name\` (the name shown on the approval page). |
| \`whoami\` | Show the account and workspace this device's key belongs to. \`--server\`, \`--json\`. |
| \`bench\` | Run the synthetic benchmark. \`--jobs N\` (default 1), \`--seeds N\` (default 3), \`--case NAME\` (repeatable; default all cases), \`--policy scripted\\|fake-reasoner\\|reason\` (repeatable; default \`scripted\` and \`fake-reasoner\`), \`--json\`. For \`--policy reason\`, \`--model\` is required; \`--route meta\\|baseten\\|lane\`, \`--effort\`, \`--playbook\`, \`--replay FILE\` and \`--record FILE\` configure the model. |
| \`research\` | Improve a playbook. \`--output-dir DIR\` is required and must not exist yet. The defaults are one iteration, one job, the \`reason\` policy and the API researcher. The options are listed below. |
| \`export-trajectories SOURCE\` | Write each recorded reasoner decision in a workbook, collection or research directory as one JSONL line. \`--output FILE\` (a new file; default stdout). |
| \`mcp\` | Serve the calibration tools over MCP stdio. This needs the \`mcp\` extra. \`--project\` (\`battery_ecm\` or \`mypkg.module:project\`), \`--workbook\` (anything \`ap.connect\` accepts), \`--investigation ID\` (resume one), \`--root DIR\` (default the current directory), \`--playbook\`, \`--config FILE\` (default \`.autophys-mcp.json\`). |

**\`research\` options**

- Run: \`--playbook\` (default \`default\`), \`--case\` (repeatable), \`--train-seeds 0,1,2\`, \`--heldout-seeds 3,4\` (the two sets must not overlap), \`--iterations N\` (default 1), \`--jobs N\` (default 1).
- Investigation policy: \`--policy reason|scripted|fake-reasoner\` (default \`reason\`), \`--model\` (default \`muse-spark-1.3\`), \`--route meta|baseten|lane\`, \`--effort\`, \`--replay FILE\`, \`--record FILE\`.
- Researcher: \`--researcher api|muse\` (default \`api\`), \`--researcher-model\` (default \`muse-wonder-1.0\`), \`--researcher-route meta|baseten\`, \`--researcher-effort\`, \`--researcher-replay FILE\`, \`--researcher-record FILE\`. With \`muse\`, also \`--muse-binary\` (default \`muse\`), \`--timeout\` (seconds, default 300) and \`--max-model-steps\`.
- Replays: the policy and the researcher each need their own replay (\`--replay\` and \`--researcher-replay\`) unless live calls are allowed.
- Output: the directory holds \`summary.json\` and \`iterations.json\`, a \`scores.json\` for each evaluation, one workbook per case and seed, and each candidate playbook as \`playbook-NNN.md\` with a matching \`.sha256\` file. The input playbook is never overwritten.

**Environment**

| Variable | What it sets |
| --- | --- |
| \`AUTOPHYS_HOME\` | The collection \`ap.connect()\` opens when it is given no target (default \`~/autophys\`). |
| \`AUTOPHYS_API_KEY\` | The key for \`whoami\` and for a remote \`ap.connect\`. When it is unset, the credentials saved by \`pair\` are used. |
| \`AUTOPHYS_SERVER\` | The daemon \`pair\` and \`whoami\` talk to when \`--server\` is not given; it wins over the saved server. |
| \`AUTOPHYS_ALLOW_LIVE_REASON\` | Set it to \`1\` to let \`bench\` and \`research\` make live model calls. Without it, they need a replay. SDK reasoners you build yourself are not gated. |
| \`AUTOPHYS_REASON_REPLAY\`, \`AUTOPHYS_REASON_RECORD\` | Replay or record the policy model's replies as a JSONL cassette. |
| \`AUTOPHYS_REASON_ROUTE\`, \`AUTOPHYS_REASON_MODEL\` | Configure \`ap.reasoner_from_env()\`. The route is \`meta\` (the default; key in \`MODEL_API_KEY\`), \`baseten\` (key in \`BASETEN_API_KEY\`; set the model too) or \`lane\`. The CLI ignores these; pass \`--route\` and \`--model\` instead. |
| \`AUTOPHYS_REASON_URL\` | Overrides the model endpoint, for the SDK and the CLI alike. The \`lane\` route requires it. |

### Python SDK

\`import autophys as ap\` exports everything below. This script runs as written: it uses a built-in model to stand in for your measurements, and stops when the loop proposes its first experiment.

\`\`\`python
import autophys as ap
from autophys.models import thermal_rc

# Stand-in measurements: the built-in thermal model with C = 500 J/K, R = 2 K/W.
# Replace with your own arrays: t, one array per output channel, and a sigma per channel.
run = thermal_rc({"C": 500.0, "R": 2.0}, "step_short")
step = ap.Observation("step_short", thermal_rc.experiment("step_short"),
                      t=run["t"], y={"T": run["T"]}, sigma={"T": 0.05})

project = ap.Project("thermal-demo", thermal_rc)
# Creates ./autophys-demo/thermal-demo.ap-workbook.
wb = ap.connect("./autophys-demo").project(project)
inv = wb.investigate(ap.Dataset([step]), ap.ProposalRunner(), policy=ap.ScriptedPolicy())
outcome = inv.run()
print(outcome.status, outcome.investigation, outcome.proposal_id)
# awaiting_data inv_… prop_…
\`\`\`

Save it as \`demo.py\` and run \`.venv/bin/python -i demo.py\` from the repository root; \`-i\` keeps \`inv\` available when the script finishes, and the workbook lands in \`./autophys-demo\`. To review it, start \`./target/release/autophys serve --collection ./autophys-demo\` in another terminal and open \`http://127.0.0.1:4794\`, or use the daemon's \`approve\` with \`--target ./autophys-demo\` and the printed IDs. Then call \`inv.wait_for_approval()\`, \`inv.attach_data(outcome.proposal_id, measured)\` and \`inv.run()\` again.

**Connections and workbooks**

| Name | What it is |
| --- | --- |
| \`ap.connect(target=None, *, api_key=None)\` | A \`LocalClient\` for a directory or a \`.ap-workbook\` file, or a \`RemoteClient\` for an \`http(s)://\` daemon URL. |
| \`client.projects()\` | \`[{id, name}]\`, plus \`path\` locally. |
| \`client.project(project)\` | Pass a \`Project\` to create or open its workbook and run investigations. Pass a name to open an existing workbook for listing and verification; a missing one raises \`WorkbookError\` locally, or \`StoreError\` from a daemon. |
| \`wb.investigate(dataset, runner, policy=…)\` | Start a recorded \`Investigation\`. Needs a workbook opened with the \`Project\`. |
| \`wb.investigation(id, runner=None, policy=…)\` | Resume an investigation from its records. Needs the same \`Project\` (simulator and configuration) it was started with. |
| \`wb.investigations()\` | One row per investigation: id, status, budget used, overrides. |
| \`wb.config_versions()\`, \`wb.verify()\` | The stored config versions; the chain and projection check, which returns \`{ok, records, investigations, chain_errors, projections_match}\`. |

**Investigations**

| Name | What it is |
| --- | --- |
| \`inv.run() -> Outcome\` | Run the loop until it stops, a budget runs out, or it proposes an experiment (status \`awaiting_data\`). |
| \`Outcome\` | \`status\`, \`reasons\`, \`estimate\`, \`identified\`, \`non_identified\`, \`non_identifiable_combinations\`, \`investigation\`, \`proposal_id\`, \`summary\`; \`to_dict()\` for JSON. |
| \`inv.wait_for_approval(*, timeout=3600, interval=5) -> dict\` | Block until the pending proposal leaves \`proposed\`, then return its state. Attach data only when \`status\` is \`approved\` or \`edited\`; at \`data_attached\`, another writer has already attached it and the handle picks that up. Raises \`TimeoutError\` when the time runs out. |
| \`inv.attach_data(proposal_id, observation)\` | Attach the measured result of an approved experiment, then call \`inv.run()\` again. |
| \`inv.approve(proposal_id, *, by="user", settings=None)\`, \`inv.reject(proposal_id, *, by="user", reason="")\` | Decide a proposal from code; reviewers normally do this in the workbench. |
| \`inv.records(kind=None)\`, \`inv.proposal(proposal_id)\` | The investigation's records; one proposal's current state. |
| \`ProposalRunner()\` | The runner that turns a requested experiment into a proposal for a person to run. |
| \`ScriptedPolicy()\`, \`ReasonLanePolicy(reasoner, …)\` | A deterministic policy, and one a model drives through a \`Reasoner\`. |

**Models and data**

| Name | What it is |
| --- | --- |
| \`@ap.simulator(params, experiments=None, *, outputs=(), stochastic=False, name=None, display=None)\` | Declare a simulator: parameters as \`name: (unit, low, high)\`, the experiment catalogue, the output channels, and optionally a \`Display\` for the workbench. |
| \`ap.Observation(experiment, settings, t, y, sigma, split="train", source="measured", meta={})\` | One measured run. \`y\` maps each channel to an array shaped like \`t\`, and \`sigma\` gives a positive noise level per channel. \`split\` is \`train\` or \`validation\` (\`test\` is reserved for evaluators). |
| \`ap.Dataset(observations=())\` | The versioned set of observations an investigation fits. |
| \`ap.Project(name, simulator, …)\` | A simulator plus its configuration: \`initial\`, \`fixed\`, \`catalog\` (per-experiment \`max_runs\` and editable settings), \`noise\`, \`budgets\`, \`stop\`, \`policy\`, \`n_starts\`. Each distinct configuration is stored as a content-hashed config version. |
| \`ap.Budgets(…)\` | \`max_steps=24\`, \`max_simulations=20000\`, \`max_experiments=2\`, \`max_outlook_simulations=50000\`, \`max_test_hours=None\`. |
| \`ap.NoiseConfig\`, \`ap.StopRules\`, \`ap.PolicyConfig\` | Noise: declared or estimated sigma, and sensor bias (\`off\`, \`fit\` or \`compare\`). Stop rules: validation and misfit thresholds, and the identifiability rule. Policy: kind, effort and token limit. |
| \`ap.Display\` | How the workbench draws a simulator's channels, inputs and parameters. |
| \`autophys.models\` | Built-in simulators: \`oscillator\`, \`thermal_rc\` and \`battery_ecm\`. |

**Numerics**

| Name | What it is |
| --- | --- |
| \`ap.fit(sim, observations, *, initial=None, n_starts=4, loss="linear", …) -> FitResult\` | Weighted multistart least squares in log/scaled coordinates. |
| \`ap.analyze(sim, params, observations, *, rule=DEFAULT_RULE) -> (SensitivityReport, ndarray)\` | Identifiability from the SVD of the log-Jacobian. It returns the report and the Jacobian: \`report, jac = ap.analyze(...)\`. |
| \`ap.IdentifiabilityRule\`, \`ap.DEFAULT_RULE\` | The thresholds. A direction is unidentified when its singular value is below 1e-3 of the largest, or when its one-sigma uncertainty is worse than about ±10%. |
| \`ap.rank_experiments(sim, params, observations, noise, *, candidates=None, …)\` | Rank catalogue experiments by Fisher information: the minimum eigenvalue by default, or D-optimality. |

**Reasoners and playbooks**

| Name | What it is |
| --- | --- |
| \`ap.reasoner_from_env()\`, \`ap.reasoner_for(spec)\`, \`ap.ModelSpec\` | Build a reasoner from the \`AUTOPHYS_REASON_*\` variables, or from an explicit route, model and effort. |
| \`ap.ChatReasoner\`, \`ap.HttpReasoner\`, \`ap.FakeReasoner\` | Chat completions (Muse or Baseten), a reason-lane endpoint, and a deterministic stand-in for tests. |
| \`ap.RecordingReasoner\`, \`ap.ReplayReasoner\` | Record replies to a cassette, or replay them with no network. |
| \`ap.Playbook\`, \`ap.load_playbook(path_or_name="default")\` | A strategy \`SKILL.md\`, loaded by bundled name or by path. |

### Rust SDK

The crate is \`autophys\` in \`sdks/rust\`. It reads and writes the same \`.ap-workbook\` files as the Python SDK, and the daemon serves each \`/api/v1\` route with one call into it. Its names follow Python's. Where Python takes an optional argument, Rust has two functions: \`project\` and \`project_with\`, \`investigation\` and \`resume\`. Add it with a path relative to your own \`Cargo.toml\`:

\`\`\`toml
[dependencies]
autophys = { path = "../autophys/sdks/rust" }
\`\`\`

This program runs as written and does what the Python script above does:

\`\`\`rust
use autophys::agent::{ProposalRunner, ScriptedPolicy};
use autophys::data::{Dataset, Observation};
use autophys::models;
use autophys::project::Project;
use autophys::simulator::{Simulator, FIT_OPTIONS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sim = models::thermal_rc();
    // Stand-in measurements: the built-in thermal model with C = 500 J/K, R = 2 K/W.
    let truth = [("C".into(), 500.0), ("R".into(), 2.0)].into_iter().collect();
    let settings = sim.experiments()["step_short"].clone();
    let run = sim.simulate(&truth, &settings, FIT_OPTIONS)?;
    let step = Observation::new(
        "step_short",
        settings,
        run["t"].clone(),
        [("T".into(), run["T"].clone())].into_iter().collect(),
        [("T".into(), 0.05)].into_iter().collect(),
    )?;

    let client = autophys::connect(Some("./autophys-demo"))?;
    let wb = client.project_with(Project::new("thermal-demo", sim))?;
    let dataset = Dataset::new([step])?;
    let mut inv = wb.investigate(dataset, ProposalRunner, ScriptedPolicy::default())?;
    let outcome = inv.run()?;
    println!("{} {} {:?}", outcome.status, inv.id, outcome.proposal_id);
    Ok(())
}
\`\`\`

Reviewing needs no simulator. Open a workbook by name and work with the records; the IDs here come from an earlier run:

\`\`\`rust
let client = autophys::connect(Some("./autophys-demo"))?;
let wb = client.project("thermal-demo")?;
for row in wb.investigations()? {
    println!("{} {}", row.id, row.status);
}
wb.investigation("inv_0017968045745e3a")?.approve("prop_e055775d9f66", "james", None)?;
\`\`\`

**Collections and workbooks**

| Name | What it is |
| --- | --- |
| \`autophys::connect(target: Option<&str>) -> Result<Client>\` | A collection directory, one \`.ap-workbook\` file, or an \`http(s)://\` daemon URL; \`None\` means \`$AUTOPHYS_HOME\`, or \`~/autophys\`. URL targets use the same Workbook/Investigation API with pairing-key authentication. |
| \`client.projects()\`, \`client.workbooks()\`, \`client.project(name)\` | List projects; open every workbook; open a workbook by name, creating it if it is missing. |
| \`client.find_investigation(id)\`, \`client.investigations_in(project: Option<&str>)\` | Find an investigation anywhere in the collection; list investigations, optionally in one project. |
| \`client.project_with(Project) -> Result<ProjectWorkbook>\` | Open a workbook with its simulator attached, storing the config version. |
| \`wb.investigations()\`, \`wb.proposals()\` | Projection rows, and every proposal's current state. |
| \`wb.config_versions()\`, \`wb.put_config_version(v, body)\` | Read and store config versions. |
| \`wb.verify() -> Result<VerifyReport>\`, \`wb.rebuild_projections()\` | The chain and projection check, with the same five fields as Python's. |

**Record handles** (\`autophys::Investigation\`, from \`wb.investigation(id)\` or \`client.find_investigation(id)\`)

| Name | What it is |
| --- | --- |
| \`records(kind: Option<&str>)\`, \`records_after(gseq)\`, \`proposal(pid)\` | Records, the records after a cursor (for streaming), and one proposal. |
| \`approve(pid, by, settings: Option<Value>)\`, \`reject(pid, by, reason)\` | Decide a proposal. |
| \`wait_for_approval(pid, timeout: Duration) -> Result<Proposal>\` | Block until the proposal is decided. |
| \`attach_data(pid, observation: serde_json::Value) -> Result<Appended>\` | Attach measured data as JSON. |
| \`append(kind, payload, id)\` | Append one validated record. This is the record writer, not \`run\`. |

**Running loops** (\`autophys::agent::Investigation\`, from \`ProjectWorkbook::investigate\` or \`::resume(id, runner, policy)\`)

| Name | What it is |
| --- | --- |
| \`run() -> Result<Outcome>\` | Run the loop. \`Outcome\` has the same fields as Python's. |
| \`wait_for_approval(timeout: Duration) -> Result<Proposal>\` | Wait for the pending proposal. |
| \`attach_data(pid, observation: data::Observation) -> Result<Appended>\` | Attach the measured result, then \`run()\` again. |
| \`approve(…)\`, \`reject(pid, by, reason)\` | Decide a proposal from code. |

The modules \`simulator\`, \`models\`, \`data\`, \`fit\`, \`sensitivity\`, \`design\`, \`project\`, \`agent\`, \`reasoner\` and \`playbook\` port the Python numerics and loop. Python is the reference for numerical behaviour: Rust must match its results within each conformance case's tolerance and make the same decisions.
`;

/** std-documentation sizes type with Lona's cap-height scale, which tento apps get from
 * theme-base.css's :root block. That sheet also styles bare h1-h7, buttons and labels, which
 * would restyle the cookbook, so only its tokens are carried here, scoped to this section, and
 * the colours resolve to the cookbook's. The syntax colours here are Nord's accents, darkened to
 * read on light inline chips; code blocks are dark (Nord, NORD_CODE below). */
const TOKENS = `
  --text-8px: 0.5rem; --text-9px: 0.5625rem; --text-10px: 0.625rem; --text-11px: 0.6875rem;
  --text-12px: 0.75rem; --text-13px: 0.8125rem; --text-14px: 0.875rem; --text-15px: 0.9375rem;
  --text-16px: 1rem; --text-18px: 1.125rem; --text-20px: 1.25rem; --text-22px: 1.375rem;
  --text-24px: 1.5rem; --text-28px: 1.75rem; --text-32px: 2rem;
  --h1-size: var(--text-18px); --h2-size: var(--text-16px); --h3-size: var(--text-14px);
  --h4-size: var(--text-12px); --h5-size: var(--text-12px); --h6-size: var(--text-12px);
  --p-size: var(--text-10px); --caption-size: var(--text-9px); --small-size: var(--text-9px);
  --cap-height: 0.125; --baseline: 0.155;
  --font-size: var(--p-size); --line-height-ratio: 1.4;
  --text-pri: var(--ck-ink, #141414); --text-sec: var(--ck-secondary, #424242); --text-ter: var(--ck-n600, #5c5c5c);
  --divider: var(--ck-line, #d9d9d9); --bg: #fff; --bg-surface: var(--ck-n100, #f7f7f7); --code-bg: var(--ck-n100, #f7f7f7);
  font-family: var(--ck-font, system-ui, sans-serif); color: var(--text-pri);
  --fg-syntax-keyword: #4c6a92; --fg-syntax-function: #2b6f7d; --fg-syntax-string: #4b7037;
  --fg-syntax-number: #855380; --fg-syntax-comment: #646d80; --fg-syntax-punctuation: #2e3440;
  --fg-syntax-operator: #4c6a92; --fg-syntax-variable: #2e3440;
`;

/** Code is dark on the white page: Nord's palette (polar night nord0 background, snow
 * storm text, frost and aurora accents), set on each block's host (Code reads --code-bg,
 * --text-pri and the --fg-syntax-* roles there). Comments use #8590a6, a brighter nord3 than
 * the #616e88 of Nord's editor ports, which is too faint at this size. */
const NORD_CODE: Record<string, string> = {
  "--code-bg": "#2e3440", "--text-pri": "#d8dee9",
  "--fg-syntax-keyword": "#81a1c1", "--fg-syntax-function": "#88c0d0",
  "--fg-syntax-string": "#a3be8c", "--fg-syntax-number": "#b48ead",
  "--fg-syntax-comment": "#8590a6", "--fg-syntax-punctuation": "#eceff4",
  "--fg-syntax-operator": "#81a1c1", "--fg-syntax-variable": "#d8dee9",
};

/** Inside std-documentation's shadow root. A signature in a table's first column is one card
 * with a hanging indent instead of a chip sliced across lines, and inline code keeps colour
 * only for names and strings: punctuation, operators and literals read as text at this size.
 * Code blocks keep their full colouring (they are std-code, with their own styles). */
const INLINE_CODE_CSS = `
  td:first-child code {
    display: inline-block;
    white-space: pre-wrap;
    overflow-wrap: normal;
    padding: 3px 6px 3px 2.6ch;
    text-indent: -2ch;
    line-height: 1.5;
  }
  code .tok-punctuation, code .tok-operator, code .tok-number { color: inherit; }
`;

const CSS = `
.ap-landing-docs { ${TOKENS} padding: 96px 20px 112px; background: #fff; border-top: 1px solid var(--ck-line, #d9d9d9); }
@media (min-width: 640px) { .ap-landing-docs { padding-inline: 24px; } }
.ap-landing-docs > std-documentation { display: block; margin: 0 auto; max-width: 800px; }
`;

Code.registerLanguage(["sh", "bash", "shell", "zsh", "console"], shellTokenizer);
Code.registerLanguage(["python", "py"], pythonTokenizer);
Code.registerLanguage(["rust", "rs"], rustTokenizer);
Code.registerLanguage(["toml"], tomlTokenizer);
// Inline code picks shell, Python, Rust or plain per span (inline-code.ts).
Code.registerLanguage(["autophys-inline"], inlineCodeTokenizer);

/** std-documentation's code block view, drawing with Code's static, tokenizer-coloured path. */
class StaticCodeBlockView {
  dom: Code;
  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = Code.make();
    // Code scrolls wide lines on its host with the platform's scrollbar, which on Linux and
    // Windows is a full-width grey bar with arrow buttons. A thin, faint one suits the page.
    // Inline, because the host sits in std-documentation's shadow root, beyond this sheet.
    this.dom.style.scrollbarWidth = "thin";
    this.dom.style.scrollbarColor = "rgb(255 255 255 / 0.22) transparent";
    for (const [name, value] of Object.entries(NORD_CODE)) this.dom.style.setProperty(name, value);
    this.draw(node);
  }
  private draw(node: ProseMirrorEditor.ProseMirrorNode): void {
    void this.dom.bind({ content: node.textContent, language: node.attrs.params || "plain", rendering: "static" });
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "code_block") return false;
    this.draw(node);
    return true;
  }
  stopEvent(): boolean {
    return true;
  }
  ignoreMutation(): boolean {
    return true;
  }
}

/** Documentation's default views (lisp examples, code blocks), with code blocks drawn statically
 * and review-* fences drawn by tento-ui's ReviewFence. */
const NODE_VIEWS: Documentation.Props["nodeViews"] = {
  lisp_example: (node) => new LispExampleView(node),
  // review-flow (and other review-*) fences draw as diagrams; any other fence stays code.
  code_block: (node) =>
    node.attrs.params === LOOPS_FENCE
      ? new LoopsFigureView(node)
      : ReviewFence.dispatch(node, null) ?? new StaticCodeBlockView(node),
};

/** Keep the closed landing's docs out of rendering, focus and accessibility while
 * preserving their exact layout height for the drawer's scroll restoration.
 * Toggling inherited inert on this large shadow tree restyled thousands of nodes.
 * content-visibility hides the contents without propagating an inherited change.
 */
export function landingDocs(): { onStage(stage: Cookbook.Stage): void; mount(): void } {
  const section = document.createElement("section");
  section.id = "docs";
  section.className = "ap-landing-docs";
  section.setAttribute("aria-label", "Documentation");
  return {
    onStage(stage) {
      if (stage !== "landing") {
        if (section.style.contentVisibility !== "hidden") {
          const css = getComputedStyle(section);
          const contentHeight = section.getBoundingClientRect().height
            - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
            - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth);
          section.style.containIntrinsicBlockSize = `${Math.max(0, contentHeight)}px`;
          section.style.contentVisibility = "hidden";
        }
      } else section.style.contentVisibility = "visible";
    },
    mount() {
      if (!InstanceUrl.hasStaticBase()) InstanceUrl.setStaticBase("");
      const style = document.createElement("style");
      style.textContent = CSS + MUSE_PEEK_CSS;
      document.head.append(style);
      const doc = Documentation.make();
      const inlineCode = new CSSStyleSheet();
      inlineCode.replaceSync(INLINE_CODE_CSS);
      doc.addStyle("ap-inline-code", inlineCode);
      section.append(doc);
      const footer = document.querySelector(".ck-footer");
      if (footer) footer.before(section);
      else document.body.append(section);
      void doc.bind({ markdown: DOCS_MARKDOWN, nodeViews: NODE_VIEWS, inlineCodeLanguage: "autophys-inline" }).then(() => {
        // A fresh /#docs load can reach the anchor while the section is still
        // empty, clamping the scroll to the short document's temporary end.
        if (location.hash === "#docs" && document.documentElement.dataset.ckStage === "landing") {
          section.scrollIntoView({ block: "start", behavior: "instant" });
        }
      });
      museSectionPeek(section, doc);
    },
  };
}
