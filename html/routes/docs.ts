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

Two programs are called \`autophys\`. The **daemon** is the Rust binary built from \`src/\`: it serves this workbench and its \`/api/v1\` endpoints, and administers device keys and workbooks. The **Python CLI** is the console script the Python SDK installs (\`autophys.cli:main\`): it pairs a device, runs benchmarks and research, and serves the Muse Code tools. Run the one you mean by path when both are installed.

### Daemon CLI

\`autophys --help\` lists the commands, \`autophys --help --json\` prints the command tree as JSON, and \`autophys --version\` prints the version and build commit. Every command accepts \`--json\` to print its result as JSON. Exit status is 0 on success, 1 on a failure (including a failed \`verify\`), and 2 for a usage error.

\`\`\`sh
autophys serve --collection ~/autophys --browser-origin http://localhost:5173
autophys investigations --target ~/autophys --project heated-block
autophys approve inv-7 p-3 --by james --settings '{"freq": 0.5}'
autophys verify --target ~/autophys/heated-block.ap-workbook --json
\`\`\`

| Command | Options |
| --- | --- |
| \`serve\` | Serve the workbench and \`/api/v1\`. \`--addr\` (default \`127.0.0.1:4794\`; loopback only), \`--web-root DIR\` (a \`build-web\` tree; default bundles from source), \`--collection DIR\` (alias \`--db\`), \`--server-db FILE\`, \`--browser-origin ORIGIN\` (repeatable or comma-separated). |
| \`build-web\` | Build the web app. \`--out DIR\`, \`--bundle FILE\` (also pack a single native file). |
| \`pack\` | Pack the binary and a built tree into one file. \`--web-root DIR\`, \`--out FILE\`, \`--no-maps\`. |
| \`projects\` | List projects. \`--target\`. |
| \`investigations\` | List investigations. \`--target\`, \`--project NAME\`. |
| \`records INVESTIGATION\` | Print an investigation's records. \`--target\`, \`--kind KIND\`. |
| \`approve INVESTIGATION PROPOSAL\` | Approve a proposal. \`--target\`, \`--by NAME\` (default \`operator\`), \`--settings JSON\` (edited settings; omit to approve unchanged). |
| \`reject INVESTIGATION PROPOSAL\` | Reject a proposal. \`--target\`, \`--by NAME\`, \`--reason TEXT\`. |
| \`verify\` | Check each workbook's hash chain and projections. \`--target\`, \`--project NAME\`. |

\`--target\` is a collection directory or one \`.ap-workbook\` file, defaulting to \`$AUTOPHYS_HOME\` or \`~/autophys\`. These commands read files through the Rust SDK, which does not open daemon URLs yet.

The admin commands work on the daemon's own files. Each takes \`--collection DIR\` (alias \`--db\`) and \`--server-db FILE\`.

| Command | What it does |
| --- | --- |
| \`pair list\`, \`pair approve CODE\`, \`pair deny CODE\` | Review devices waiting to pair (see the Python CLI's \`pair\`). |
| \`keys list\`, \`keys revoke KEY_ID\` | List or revoke paired devices' API keys. |
| \`db verify\` (or \`db check\`) | Verify the collection's workbooks. \`--rebuild\` rebuilds the projections, \`--project NAME\` limits the check. |

\`serve\` reads its settings from the environment too; a flag wins over its variable.

| Variable | Flag | Default |
| --- | --- | --- |
| \`AUTOPHYS_ADDR\` | \`--addr\` | \`127.0.0.1:4794\` |
| \`AUTOPHYS_WEB_ROOT\` | \`--web-root\` | bundle from source |
| \`AUTOPHYS_HOME\` | \`--collection\` | \`~/autophys\` |
| \`AUTOPHYS_SERVER_DB\` | \`--server-db\` | \`server.db\` in the app's data directory |
| \`AUTOPHYS_BROWSER_ORIGINS\` | \`--browser-origin\` | none (comma-separated) |

### Python CLI

Installed with the SDK (\`pip install -e sdks/python\`), or run from a checkout as \`python -m autophys.cli\`.

| Command | Options |
| --- | --- |
| \`pair\` | Pair this device with a daemon by device code; the daemon's operator approves it. \`--server URL\` (default \`$AUTOPHYS_SERVER\`, the saved server, or \`http://127.0.0.1:4794\`), \`--name\` (shown on the approval page). |
| \`whoami\` | Show the account and workspace this device's key belongs to. \`--server\`, \`--json\`. |
| \`bench\` | Run the synthetic benchmark. \`--jobs N\` (default 1), \`--seeds N\` (default 3), \`--case NAME\` (repeatable; default all), \`--policy scripted\\|fake-reasoner\\|reason\` (repeatable; default scripted and fake-reasoner), \`--model\`, \`--route meta\\|baseten\\|lane\`, \`--effort\`, \`--playbook\`, \`--replay FILE\`, \`--record FILE\`, \`--json\`. |
| \`research\` | Improve a playbook (see How the loops nest). \`--output-dir DIR\` (required, new), \`--playbook\` (default \`default\`), \`--case\`, \`--train-seeds 0,1,2\`, \`--heldout-seeds 3,4\`, \`--iterations N\`, \`--jobs N\`, \`--policy\`, \`--model\` (default \`muse-spark-1.3\`), \`--route\`, \`--effort\`, \`--replay\`, \`--record\`; the researcher's \`--researcher api\\|muse\`, \`--researcher-model\` (default \`muse-wonder-1.0\`), \`--researcher-route\`, \`--researcher-effort\`, \`--researcher-replay\`, \`--researcher-record\`; for \`muse\`, \`--muse-binary\`, \`--timeout\` (seconds, default 300) and \`--max-model-steps\`. |
| \`export-trajectories SOURCE\` | Write each recorded reasoner decision in a workbook, collection or research directory as one JSONL line. \`--output FILE\` (a new file; default stdout). |
| \`mcp\` | Serve the calibration tools over MCP stdio (needs \`autophys[mcp]\`). \`--project\` (\`battery_ecm\` or \`mypkg.module:project\`), \`--workbook\` (as \`ap.connect\`), \`--investigation ID\` (resume), \`--root DIR\` (default cwd), \`--playbook\`, \`--config FILE\` (default \`.autophys-mcp.json\`). |

| Variable | What it sets |
| --- | --- |
| \`AUTOPHYS_HOME\` | The default collection for \`ap.connect()\` (\`~/autophys\`). |
| \`AUTOPHYS_SERVER\` | The daemon \`pair\` and \`whoami\` talk to. |
| \`AUTOPHYS_API_KEY\` | The key for \`whoami\` and a remote \`ap.connect\`; otherwise the credentials \`pair\` saved. |
| \`AUTOPHYS_ALLOW_LIVE_REASON\` | \`1\` allows live model calls; without it, \`reason\` policies and researchers need a replay. |
| \`AUTOPHYS_REASON_ROUTE\` | \`meta\` (default; \`MODEL_API_KEY\`), \`baseten\` (\`BASETEN_API_KEY\`; needs \`AUTOPHYS_REASON_MODEL\`) or \`lane\` (\`AUTOPHYS_REASON_URL\`). |
| \`AUTOPHYS_REASON_MODEL\`, \`AUTOPHYS_REASON_URL\` | Override the route's model and endpoint. |
| \`AUTOPHYS_REASON_REPLAY\`, \`AUTOPHYS_REASON_RECORD\` | Replay or record model replies in a JSONL cassette. |

### Python SDK

\`import autophys as ap\` exports everything below. Each table is one area of the package.

**Connections and workbooks**

| Name | What it is |
| --- | --- |
| \`ap.connect(target=None, *, api_key=None)\` | Returns a \`LocalClient\` for a directory or \`.ap-workbook\` file, or a \`RemoteClient\` for an \`http(s)://\` daemon URL. |
| \`client.projects()\` | \`[{id, name}]\`, plus \`path\` locally. |
| \`client.project(project)\` | The project's \`Workbook\`, created if new. Pass a \`Project\` to run investigations, or a name to read and review only. |
| \`wb.investigate(dataset, runner, **kw)\` | Start a recorded \`Investigation\` (\`policy=\` picks the policy). |
| \`wb.investigations()\` | One row per investigation: id, status, budget used, overrides. |
| \`wb.investigation(id, runner=None, **kw)\` | Resume an investigation from its records. |
| \`wb.config_versions()\`, \`wb.verify()\` | The stored config versions; a chain and projection check returning \`{ok, records, investigations, chain_errors, projections_match}\`. |
| \`WorkbookStore\`, \`MemoryStore\`, \`JsonlStore\` | The record stores underneath: the workbook file, and two for tests. |

**Investigations**

| Name | What it is |
| --- | --- |
| \`inv.run()\` | Run the loop until it stops, a budget runs out, or it proposes an experiment (\`awaiting_data\`). Returns an \`Outcome\`. |
| \`inv.records(kind=None)\`, \`inv.proposal(proposal_id)\` | The investigation's records; a proposal's current state. |
| \`inv.approve(proposal_id, *, by="user", settings=None)\` | Approve a proposal, optionally with edited settings. |
| \`inv.reject(proposal_id, *, by="user", reason="")\` | Reject a proposal. |
| \`inv.wait_for_approval(*, timeout=3600, interval=5)\` | Block until a reviewer decides. |
| \`inv.attach_data(proposal_id, observation)\` | Attach the measured result of an approved experiment. |
| \`ProposalRunner\` | The runner that turns \`request_experiment\` into a proposal for a person to run. |
| \`ScriptedPolicy\`, \`ReasonLanePolicy\` | A deterministic policy, and one driven by a model through a \`Reasoner\`. |
| \`Decision\`, \`ACTIONS\`, \`DECISION_SCHEMA\`, \`render_facts\` | A policy's structured decision, the allowed actions and their JSON schema, and the facts text a model sees. |

**Models and data**

| Name | What it is |
| --- | --- |
| \`@ap.simulator(params, experiments=None, *, outputs=(), stochastic=False, name=None)\` | Declare a simulator: parameters as \`name: (unit, low, high)\`, the experiment catalogue and output channels. |
| \`Simulator\`, \`ParamSpec\`, \`SimOptions\`, \`FIT_OPTIONS\`, \`TRUTH_OPTIONS\` | The simulator contract, a parameter's schema, and solver tolerances for fitting and for generating synthetic truth. |
| \`Display\` | How the workbench draws a simulator's channels, inputs and parameters; attach with \`display=\` or \`Simulator.with_display()\`. |
| \`Project(name, simulator, …)\` | A simulator plus its configuration: \`initial\`, \`fixed\`, \`catalog\` (per-experiment \`max_runs\` and editable settings), \`noise\`, \`budgets\`, \`stop\`, \`policy\`, \`n_starts\`. Each distinct configuration is stored as a content-hashed config version. |
| \`Budgets\` | \`max_steps=24\`, \`max_simulations=20000\`, \`max_experiments=2\`, \`max_outlook_simulations=50000\`, \`max_test_hours=None\`. |
| \`NoiseConfig\`, \`StopRules\`, \`PolicyConfig\` | Declared or estimated sigma and sensor bias (\`off\`, \`fit\` or \`compare\`); validation and misfit thresholds and the identifiability rule; policy kind, effort and token limit. |
| \`Observation\`, \`Dataset\` | One measured run (channels, sigma, split), and the versioned set an investigation fits. |
| \`autophys.models\` | Built-in simulators: \`oscillator\`, \`thermal_rc\`, \`battery_ecm\`. |

**Numerics**

| Name | What it is |
| --- | --- |
| \`ap.fit(sim, observations, *, initial=None, n_starts=4, loss="linear", …)\` | Weighted multistart least squares in log/scaled coordinates. Returns a \`FitResult\`. |
| \`ap.analyze(sim, params, observations, *, rule=DEFAULT_RULE, …)\` | Identifiability from the SVD of the log-Jacobian. Returns a \`SensitivityReport\`. |
| \`IdentifiabilityRule\`, \`DEFAULT_RULE\` | The thresholds: a direction is unidentified when its singular value is below 1e-3 of the largest, or its one-sigma uncertainty is worse than about ±10%. |
| \`ap.rank_experiments(sim, params, observations, noise, *, candidates=None, …)\` | Rank catalogue experiments by Fisher information (minimum eigenvalue by default, or D-optimality). |

**Reasoners and playbooks**

| Name | What it is |
| --- | --- |
| \`reasoner_from_env()\`, \`reasoner_for(spec)\`, \`ModelSpec\` | Build a reasoner from the \`AUTOPHYS_REASON_*\` variables or an explicit route, model and effort. |
| \`ChatReasoner\`, \`HttpReasoner\`, \`FakeReasoner\` | Chat completions (Muse or Baseten), a reason-lane endpoint, and a deterministic stand-in for tests. |
| \`RecordingReasoner\`, \`ReplayReasoner\` | Record replies to a cassette, or replay them with no network. |
| \`MUSE_SPARK\`, \`MUSE_WONDER\`, \`BudgetError\` | Model names for the policy and the researcher; the error raised when a spend budget is exhausted. |
| \`Playbook\`, \`load_playbook(path_or_name="default")\` | A strategy \`SKILL.md\`, by bundled name or path. |

### Rust SDK

The crate is \`autophys\` in \`sdks/rust\`. It reads and writes the same \`.ap-workbook\` files as the Python SDK, and the daemon serves each \`/api/v1\` route with one call into it. Its names follow Python's; where Python takes an optional argument, Rust has two functions (\`project\` and \`project_with\`, \`investigation\` and \`resume\`).

\`\`\`toml
[dependencies]
autophys = { path = "sdks/rust" }
\`\`\`

\`\`\`rust
let client = autophys::connect(Some("~/autophys"))?;
let wb = client.project("heated-block")?;            // review only
for inv in wb.investigations()? {
    println!("{} {}", inv.id, inv.status);
}
wb.investigation("inv-7")?.approve("p-3", "james", None)?;
\`\`\`

\`\`\`rust
use autophys::{agent::{ProposalRunner, ScriptedPolicy}, models, project::Project};

let wb = client.project_with(Project::new("thermal", models::thermal_rc()))?;
let mut inv = wb.investigate(dataset, ProposalRunner, ScriptedPolicy::default())?;
let outcome = inv.run()?;                             // "awaiting_data" at a proposal
\`\`\`

| Name | What it is |
| --- | --- |
| \`autophys::connect(target: Option<&str>) -> Result<Client>\` | A collection directory or one \`.ap-workbook\` file; \`None\` means \`$AUTOPHYS_HOME\` or \`~/autophys\`. Daemon URLs return \`Error::Unsupported\` for now. |
| \`client.projects()\`, \`client.workbooks()\`, \`client.project(name)\` | List projects; open every workbook; open or create one by name. |
| \`client.find_investigation(id)\`, \`client.investigations_in(project)\` | Find an investigation across the collection; list investigations, optionally in one project. |
| \`client.project_with(Project) -> ProjectWorkbook\` | Open a workbook with its simulator attached, storing the config version. |
| \`wb.investigations()\`, \`wb.investigation(id)\`, \`wb.proposals()\` | Projection rows; one investigation's records; every proposal's folded state. |
| \`wb.config_versions()\`, \`wb.put_config_version(v, body)\` | Read and store config versions. |
| \`wb.verify() -> VerifyReport\`, \`wb.rebuild_projections()\` | The chain and projection check, with the same five fields as Python's. |
| \`inv.records(kind)\`, \`inv.records_after(gseq)\`, \`inv.proposal(pid)\` | Records, records after a cursor (for streaming), and one proposal. |
| \`inv.approve(pid, by, settings)\`, \`inv.reject(pid, by, reason)\`, \`inv.attach_data(pid, observation)\` | The proposal verbs. |
| \`inv.wait_for_approval(pid, timeout: Duration)\` | Block until the proposal is decided. |
| \`inv.append(kind, payload, id)\` | Append one validated record; the record writer, never \`run\`. |
| \`ProjectWorkbook::investigate(dataset, runner, policy)\`, \`::resume(id, runner, policy)\` | Start or resume the investigation loop; \`agent::Investigation::run()\` returns an \`Outcome\`. |
| Modules \`simulator\`, \`models\`, \`data\`, \`fit\`, \`sensitivity\`, \`design\`, \`project\`, \`agent\`, \`reasoner\`, \`playbook\` | Ports of the Python numerics and loop. Python is the reference for numerical behaviour; Rust must match its results within each conformance case's tolerance and make the same decisions. |
`;

