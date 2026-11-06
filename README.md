# autophys

AutoPhys helps engineers and researchers build better models of physical
systems. Agents analyze measurements, suggest what to test next, and help
refine the model as new results come in. You steer the investigation and
approve experiments.

A model can fit your data and still get the physics wrong. AutoPhys checks
what your measurements actually tell you and recommends experiments to
resolve what’s uncertain.

For example, a battery engineer uploads a short test. The voltage curve
fits well, but several parameter combinations could explain it. AutoPhys
recommends a test to tell them apart. The engineer runs it, uploads the
results, and AutoPhys refits the model and checks its predictions against
separate measurements.

Today, AutoPhys fits supplied models and ranks candidate experiments.
The longer-term goal is to help revise the underlying physics too.

For local development, start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[repository map](docs/README.md). The daemon, browser and SDKs build from this
checkout; no Lona account, fleet CLI or sibling repository is required.
Optional model providers, Muse and systemd deployment have separate setup.
Licensing must be reconciled before an open-source release; see
[vendor/README.md](vendor/README.md).

## Quick start: fit a battery cell

```sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys/examples/battery_fit
./run.sh                              # fits the bundled demo cell, writes fit.png
./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
```

You need Python 3.10 or newer; there are no accounts or keys. Everything
else, including inputs, sample data, expected output and how to read the
result, is in [examples/battery_fit/README.md](examples/battery_fit/README.md).

## What we'd like from you

These go into the pitch. Any of them helps:

1. A real cell's CSV run through `examples/battery_fit`, plus its OCV table if you have one.
2. Your HPPC protocol: hours per grid, the share of that time spent resting,
   and grids per cell (for example, one per temperature).
3. Whether the R1 ↔ C1 trade-off in the example (step 2 of its README)
   matches what you see in practice.
4. How you'd like to be credited on the user slide, and one sentence, in your
   own words, about what characterization costs you.

## The full system

The battery example uses only the SDK's fit and identifiability analysis.
The rest of the repo does the following:

| Path | What it is |
| --- | --- |
| `examples/battery_fit` | fit any measured battery trace, check identifiability, plot the curve; `run.sh agent` runs the closed loop (propose the next test, approve, attach, refit) |
| `sdks/python` | Python SDK: `@ap.simulator`, fit, identifiability, experiment ranking, agent loop, workbook ([README](sdks/python/README.md)) |
| `sdks/python/src/autophys/models/` | built-in battery, oscillator and thermal models |
| `plugins/muse-autophys` | Muse Code plugin: a local MCP server, so Muse can run the calibration ([guide](autophys.project.docs/content/muse-plugin.md)) |
| `src/`, `html/` | Rust daemon and browser workbench, where experiments are approved |
| `sdks/rust` | Rust SDK: scientific calibration, investigation loop and local/remote workbook records ([README](sdks/rust/README.md)); analogous to Python with explicit capability limits |
| `tests/`, `sdks/*/tests`, `html/**/*.test.ts` | daemon, SDK and browser contract checks |
| `ops/` | standalone packaging and optional systemd operation ([guide](ops/README.md)) |
| `train/sft` | optional policy training and evaluation ([guide](train/sft/README.md)) |
| `vendor/` | checked-in reusable dependencies and provenance ([guide](vendor/README.md)) |
| `autophys.project.docs/content` | internal design decisions and project records; contributor setup is above |

The closed loop works like this. You fit, autophys ranks candidate
experiments, the agent proposes one, you approve or edit it in the browser,
the new data is attached, and it fits again. That loop runs on the built-in
catalogue experiments today. The browser renders the display metadata and fit curves supplied by the SDK;
the SDK owns the numerical calculations.
