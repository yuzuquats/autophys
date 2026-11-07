# AutoPhys

**Fit your model. Find out what to test next.**

**Live site: [autophys.lona.so](https://autophys.lona.so)** ·
[Open the workbench](https://autophys.lona.so/app)

AutoPhys helps engineers and researchers fit physical models to measurements,
see what remains uncertain, and choose the next experiment. Agents analyze the
results and propose tests. You steer the investigation and approve what gets run.

![Muse Spark reasons about what to measure next, using tool results to propose a test for human approval.](docs/images/readme/muse-spark.png)

*Illustrative conversation from the live site with mock data.*

## A good fit is only the beginning

In the bundled synthetic battery example, a short test fits the voltage curve
well while leaving resistance R1 and capacitance C1 hard to distinguish.
AutoPhys flags the ambiguity and recommends a test to separate them. Run the
test, attach the measurements, and refit before checking predictions against
held-out data.

## Try the battery example

You need Rust (to build the `autophys` command), Python 3.10 or newer, and Git.
`autophys new` creates a project whose SDK dependency is pinned to the commit
the command was built from; this local example needs no account or provider key.

```sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys
cargo build --release --locked --bin autophys
./target/release/autophys new ../my-cell --lang python   # the battery-fit project, with its own .venv
cd ../my-cell
.venv/bin/python battery_fit.py data/short.csv --out short.png
```

The curve fits, but the abbreviated parameter verdict is:

```text
R0  identified
R1  NOT identified
C1  NOT identified
```

Then run the complete loop with a simulated cell and the default scripted policy:

```sh
.venv/bin/python closed_loop.py start --simulate
autophys approve INVESTIGATION PROPOSAL     # the ids start prints; or approve in the browser
.venv/bin/python closed_loop.py continue --simulate
```

It ranks the next test, waits for approval, attaches synthetic measurements,
refits, and checks predictions against data kept out of the fit. The
project's README ([source](templates/battery-fit/python/README.md)) explains
the results and how to use your own cell data, import measurements from a
cycler, or choose a model-backed policy. `--lang rust` creates the same fit in
Rust, and `--example blank` an empty project; `autophys connect URL` pairs the
device with a server once.

## Use your own model

Built-in models cover batteries, oscillators and thermal systems. Use the
[Python SDK](sdks/python/README.md) or [Rust SDK](autophys.project.docs/content/rust-sdk.md) to supply
a model and measurements, or [connect Muse](autophys.project.docs/content/muse-plugin.md)
to the investigation tools. Model-backed agents require provider setup.

Today, AutoPhys fits supplied models and ranks catalog experiments. The
longer-term goal is to help revise the underlying physics too.

## Commands

Everything runs through the one `autophys` binary; the Python and Rust SDKs
are libraries. `autophys <command> --help` lists each command's flags.

| Start a project | |
| --- | --- |
| `autophys new DIR --lang python\|rust` | Create a project from a template (`--example battery-fit\|blank`); Python projects get a `.venv` |
| `autophys connect [URL]` | Pair this device with a server and save its key |
| `autophys whoami` | Show the account, workspace and device the key belongs to |

| Investigations | |
| --- | --- |
| `autophys projects` | List projects |
| `autophys investigations` | List investigations (`--project NAME`) |
| `autophys records INVESTIGATION` | Read an investigation's records (`--kind KIND`) |
| `autophys approve INVESTIGATION PROPOSAL` | Approve a proposed experiment (`--settings JSON` to edit it) |
| `autophys reject INVESTIGATION PROPOSAL` | Reject it (`--reason TEXT`) |
| `autophys verify` | Check workbook hash chains and projections |

These act on a collection directory, `.ap-workbook` file or server URL given with
`--target` (default `AUTOPHYS_HOME` or `~/autophys`).

| Agents and research | |
| --- | --- |
| `autophys mcp` | Serve the investigation tools to Muse Code over MCP; `--project mypkg.module:project` runs your own Python simulator |
| `autophys bench` | Run the synthetic benchmark offline (`--policy scripted\|fake-reasoner\|reason`) |
| `autophys research` | Evaluate and improve playbook strategies (`--output-dir DIR`) |
| `autophys autoloop` | Keep researching until a stop condition, with a journal and `--resume` |
| `autophys export-trajectories SOURCE` | Export recorded reasoner decisions as JSONL |
| `autophys train dataset\|eval\|run\|runs\|loop\|loops` | Build training data, evaluate and fine-tune policies, list runs and loops ([training guide](train/sft/README.md)) |

| Server and administration | |
| --- | --- |
| `autophys serve` | Serve the workbench and API on loopback (`--addr 127.0.0.1:4794`) |
| `autophys pair list\|approve CODE\|deny CODE` | Approve devices that ran `autophys connect` |
| `autophys keys list\|revoke KEY_ID` | Manage device keys |
| `autophys users list\|add EMAIL\|set\|remove` | Manage sign-in accounts |
| `autophys workspace list\|bind\|key\|seed\|profile` | Bind accounts to collections (dry run unless `--apply`) |
| `autophys db verify` | Verify the server's collection (`--rebuild`) |
| `autophys build-web`, `autophys pack` | Build the web app and pack a single-file release ([ops](ops/README.md)) |

## The learning loop

<table>
<tr>
<td width="50%"><img src="docs/images/readme/investigation-loops.png" alt="Two loops: one investigates, one improves it. Muse Wonder evaluates playbook changes around a Muse Spark investigation." width="640"></td>
<td width="50%"><img src="docs/images/readme/policy-training.png" alt="Then train the model that runs it. Record decisions, distil the scripted expert today, and plan reinforcement learning." width="640"></td>
</tr>
<tr>
<td valign="top">The inner loop calibrates a physical model. The outer loop evaluates changes to the investigation playbook and keeps those that score better: <code>autophys research</code> and <code>autophys autoloop</code>, offline with the fake reasoner and the heuristic researcher.</td>
<td valign="top">Policy training is separate from fitting the physical model. The diagram shows the distillation workflow; reinforcement learning is planned. See the <a href="train/sft/README.md">training guide</a> for the current pipeline and its limits.</td>
</tr>
</table>

## Development and feedback

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[repository map](docs/README.md). The daemon, browser and SDKs build from this
checkout; no Lona account, fleet CLI or sibling repository is required.
Optional model providers, Muse and systemd deployment have separate setup.
Licensing must be reconciled before an open-source release; see
[vendor/README.md](vendor/README.md).

Working on battery characterization? Real-cell CSVs and OCV tables, HPPC
run/rest budgets, and feedback on the R1/C1 trade-off would help ground the
examples in lab practice.
