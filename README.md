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

You need Git and Python 3.10 or newer. The first run installs the Python SDK
and plotting dependencies; this local example needs no account or provider key.

```sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys/examples/battery_fit
./run.sh data/short.csv --out short.png
```

The curve fits, but the abbreviated parameter verdict is:

```text
R0  identified
R1  NOT identified
C1  NOT identified
```

Then run the complete loop with a simulated cell and the default scripted policy:

```sh
./run.sh agent start --simulate
./run.sh agent approve
./run.sh agent continue --simulate
```

It ranks the next test, waits for approval, attaches synthetic measurements,
refits, and checks predictions against data kept out of the fit. The
[battery guide](examples/battery_fit/README.md) explains the results and how
to use your own cell data, import measurements from a cycler, or choose a model-backed policy.

## Use your own model

Built-in models cover batteries, oscillators and thermal systems. Use the
[Python SDK](sdks/python/README.md) or [Rust SDK](autophys.project.docs/content/rust-sdk.md) to supply
a model and measurements, or [connect Muse](autophys.project.docs/content/muse-plugin.md)
to the investigation tools. Model-backed agents require provider setup.

Today, AutoPhys fits supplied models and ranks catalog experiments. The
longer-term goal is to help revise the underlying physics too.

## The learning loop

![Two loops: one investigates, one improves it. Muse Wonder evaluates playbook changes around a Muse Spark investigation.](docs/images/readme/investigation-loops.png)

The inner loop calibrates a physical model. The outer loop evaluates changes
to the investigation playbook and keeps those that score better.

![Then train the model that runs it. Record decisions, distil the scripted expert today, and plan reinforcement learning.](docs/images/readme/policy-training.png)

Policy training is separate from fitting the physical model. The diagram
shows the distillation workflow; reinforcement learning is planned. See the
[training guide](train/sft/README.md) for the current pipeline and its limits.

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