/** std-documentation sizes type with Lona's cap-height scale, which tento apps get from
 * theme-base.css's :root block. That sheet also styles bare h1-h7, buttons and labels, which
 * would restyle the cookbook, so only its tokens are carried here, scoped to this section, and
 * the colours resolve to the cookbook's. Code colours are tento-ui's light syntax palette
 * (brand/tokens/color/loaf.ts), which Lona apps otherwise get from colors.css. */
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
  --fg-syntax-keyword: #a626a4; --fg-syntax-function: #4078f2; --fg-syntax-string: #50a14f;
  --fg-syntax-number: #986801; --fg-syntax-comment: #a0a1a7; --fg-syntax-punctuation: #696c77;
  --fg-syntax-operator: #0184bc; --fg-syntax-variable: #383a42;
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

/** std-documentation's code block view, drawing with Code's static, tokenizer-coloured path. */
class StaticCodeBlockView {
  dom: Code;
  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = Code.make();
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

/** The docs section and the shell hook that keeps it out of the open app's tab order. inert,
 * not hidden: onStage runs after the drawer restores the landing's scroll offset, and removing
 * the section from layout first would clamp an offset inside it. */
export function landingDocs(): { onStage(stage: Cookbook.Stage): void; mount(): void } {
  const section = document.createElement("section");
  section.className = "ap-landing-docs";
  section.setAttribute("aria-label", "Documentation");
  return {
    onStage(stage) {
      section.inert = stage !== "landing";
    },
    mount() {
      if (!InstanceUrl.hasStaticBase()) InstanceUrl.setStaticBase("");
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.append(style);
      const doc = Documentation.make();
      section.append(doc);
      const footer = document.querySelector(".ck-footer");
      if (footer) footer.before(section);
      else document.body.append(section);
      void doc.bind({ markdown: DOCS_MARKDOWN, nodeViews: NODE_VIEWS });
    },
  };
}
