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

By default, a parameter counts as **identified** when the data determines it to within about ±10% at one standard deviation, and it is not tied to an unresolved combination of other parameters. That verdict comes from a sensitivity analysis (an SVD of the noise-weighted Jacobian in log coordinates), not from how good the fit looks.

When parameters are tied together, autophys ranks the candidate experiments by Fisher information and proposes the one that would separate them. An agent (Muse Spark, or a scripted policy) can drive that loop, and a person approves each experiment in this workbench before it runs.

## Quick start: fit a battery cell

You need the \`autophys\` command, Python 3.10 or newer and git. This local fit needs no account or API key.

\`\`\`sh
autophys new my-cell --lang python    # the battery-fit template, with its own .venv
cd my-cell
.venv/bin/python battery_fit.py data/demo.csv     # fits the bundled demo cell, writes fit.png
.venv/bin/python battery_fit.py my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
\`\`\`

The project's README covers inputs, sample data, expected output and how to read the result, including the R1 ↔ C1 trade-off that a single pulse leaves unresolved. \`--lang rust\` creates the same fit in Rust, and \`--example blank\` a minimal project. Recording on a remote daemon needs this device connected once with \`autophys connect URL\` (\`autophys whoami\` shows the account), a daemon started with \`serve --login\` needs a browser sign-in, and live model calls need your own provider access.

## The closed loop

1. Fit the model to the measurements you have.
2. Check identifiability: each parameter is either identified or tied to others.
3. Rank the catalogue experiments by how well they would separate the tied parameters.
4. The agent proposes one, with its rationale and expected information.
5. You approve, edit or reject it here in the workbench.
6. The new data is attached to the proposal, and the loop fits again.

A proposal starts as \`proposed\`. A reviewer approves it unchanged (\`approved\`), approves it with edited settings (\`edited\`) or rejects it (\`rejected\`); the SDK can also withdraw it (\`withdrawn\`). Only an approved or edited proposal can move on to \`data_attached\`. The final report's identified list is always recomputed and checked in code; the agent cannot assert it.

## Python SDK

Wrap your simulator with \`@ap.simulator\`, describe the project and its budgets, and run an investigation. It stops at \`awaiting_data\` at the first proposal; any later process can resume it from the records. This is a sketch: fill in the simulator and supply your measurements as an \`ap.Dataset\`. The examples further down run as written.

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

# later, in any process, with the same Project:
inv = ap.connect("~/autophys").project(project).investigation(outcome.investigation)
state = inv.wait_for_approval()  # your approve/edit in the workbench lands in the workbook
inv.attach_data(outcome.proposal_id, observation)  # run state["settings"] on your rig first
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

Each project lives in one workbook, \`<project>.ap-workbook\`, a SQLite file. Records are appended to a hash-chained log. The SDKs and the daemon enforce the same validation and proposal rules, so the SDK, a second process and this workbench can all work with the same workbook; local SDK use needs no daemon. The Rust and Python SDKs implement the same format.

## Muse Code plugin

The plugin lets Muse drive the calibration through a local MCP server, \`autophys mcp\`, while the numerical work stays in the SDK. Build a bundle configured for your project, then install it. From the repository root:

\`\`\`sh
cargo build --release --bin autophys
python3 plugins/muse-autophys/build.py \\
  --output "$HOME/.cache/autophys-muse-plugin" \\
  --autophys "$PWD/target/release/autophys" \\
  --project battery_ecm --workbook "$HOME/autophys" --root "$PWD"
muse plugins install "$HOME/.cache/autophys-muse-plugin"
\`\`\`

The server is part of the \`autophys\` binary and serves the built-in \`battery_ecm\` project; it cannot import a Python simulator, so a \`mypkg.module:project\` reference is refused. Set \`--root\` to the directory that holds your measurement CSVs. Muse starts the bundled server itself; running \`autophys mcp\` by hand starts a separate server and does not configure the plugin.

Tools: \`describe_project\`, \`import_measurements\`, \`fit\`, \`identifiability\`, \`rank_experiments\`, \`propose_experiment\`, \`status\`, \`attach_data\` and \`report\`. There is no approve or reject tool: experiments are approved here, in the browser.

## The workbench

Open the workbench from the top of this page. The sidebar lists projects and their investigations; the main pane draws measured data, parameter estimates and sensitivity; the details panel shows the selected record. The workbench reads the daemon's recorded investigation and updates live as records arrive.

The Fit view overlays the recorded initial and fitted model curves on the measurements, with normalized residuals beneath; older records without curves say "fit curve not recorded". New project creates a thermal starter that the daemon runs itself: approving its proposal generates synthetic data from a simulated reference specimen and fits again.

## Repository map

| Path | What it is |
| --- | --- |
| \`templates\` | The projects \`autophys new\` creates: battery-fit (fit a measured battery trace, check identifiability, plot the curve; the closed loop) and blank. |
| \`sdks/python\` | Python SDK: simulator, fit, identifiability, experiment ranking, agent loop, workbook, playbook research, and the MCP server. |
| \`sdks/rust\` | Rust SDK: local and HTTP workbooks, simulators, numerics and the investigation loop. |
| \`plugins/muse-autophys\` | Muse Code bundle: the calibration skill, the \`/calibrate\` command and the bundle builder. The MCP server itself is in \`sdks/python\`. |
| \`src/\`, \`html/\` | The Rust \`autophys\` command (daemon, \`new\`, \`connect\`, workbook verbs) and this browser workbench. |
| \`train/sft\` | Decision datasets, training workers and held-out evaluation for policy training. |
| \`ops\` | Standalone Linux packaging and optional service setup. |
| \`vendor/tento\` | The vendored browser compiler, UI and Rust dependencies this checkout builds with. |
| \`autophys.project.docs\` | Design notes and decisions. |

## How the loops nest

The investigation is the calibration loop. Playbook research runs many investigations to improve the strategy a model policy follows, so the research loop calls the investigation loop; they are nested, not concurrent. Policy training is a separate workflow.

- **Investigation (inner).** One calibration: an agent fits the model, checks identifiability, ranks experiments, requests data and stops. A model policy follows a playbook, a \`SKILL.md\` file; the scripted policy implements the same strategy in code.
- **Research (outer).** \`autophys research\` improves that playbook. It scores a playbook by running complete investigations on synthetic cases with a hidden truth, asks a researcher model for an edit, and keeps the edit only if the score improves. \`autophys autoloop\` repeats this until a stop condition, keeping a journal and resumable state.
- **Policy training.** The daemon's \`train\` commands turn scripted investigation decisions into a dataset, train a model adapter and evaluate it.

Each research step waits for all of its investigations before it decides. The investigations within a step are independent and run on up to \`--jobs\` workers; recording model replies forces them to run one at a time.

\`\`\`autophys-loops
\`\`\`

The score is lexicographic: the number of runs whose status and diagnosis are correct, then the mean log parameter error, then cost. The held-out seeds are kept apart from the start and only used at the end. An edit that fails validation is logged and skipped, and still uses up an iteration.

Inside each evaluation, an investigation is not a fixed cycle. At every step the policy picks one action until it stops or a budget runs out, so the order depends on the policy. The figure shows the scripted policy's usual order. It also compares a sensor-bias variant of the model when the fit is poor.

| Mode | What runs | Where new data comes from |
| --- | --- | --- |
| \`autophys research\` | the outer loop, calling many investigations | a synthetic case's hidden truth, with no person in the loop |
| \`autophys autoloop\` | the outer loop until a stop condition, with a journal and resume | the same synthetic truth |
| \`autophys bench\` | investigations across policies, cases and seeds, with no playbook search | the same synthetic truth |
| SDK or Muse Code | one investigation at a time, on your simulator and measurements | an experiment you approve here and run on your hardware |
| Workbench thermal starter | a scripted investigation that the daemon runs | a simulated reference specimen, when you approve |
| Daemon \`train\` | dataset generation, adapter training and policy evaluation | scripted synthetic trajectories and held-out synthetic cases |

Live model calls are off by default. The \`reason\` policy and the \`api\` and \`muse\` researchers each need a recorded replay, or \`AUTOPHYS_ALLOW_LIVE_REASON=1\`; the \`scripted\` and \`fake-reasoner\` policies and the \`scripted\` and \`heuristic\` researchers run offline. With the defaults (every built-in case, three train seeds and two held-out seeds), a research run evaluates three investigations per case for the baseline and for each valid edit, and four per case on the held-out seeds at the end (two seeds, for the starting and the final playbook).

\`autoloop\` records each edit's hypothesis, diff, scores and decision in a journal, feeds recent history back to the researcher, and can accept an edit by a paired bootstrap test. A planted sensor-bias case, \`battery-biased\`, exercises a playbook fix offline. Not built yet, and under discussion in the design notes: procedurally sampled and misspecified cases, and model discovery, where the agent proposes rival model structures when validation fails.

## Examples

Each example runs as written from the repository root, after the install steps under Reference: the daemon at \`./target/release/autophys\` and the Python SDK in \`.venv\`. Your IDs will differ from the ones shown.

### Run the loop to a validated fit (Python)

The built-in thermal model stands in for your rig: \`measure\` simulates the true specimen. The loop proposes an experiment, the script approves it and "runs" it, and the loop fits again until it stops. The second trace is held out for validation, which a \`validated\` result needs.

\`\`\`python
import autophys as ap
from autophys.models import thermal_rc

truth = {"C": 500.0, "R": 2.0}
def measure(name, settings):
    run = thermal_rc(truth, settings, options=ap.TRUTH_OPTIONS)
    return ap.Observation(name, settings, run["t"], {"T": run["T"]}, {"T": 0.05})

project = ap.Project("thermal-loop", thermal_rc)
with ap.connect("./workbooks") as client:
    wb = client.project(project)
    first = measure("step_short", thermal_rc.experiment("step_short"))
    validation = measure("sine_slow", thermal_rc.experiment("sine_slow"))
    validation.split = "validation"
    inv = wb.investigate(ap.Dataset([first, validation]), ap.ProposalRunner(),
                         policy=ap.ScriptedPolicy())
    out = inv.run()
    while out.status == "awaiting_data":
        print(out.status)
        inv.approve(out.proposal_id)
        approved = inv.wait_for_approval(timeout=1, interval=0.01)
        print(approved["status"], approved["experiment"])
        obs = measure(approved["experiment"], approved["settings"])
        inv.attach_data(out.proposal_id, obs)
        out = inv.run()
    print(out.status)
    print("identified:", ", ".join(out.identified))
    print("estimate:", ", ".join(f"{k}={v:.6g}" for k, v in out.estimate.items()))
\`\`\`

Save it as \`loop.py\` and run \`.venv/bin/python loop.py\`:

\`\`\`text
awaiting_data
approved pulse
validated
identified: C, R
estimate: C=500, R=2
\`\`\`

On real hardware, a person approves in the workbench instead, and \`measure\` is your experiment.

### Review an investigation from the terminal

This records an investigation that stops at its first proposal, then lists it, reads the proposal, approves it and verifies the workbook with the daemon CLI.

\`\`\`sh
D="$PWD/target/release/autophys"; P="$PWD/.venv/bin/python"
mkdir terminal-review && cd terminal-review
"$P" - <<'PY' > ids
import autophys as ap
from autophys.models import thermal_rc as model
r = model({"C": 500., "R": 2.}, "step_short")
obs = ap.Observation("step_short", model.experiment("step_short"), t=r["t"], y={"T": r["T"]}, sigma={"T": .05})
w = ap.connect("./books").project(ap.Project("terminal-demo", model))
o = w.investigate(ap.Dataset([obs]), ap.ProposalRunner(), policy=ap.ScriptedPolicy()).run()
print(o.investigation, o.proposal_id)
PY
read -r INV PROP < ids
"$D" investigations --target ./books
"$D" records "$INV" --target ./books --kind proposal
"$D" approve "$INV" "$PROP" --target ./books --by reviewer
"$D" verify --target ./books
\`\`\`

Approving records the decision. To continue, run the approved experiment and attach its data from the SDK, as in the example above.

### Review and approve from Rust

A Rust program can record the same proposal and approve it through a record handle, which needs no simulator. The repository root is a Cargo workspace, so make the crate beside the checkout. From the repository root:

\`\`\`sh
REPO="$PWD"
cargo new ../rust-review && cd ../rust-review
cargo add autophys --path "$REPO/sdks/rust"
\`\`\`

Replace \`src/main.rs\` with:

\`\`\`rust
use autophys::agent::{ProposalRunner, ScriptedPolicy};
use autophys::data::{Dataset, Observation};
use autophys::models;
use autophys::project::Project;
use autophys::simulator::{Simulator, FIT_OPTIONS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sim = models::thermal_rc();
    // Stand-in measurements: C = 500 J/K, R = 2 K/W.
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

    let client = autophys::connect(Some("./review-demo"))?;
    let wb = client.project_with(Project::new("thermal-demo", sim))?;
    let dataset = Dataset::new([step])?;
    let mut inv = wb.investigate(dataset, ProposalRunner, ScriptedPolicy::default())?;
    let outcome = inv.run()?;
    let pid = outcome.proposal_id.ok_or("expected a proposal")?;
    let id = inv.id.clone();
    drop(inv);

    // A reviewer needs only the workbook and the IDs.
    let reviewer = autophys::connect(Some("./review-demo"))?;
    let record = reviewer.project("thermal-demo")?.investigation(&id)?;
    println!("before: {}", record.proposal(&pid)?.status);
    record.approve(&pid, "reviewer", None)?;
    let p = record.wait_for_approval(&pid, std::time::Duration::from_secs(1))?;
    println!("after: {}", p.status);
    println!("verified: {}", record.workbook().verify()?.ok);
    Ok(())
}
\`\`\`

Then \`cargo run\` prints:

\`\`\`text
before: proposed
after: approved
verified: true
\`\`\`

### Benchmark the policies offline

\`bench\` runs complete investigations on synthetic cases with a known truth, here for the scripted policy and the fake reasoner. It makes no model calls.

\`\`\`sh
./target/release/autophys bench --case thermal --seeds 1 --policy scripted --policy fake-reasoner --json > bench.json
python3 - <<'PY'
import json
for row in json.load(open("bench.json")):
    print(row["case"], row["policy"], row["status"], "requested=" + ",".join(row["requested"]))
PY
\`\`\`

\`\`\`text
thermal scripted validated requested=pulse
thermal fake-reasoner validated requested=pulse
\`\`\`

## Reference

The \`autophys\` command is one Rust binary built from \`src/\`. It sets up projects (\`new\`), connects a device to a daemon (\`connect\`, \`whoami\`), serves this workbench and the \`/api/v1\` endpoints, manages browser accounts, device keys and workbooks, reviews proposals, and drives policy training. It also runs the developer tools on the SDK primitives: \`bench\`, \`research\`, \`autoloop\`, \`export-trajectories\` and \`mcp\`, the Muse plugin's MCP server. The Python and Rust SDKs are libraries and install no command.

Building from source needs Rust (edition 2024) and a C toolchain, and building the browser app needs Deno 2; the Tento sources it uses are vendored in the repository. From the repository root:

\`\`\`sh
# The autophys command (Rust)
cargo build --release --bin autophys
./target/release/autophys --help            # new, connect, serve, users, approve, verify, train, bench, research, …

# The Python SDK, a library for your own programs
python3 -m venv .venv
.venv/bin/pip install -e sdks/python
\`\`\`

The examples below use \`./target/release/autophys\` for the \`autophys\` command. If \`CARGO_TARGET_DIR\` is set, the daemon binary is under that directory instead of \`./target\`. On Linux, \`ops/package.sh --out /absolute/path/to/autophys\` builds and packs one executable that serves its embedded app without Deno or the checkout.

### The autophys command

\`\`\`sh
./target/release/autophys new my-cell --lang python            # a project; see below
./target/release/autophys connect https://autophys.example.com --name lab-laptop
./target/release/autophys whoami
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

\`--help\` lists the commands, \`--help --json\` prints the command tree as JSON, and \`--version\` prints the version and build commit (\`dev\` for an unstamped build). Every command accepts \`--json\`. The exit status is 0 on success, 1 on a failure (including a \`verify\` that finds a problem), and 2 for a usage error.

**Projects and devices**

| Command | Options |
| --- | --- |
| \`new DIR\` | Create a project in a new or empty directory. \`--lang python\|rust\` (required), \`--example battery-fit\|blank\` (default \`battery-fit\`), \`--name NAME\` (default the directory name), \`--no-install\` (Python: skip creating \`.venv\` and installing), \`--sdk-rev REV\` (default the commit this binary was built from), \`--sdk-repo GIT_URL\` (default \`https://github.com/yuzuquats/autophys\`). The project depends on the SDK through a git dependency pinned to that commit. A Python project gets \`.venv\` from \`python3\` (or \`$AUTOPHYS_PYTHON\`). |
| \`connect [URL]\` | Connect this device to a daemon by device code; the daemon's operator approves the printed code in the workbench or with \`pair approve\`. The key is saved to \`credentials\` in \`$AUTOPHYS_CONFIG_DIR\` (default \`~/.config/autophys\`, mode 0600), where both SDKs find it, and is never printed. URL defaults to \`$AUTOPHYS_SERVER\`, then the saved server, then \`http://127.0.0.1:4794\`. \`--name\` is the name shown on the approval page (default the hostname). |
| \`whoami\` | Show the account, workspace and device the key belongs to. \`--server URL\` (same order as \`connect\`). The key comes from \`$AUTOPHYS_API_KEY\` or the saved credentials. |

**Serving and building**

| Command | Options |
| --- | --- |
| \`serve\` | Serve the workbench and \`/api/v1\`. \`--addr\` (default \`127.0.0.1:4794\`, loopback only), \`--web-root DIR\` (a \`build-web\` output), \`--collection DIR\` (alias \`--db\`), \`--server-db FILE\`, \`--browser-origin ORIGIN\` (repeatable or comma-separated), \`--login\` (require browser sign-in with an invited account; off by default), \`--public-url ORIGIN\` (the external origin for pairing and invite links; it does not change the bind address). Without \`--web-root\`, a packed binary serves its embedded web app; a plain build builds the app from this checkout (this needs Deno) and rebuilds it when the source changes. |
| \`build-web\` | Build the web app. \`--out DIR\` (default \`web/local.web\` in the app cache, \`~/.cache/tento/autophys/web/local.web\` on Linux), \`--bundle FILE\` (also write a single packed binary). |
| \`pack\` | Write one executable that holds the binary and a built web app. \`--web-root DIR\`, \`--out FILE\`, \`--no-maps\`. |

**Reading and reviewing workbooks**

These commands take \`--target\`: a collection directory, one \`.ap-workbook\` file, or an \`http(s)://\` daemon URL. The default is \`$AUTOPHYS_HOME\`, or \`~/autophys\` when that is unset. URL targets use the device key from \`AUTOPHYS_API_KEY\`, or the credentials \`autophys connect\` saved in \`$AUTOPHYS_CONFIG_DIR\` (default \`~/.config/autophys\`).

| Command | Options |
| --- | --- |
| \`projects\` | List projects. |
| \`investigations\` | List investigations. \`--project NAME\`. |
| \`records INVESTIGATION\` | Print an investigation's records. \`--kind KIND\` filters by record kind (approvals are \`proposal\` records). |
| \`approve INVESTIGATION PROPOSAL\` | Approve a proposal. \`--by NAME\` (default \`operator\`), \`--settings JSON\` (approve with edited settings: only the proposal's outlook axes can change, within their ranges; leave it out to approve unchanged). |
| \`reject INVESTIGATION PROPOSAL\` | Reject a proposal. \`--by NAME\`, \`--reason TEXT\`. |
| \`verify\` | Check each workbook's hash chain and projections. \`--project NAME\`. |

**Administration**

The admin commands work on the daemon's own files. Each takes \`--collection DIR\` (alias \`--db\`) and \`--server-db FILE\`, the same files \`serve\` uses.

| Command | What it does |
| --- | --- |
| \`pair list\`, \`pair approve CODE\`, \`pair deny CODE\` | Review devices waiting to pair (a device starts this with \`connect\`). |
| \`keys list\`, \`keys revoke KEY_ID\` | List or revoke paired devices' API keys. |
| \`users list\` | List browser accounts, with their read-only and demo flags. |
| \`users add EMAIL\` | Create or re-invite an account, printing a one-time password link valid for seven days. \`--public-url ORIGIN\` sets the link's origin, \`--read-only\` blocks browser writes, and \`--demo\` makes it the single passwordless demo account that anyone can continue as from the sign-in page. |
| \`users set EMAIL\` | Change an account with \`--read-only\` or \`--read-write\`, and \`--demo\` or \`--no-demo\`. Turning demo off ends its sessions; re-invite it before it can sign in with a password. |
| \`users remove EMAIL\` | Delete the account and end its sessions. |
| \`db verify\` (or \`db check\`) | Verify the collection's workbooks. \`--rebuild\` rebuilds the projections, and \`--project NAME\` limits the check. |

Browser accounts and paired device keys are separate: an account's read-only flag does not restrict a device key.

**Policy training**

The \`train\` commands drive the Python workers in \`train/sft\` (see its \`README.md\`). Each takes \`--train-dir DIR\` (default \`$AUTOPHYS_TRAIN_DIR\`, then \`train/sft\`) and \`--python FILE\` (default \`$AUTOPHYS_TRAIN_PYTHON\`, then \`python3\` on \`PATH\`); that Python needs the SDK and the workers' own dependencies.

| Command | Options |
| --- | --- |
| \`train dataset\` | Generate decision rows from scripted investigations. \`--out DIR\` (default \`<train-dir>/data\`), \`--train-seeds 0,1,2\`, \`--val-seeds 5,6\`, \`--heldout-seeds 3,4\` (disjoint), \`--case NAME\` (repeatable; default all), \`--playbook default\`, \`--backend local\\|modal\` (Modal also needs \`--usd-per-hour\` and \`--max-usd\`). |
| \`train run\` | Plan or run adapter training. \`--name NAME --base-model HF_ID --data DIR\` are required. It only plans unless you pass \`--live\`. \`--backend loops\\|modal\` (default \`loops\`); hyperparameters \`--rank 32\`, \`--epochs 4\`, \`--batch-size 8\`, \`--lr 0.0002\`, \`--max-seq-len 2048\`, \`--warmup 5\`, \`--eval-every 10\`, \`--seed 0\`. A live run needs \`--max-usd\` and a price (\`--usd-per-mtok\` or \`--usd-per-hour\`); Modal also needs \`--gpu\`. |
| \`train eval\` | Evaluate policies on held-out cases. \`--out DIR\` (new), \`--seeds 3,4\`, \`--case NAME\`, \`--policy reason\\|scripted\` (repeatable; default both), \`--route baseten\\|meta\\|lane\` (default \`baseten\`), \`--model NAME\` (needed for \`reason\`), \`--replay FILE\`. Live calls need \`AUTOPHYS_ALLOW_LIVE_REASON=1\`. \`--backend modal --run NAME --gpu GPU --usd-per-hour X --max-usd Y\` evaluates a trained Modal adapter. |
| \`train runs\` | List run manifests, newest first. Plans and history live under \`<train-dir>/runs/NAME/\`. |

**Environment.** \`serve\` also reads these variables; a flag takes precedence over its variable.

| Variable | Flag | Default |
| --- | --- | --- |
| \`AUTOPHYS_ADDR\` | \`--addr\` | \`127.0.0.1:4794\` |
| \`AUTOPHYS_WEB_ROOT\` | \`--web-root\` | embedded app, or a build from source |
| \`AUTOPHYS_HOME\` | \`--collection\` | \`~/autophys\` |
| \`AUTOPHYS_SERVER_DB\` | \`--server-db\` | \`server.db\` in the app's data directory (\`~/.local/share/tento/autophys/server.db\` on Linux) |
| \`AUTOPHYS_BROWSER_ORIGINS\` | \`--browser-origin\` | none (comma-separated) |
| \`AUTOPHYS_LOGIN\` | \`--login\` | off (\`1\`, \`true\` or \`yes\` turns it on) |
| \`AUTOPHYS_PUBLIC_URL\` | \`--public-url\` | unset: pairing links use the bound address |

The \`train\` commands read \`AUTOPHYS_TRAIN_DIR\` and \`AUTOPHYS_TRAIN_PYTHON\`, and URL targets read \`AUTOPHYS_API_KEY\` and \`AUTOPHYS_CONFIG_DIR\`.

### Developer commands

\`\`\`sh
A=./target/release/autophys
$A bench --seeds 5 --jobs 4
$A research --output-dir ./research-1 --replay policy.jsonl --researcher-replay researcher.jsonl
$A autoloop --output-dir ./autoloop-1 --policy fake-reasoner --researcher heuristic --max-iterations 3
$A export-trajectories ./research-1 --output decisions.jsonl
$A mcp --project battery_ecm --workbook ~/autophys
\`\`\`

Errors go to stderr with exit status 2. Plot images (\`--images\`, \`--researcher-images\`) need the Python SDK's plot renderer and are refused by the binary; a Python program can still attach plots through the SDK's reasoners.

| Command | Options |
| --- | --- |
| \`bench\` | Run the synthetic benchmark. \`--jobs N\` (default 1), \`--seeds N\` (default 3), \`--case NAME\` (repeatable; default all six cases below), \`--policy scripted\\|fake-reasoner\\|reason\` (repeatable; default \`scripted\` and \`fake-reasoner\`), \`--json\`. For \`--policy reason\`, \`--model\` is required; \`--route meta\\|baseten\\|lane\\|muse\` (default \`meta\`), \`--effort\`, \`--playbook\`, \`--replay FILE\` and \`--record FILE\` configure the model. |
| \`research\` | Improve a playbook. \`--output-dir DIR\` is required and must not exist yet. The defaults are one iteration, one job, the \`reason\` policy and the API researcher. The options are listed below. |
| \`autoloop\` | Improve a playbook until a stop condition, with a journal and resumable state. It takes the \`research\` options plus the ones listed below. \`--output-dir DIR\` is required, and must be new unless you pass \`--resume\`. |
| \`export-trajectories SOURCE\` | Write each recorded reasoner decision in a workbook, collection or research directory as one JSONL line. \`--output FILE\` (a new file; default stdout). |
| \`mcp\` | Serve the calibration tools over MCP stdio (stdout carries only protocol messages). \`--project\` (the built-in \`battery_ecm\`, the default), \`--workbook\` (a collection directory, an \`.ap-workbook\` file or a daemon URL), \`--investigation ID\` (resume one), \`--root DIR\` (default the current directory), \`--playbook\`, \`--config FILE\` (default \`.autophys-mcp.json\`). |

The benchmark cases are \`oscillator-free-only\`, \`oscillator\`, \`thermal-short-only\`, \`thermal\`, \`battery-short-only\` and \`battery\`. The planted \`battery-biased\` case runs only when named.

**\`research\` options**

- Run: \`--playbook\` (default \`default\`), \`--case\` (repeatable), \`--train-seeds 0,1,2\`, \`--heldout-seeds 3,4\` (the two sets must not overlap), \`--iterations N\` (default 1), \`--jobs N\` (default 1).
- Investigation policy: \`--policy reason|scripted|fake-reasoner\` (default \`reason\`), \`--model\` (default \`muse-spark-1.3\`), \`--route meta|baseten|lane|muse\` (default \`meta\`), \`--effort\`, \`--replay FILE\`, \`--record FILE\`. The \`muse\` route runs one headless \`muse exec\` per decision on your Muse coding plan.
- Researcher: \`--researcher api|muse|scripted|heuristic\` (default \`api\`), \`--researcher-model\` (default \`muse-wonder-1.0\`), \`--researcher-route meta|baseten\`, \`--researcher-effort\`, \`--researcher-replay FILE\`, \`--researcher-record FILE\`. With \`scripted\`, repeat \`--edit FILE\` to supply each complete \`SKILL.md\` edit in order. With \`muse\`, also \`--muse-binary\` (default \`muse\`), \`--timeout\` (seconds, default 300) and \`--max-model-steps\`.
- Replays: the \`reason\` policy needs \`--replay\`, and the \`api\` and \`muse\` researchers need \`--researcher-replay\`, unless live calls are allowed. The other policies and researchers run offline.
- Output: the directory holds \`summary.json\`, \`iterations.json\` once an edit has been tried, a \`scores.json\` for each evaluation, one workbook per case and seed, and each candidate playbook as \`playbook-NNN.md\` with a matching \`.sha256\` file. The input playbook is never overwritten.

**\`autoloop\` options**

- Limits: \`--max-iterations N\` (default 10; \`--iterations\` has no effect here), \`--patience N\` (stop after N rejected edits in a row; default 3), \`--max-usd USD\` and \`--max-wall-s SECONDS\` (unset by default). Creating a \`STOP\` file in the output directory stops it before the next edit. Limits are checked between iterations, and costs the provider does not report (such as coding-plan use) do not count toward \`--max-usd\`.
- Acceptance: \`--acceptance auto|lexicographic|bootstrap\` (default \`auto\`: bootstrap for the \`reason\` policy, lexicographic otherwise), \`--repeats N\` (evaluations per seed; default 1), \`--alpha A\` (default 0.05).
- Resume: \`--resume\` continues a run with its saved cases, seeds, policy and acceptance settings; a \`reason\` run must keep the same model settings.
- Output: \`state.json\`, \`journal.jsonl\`, \`playbooks/\`, \`train/\`, \`heldout/\` and \`summary.json\`, plus \`spend.jsonl\` for known charges.

**Environment**

| Variable | What it sets |
| --- | --- |
| \`AUTOPHYS_HOME\` | The collection \`ap.connect()\` opens when it is given no target (default \`~/autophys\`). |
| \`AUTOPHYS_API_KEY\` | The key for \`autophys whoami\` and for a remote \`ap.connect\`. When it is unset, the credentials saved by \`autophys connect\` are used. |
| \`AUTOPHYS_SERVER\` | The daemon \`autophys connect\` and \`whoami\` talk to when no URL is given; it wins over the saved server. |
| \`AUTOPHYS_CONFIG_DIR\` | Where \`autophys connect\` saves \`credentials\` (default \`~/.config/autophys\`). |
| \`AUTOPHYS_ALLOW_LIVE_REASON\` | Set it to \`1\` to let \`bench\`, \`research\` and \`autoloop\` make live model calls. Without it, model-backed policies and researchers need a replay. SDK reasoners you build yourself are not gated. |
| \`AUTOPHYS_REASON_REPLAY\`, \`AUTOPHYS_REASON_RECORD\` | Default cassette paths for \`ap.reasoner_for()\`, to replay or record model replies as JSONL. Explicit arguments win. |
| \`AUTOPHYS_REASON_ROUTE\`, \`AUTOPHYS_REASON_MODEL\` | Configure \`ap.reasoner_from_env()\`. The route is \`meta\` (the default; key in \`MODEL_API_KEY\`), \`baseten\` (key in \`BASETEN_API_KEY\`; set the model too), \`lane\` or \`muse\`. The default model is \`muse-spark-1.3\`. The CLI ignores these; pass \`--route\` and \`--model\` instead. |
| \`AUTOPHYS_REASON_URL\` | Overrides the HTTP endpoint for the \`meta\`, \`baseten\` and \`lane\` routes, for the SDK and the CLI alike. The \`lane\` route requires it. |
| \`AUTOPHYS_MUSE_BINARY\` | The \`muse\` executable for the \`muse\` policy route (default \`muse\`). |

### Python SDK

\`import autophys as ap\` exports everything below except the built-in simulators, which you import from \`autophys.models\`. This script runs as written: it uses a built-in model to stand in for your measurements, and stops when the loop proposes its first experiment.

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

Save it as \`demo.py\` and run \`.venv/bin/python -i demo.py\` from the repository root; \`-i\` keeps \`inv\` available when the script finishes, and the workbook lands in \`./autophys-demo\`. To review it, start \`./target/release/autophys serve --collection ./autophys-demo\` in another terminal and open \`http://127.0.0.1:4794\`, or use the daemon's \`approve\` with \`--target ./autophys-demo\` and the printed IDs. Then \`state = inv.wait_for_approval()\`; if \`state["status"]\` is \`approved\` or \`edited\`, run \`state["experiment"]\` with \`state["settings"]\`, and call \`inv.attach_data(outcome.proposal_id, measured)\` and \`inv.run()\` again. A \`validated\` result also needs a held-out validation trace, which this demo does not have, so its loop ends \`inconclusive\`; the first example above adds one.

**Connections and workbooks**

| Name | What it is |
| --- | --- |
| \`ap.connect(target=None, *, api_key=None)\` | A \`LocalClient\` for a directory or a \`.ap-workbook\` file, or a \`RemoteClient\` for an \`http(s)://\` daemon URL. Use it as a context manager to close it. |
| \`client.projects()\` | \`[{id, name}]\`, plus \`path\` locally. |
| \`client.project(project)\` | Pass a \`Project\` to create or open its workbook and run investigations. Pass a name to open an existing workbook for listing and verification; a missing one raises \`WorkbookError\` locally, or \`StoreError\` from a daemon. |
| \`wb.investigate(dataset, runner, policy=…)\` | Start a recorded \`Investigation\`. Needs a workbook opened with the \`Project\`. |
| \`wb.investigation(id, runner=None, policy=…)\` | Resume an investigation from its records. Needs the same \`Project\` (simulator and configuration) it was started with. |
| \`wb.investigations()\` | One row per investigation: id, status, budget used, overrides. |
| \`wb.config_versions()\`, \`wb.verify()\` | The stored config versions; the chain and projection check, which returns \`{ok, records, investigations, chain_errors, projections_match}\`. |

**Investigations**

| Name | What it is |
| --- | --- |
| \`inv.run() -> Outcome\` | Run the loop until it stops, a budget runs out, or it proposes an experiment (status \`awaiting_data\`). It raises \`ToolError\` while a proposal is waiting for data. |
| \`Outcome\` | \`status\`, \`reasons\`, \`estimate\`, \`units\`, \`fixed\`, \`identified\`, \`non_identified\`, \`non_identifiable_combinations\`, \`guardrail_overrides\`, \`model\`, \`fit\` (a summary dict), \`validation\`, \`steps\`, \`simulations\`, \`experiments\`, \`wall_s\`, \`investigation\`, \`proposal_id\`, \`summary\`, \`usage_total\`; \`to_dict()\` for JSON. |
| \`inv.wait_for_approval(*, timeout=3600, interval=5) -> dict\` | Block until the pending proposal leaves \`proposed\`, then return its state. Attach data only when \`status\` is \`approved\` or \`edited\`; at \`data_attached\`, another writer has already attached it and the handle picks that up. Raises \`TimeoutError\` when the time runs out. |
| \`inv.attach_data(proposal_id, observation)\` | Attach the measured result of an approved experiment as training data, then call \`inv.run()\` again. |
| \`inv.approve(proposal_id, *, by="user", settings=None)\`, \`inv.reject(proposal_id, *, by="user", reason="")\` | Decide a proposal from code; reviewers normally do this in the workbench. |
| \`inv.records(kind=None)\`, \`inv.proposal(proposal_id)\` | The investigation's records; one proposal's current state. |
| \`ProposalRunner()\` | The runner that turns a requested experiment into a proposal for a person to run. |
| \`ScriptedPolicy(misfit=2.0)\` | The deterministic policy. |
| \`ReasonLanePolicy(reasoner, *, playbook=None, model_spec=None, effort="low", max_tokens=2400)\` | A policy a model drives through a \`Reasoner\`; with no playbook it uses the bundled default. |

**Models and data**

| Name | What it is |
| --- | --- |
| \`@ap.simulator(params, experiments=None, *, outputs=(), stochastic=False, name=None, display=None)\` | Declare a simulator: parameters as \`name: (unit, low, high)\`, the experiment catalogue, the output channels, and optionally a \`Display\` for the workbench. It returns an \`ap.Simulator\`. |
| \`ap.Observation(experiment, settings, t, y, sigma, split="train", source="measured", meta={})\` | One measured run. \`y\` maps each channel to an array shaped like \`t\`, and \`sigma\` gives a positive noise level per channel. \`split\` is \`train\` or \`validation\` (\`test\` is reserved for evaluators). Non-finite samples are left out of the fit. |
| \`ap.Dataset(observations=())\` | The versioned set of observations an investigation fits. |
| \`ap.Project(name, simulator, …)\` | A simulator plus its configuration: \`initial\`, \`fixed\`, \`catalog\` (per-experiment \`max_runs\`, editable settings and \`cost_hours\`), \`noise\`, \`budgets\`, \`stop\`, \`policy\`, \`n_starts=4\`. With no catalog, every experiment is available without limit. Each distinct configuration is stored as a content-hashed config version. |
| \`ap.Budgets(…)\` | \`max_steps=24\`, \`max_simulations=20000\`, \`max_experiments=2\`, \`max_outlook_simulations=50000\`, \`max_test_hours=None\`. |
| \`ap.NoiseConfig(sigma=None, estimate=False, bias="compare")\` | Declared or estimated sigma, and sensor bias (\`off\`, \`fit\` or \`compare\`). |
| \`ap.StopRules(validation_threshold=2.0, misfit_threshold=2.0, rule=DEFAULT_RULE)\` | Validation and misfit thresholds, and the identifiability rule. |
| \`ap.PolicyConfig(kind="scripted", effort="low", max_tokens=2400)\` | The policy kind (\`scripted\` or \`reason-lane\`), effort and token limit. |
| \`ap.SimOptions(rtol=1e-8, atol=1e-10, seed=None)\`, \`ap.FIT_OPTIONS\`, \`ap.TRUTH_OPTIONS\` | Solver tolerances and seed. \`TRUTH_OPTIONS\` is tighter, for generating reference data; stochastic simulators need a seed. |
| \`ap.Display\` | How the workbench draws a simulator's channels, inputs and parameters. |
| \`autophys.models\` | Built-in simulators: \`oscillator\`, \`thermal_rc\` and \`battery_ecm\`. |

**Numerics**

| Name | What it is |
| --- | --- |
| \`ap.fit(sim, observations, *, initial=None, n_starts=4, loss="linear", f_scale=1.0, seed=0, max_nfev=200, options=FIT_OPTIONS) -> FitResult\` | Weighted multistart least squares in log/scaled coordinates, over the observations you pass. |
| \`ap.analyze(sim, params, observations, *, rule=DEFAULT_RULE, jac=None) -> (SensitivityReport, ndarray)\` | Identifiability from the SVD of the noise-weighted Jacobian: log coordinates for positive parameters, range-scaled otherwise. It returns the report and the Jacobian: \`report, jac = ap.analyze(...)\`. |
| \`ap.IdentifiabilityRule(rel_tol=1e-3, max_log_std=0.1, loading_tol=0.2)\`, \`ap.DEFAULT_RULE\` | A direction is unresolved when its singular value is below \`rel_tol\` of the largest, or its one-sigma uncertainty is above \`max_log_std\` (about ±10%). A parameter is identified when its own uncertainty is within \`max_log_std\` and it loads no more than \`loading_tol\` on any unresolved direction. |
| \`ap.rank_experiments(sim, params, observations, noise, *, candidates=None, criterion="min_eig", J0=None)\` | Rank catalogue experiments by Fisher information, by the minimum eigenvalue (\`min_eig\`) or D-optimality (\`d_opt\`). Each candidate has \`experiment\`, \`min_eig\`, \`d_opt\`, \`min_eig_gain\`, \`worst_direction\`, \`cost_hours\`, and \`after\`: each parameter's expected one-sigma uncertainty once that experiment's data is added. |
| \`ap.FitResult\`, \`ap.SensitivityReport\` | The results of \`fit\` and \`analyze\`; both have \`to_dict()\`. |

**Reasoners and playbooks**

| Name | What it is |
| --- | --- |
| \`ap.ModelSpec(role, route, model, effort=None, max_tokens=None, images=False)\` | An explicit model choice. \`role\` is \`policy\` or \`researcher\`; \`route\` is \`meta\`, \`baseten\`, \`lane\` or \`muse\`. \`ap.MUSE_SPARK\` and \`ap.MUSE_WONDER\` name the default models. |
| \`ap.reasoner_from_env()\`, \`ap.reasoner_for(spec, **options)\` | Build a reasoner from the \`AUTOPHYS_REASON_*\` variables, or from a \`ModelSpec\` (options include replay and record paths). |
| \`ap.ChatReasoner\`, \`ap.HttpReasoner\`, \`ap.FakeReasoner\` | Chat completions (Muse or Baseten), a reason-lane endpoint, and a deterministic stand-in for tests. |
| \`ap.RecordingReasoner\`, \`ap.ReplayReasoner\` | Record replies to a cassette, or replay them with no network. |
| \`ap.Reasoner\`, \`ap.BudgetError\` | The completion protocol a reasoner implements, and the error a provider's billing refusal raises. |
| \`ap.Playbook\`, \`ap.load_playbook(path_or_name="default")\` | A strategy \`SKILL.md\`, loaded by bundled name or by path. |

### Rust SDK

The crate is \`autophys\` in \`sdks/rust\`. It reads and writes the same \`.ap-workbook\` files as the Python SDK, connects to a daemon over HTTP through the same API, and the daemon delegates its workbook operations to it. Its names follow Python's. Where Python takes an optional argument, Rust has two functions: \`project(name)\` opens a workbook for its records, and \`project_with(Project)\` attaches the simulator so you can run investigations; \`investigation(id)\` returns a record handle, and \`resume(id, runner, policy)\` rebuilds a running loop. Add it with a path relative to your own \`Cargo.toml\`:

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

In the tables, \`Result\` is \`autophys::Result\`, \`Value\` is \`serde_json::Value\` and \`Duration\` is \`std::time::Duration\`; \`agent\`, \`data\` and \`project\` are modules of the crate. \`autophys::Project\` is a project's metadata (\`id\`, \`name\`), while \`autophys::project::Project\` is the simulator and its configuration.

**Collections and workbooks**

| Name | What it is |
| --- | --- |
| \`autophys::connect(target: Option<&str>) -> Result<Client>\` | A collection directory, one \`.ap-workbook\` file, or an \`http(s)://\` daemon URL; \`None\` means the local \`$AUTOPHYS_HOME\`, or \`~/autophys\`. |
| \`Client::connect_remote(server: &str, api_key: &str) -> Result<Client>\` | Connect to a daemon with an explicit key. For a URL, \`connect\` uses \`AUTOPHYS_API_KEY\`, or the credentials \`autophys connect\` saved in \`$AUTOPHYS_CONFIG_DIR\` (default \`~/.config/autophys\`; keep the file mode \`0600\`). |
| \`client.projects() -> Result<Vec<Project>>\`, \`client.workbooks() -> Result<Vec<Workbook>>\` | List projects; open every workbook. |
| \`client.project(name: &str) -> Result<Workbook>\`, \`client.project_by_id(id: &str)\` | Open a workbook by name (created if missing), or an existing one by its \`prj_…\` ID. |
| \`client.project_with(project: project::Project) -> Result<ProjectWorkbook>\` | Open a workbook with its simulator attached, storing the config version. \`wb.with_project(project)\` attaches one to an open workbook. |
| \`client.find_investigation(id: &str) -> Result<Investigation>\`, \`client.investigations_in(project: Option<&str>)\` | Find an investigation anywhere in the collection; list investigations, optionally in one project (by \`prj_…\` ID). |
| \`wb.investigations()\`, \`wb.proposals()\` | Projection rows, and every proposal's current state. |
| \`wb.config_versions()\`, \`wb.put_config_version(v: &str, body: &[u8]) -> Result<bool>\` | Read and store config versions; \`v\` is \`sha256:\` and the body's hash. |
| \`wb.verify() -> Result<VerifyReport>\` | The chain and projection check, locally or over HTTP, with the same five fields as Python's. |
| \`wb.rebuild_projections() -> Result<VerifyReport>\` | Rebuild the projection tables from the records, then verify. Local workbooks only; over HTTP it returns \`Error::Unsupported\`. |

**Record handles** (\`autophys::Investigation\`, from \`wb.investigation(id)\` or \`client.find_investigation(id)\`)

| Name | What it is |
| --- | --- |
| \`records(kind: Option<&str>) -> Result<Vec<Record>>\`, \`records_after(gseq: i64)\`, \`proposal(pid: &str) -> Result<Proposal>\` | Records, the records after a workbook cursor (for streaming), and one proposal. |
| \`approve(pid, by, settings: Option<Value>) -> Result<Appended>\`, \`reject(pid, by, reason)\` | Decide a proposal; settings approve it as edited. |
| \`wait_for_approval(pid, timeout: Duration) -> Result<Proposal>\` | Block until the proposal leaves \`proposed\`; check its status before attaching data. Returns \`Error::Timeout\` when the time runs out. |
| \`attach_data(pid, observation: Value) -> Result<Appended>\` | Attach measured data as JSON to an approved or edited proposal. |
| \`append(kind: &str, payload: Value, id: Option<&str>) -> Result<Appended>\` | Append one validated record; \`id\` is an optional idempotency key. This is the record writer, not \`run\`. |
| \`info()\`, \`workbook()\` | The investigation's projection row, and its workbook. |

**Running loops** (\`autophys::agent::Investigation\`, from \`ProjectWorkbook\`)

| Name | What it is |
| --- | --- |
| \`wb.investigate(dataset, runner, policy) -> Result<agent::Investigation>\` | Start a loop. \`investigate_with(dataset, runner, policy, free, seed, title)\` also sets the free parameters, seed and title. |
| \`wb.resume(id: &str, runner, policy) -> Result<agent::Investigation>\` | Rebuild a loop from its records, with the same simulator configuration. |
| \`run() -> Result<Outcome>\` | Run the loop. \`Outcome\` has the same fields as Python's. |
| \`wait_for_approval(timeout: Duration) -> Result<Proposal>\` | Wait for the pending proposal. |
| \`attach_data(pid, observation: data::Observation) -> Result<Appended>\` | Attach the measured result as training data, then \`run()\` again. |
| \`approve(pid, by, settings)\`, \`reject(pid, by, reason)\`, \`withdraw(pid, by, reason)\` | Decide or withdraw the pending proposal from code. |

Attached measurements count toward \`max_experiments\` and the proposed experiment's \`cost_hours\` toward \`max_test_hours\`, including after \`resume\`. If another process attaches data through a record handle, \`resume\` the loop to pick it up. Each fit records display curves for the workbench, bounded so a run record stays under 256 KiB; drawing them does not use the simulation budget.

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
