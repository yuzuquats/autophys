# autophys

autophys fits a physical model to your measurements, then tells you which
parameters those measurements actually pin down. A parameter counts as
**identified** only if the data determines it to better than ±10%. That
verdict comes from a sensitivity (log-Jacobian SVD) analysis, not from how good
the fit looks. When parameters are tied together, autophys ranks the next
experiment that would separate them. An agent (Muse Spark, or a scripted
policy) can drive that loop, with a human approving each experiment.

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
| `sdks/rust` | Rust SDK |
| `autophys.project.docs/content` | design notes and decisions |

The closed loop works like this. You fit, autophys ranks candidate
experiments, the agent proposes one, you approve or edit it in the browser,
the new data is attached, and it fits again. That loop runs on the built-in
catalogue experiments today. The browser draws measured data, parameters and
sensitivity, but it doesn't draw the fitted curve yet. Use the example for
curves.
