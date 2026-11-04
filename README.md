# autophys

autophys fits a physical model to your measurements, then tells you which
parameters those measurements actually pin down. A parameter counts as
**identified** only if the data determines it to better than ±10%. That
verdict comes from a sensitivity (log-Jacobian SVD) analysis, not from how good
the fit looks. When parameters are tied together, autophys ranks the next
experiment that would separate them. An agent (Muse Spark, or a scripted
policy) can drive that loop, with a human approving each experiment.

This README is the hand-off for battery work. It starts with the shortest path
to a fitted curve on your own data.

## 1. Set up (5 minutes, no accounts or keys)

You need Python 3.10 or newer and git.

```sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys
python3 -m venv .venv
.venv/bin/pip install ./sdks/python matplotlib
```

That installs the SDK (numpy and scipy) and matplotlib, which is used for the
plot. Nothing calls the network.

## 2. Run the demo cell

```sh
.venv/bin/python examples/battery_fit.py --demo
```

This writes `demo.csv` from a cell with a known answer (R0 = 0.025 Ω,
R1 = 0.045 Ω, C1 = 1600 F, 2 mV noise), fits it, and saves `fit.png`:

```
wrote demo.csv: 1800 samples, true R0=0.025 R1=0.045 C1=1600.0

fit: chi2/N = 0.99 (converged; ~1 means the residuals match sigma)
  R0  = 0.024857 ohm       ±0.4%  identified
  R1  = 0.045448 ohm       ±0.4%  identified
  C1  = 1589.3 F         ±0.7%  identified

plot: fit.png
```

`fit.png` has three panels: measured voltage with the fitted model on top,
residuals in mV in the middle, and the current trace at the bottom.

## 3. Fit your own cell

Export a CSV with time in seconds, current in amps (positive = discharging)
and terminal voltage in volts. The current can be any trace, such as HPPC
pulses, rests or a drive cycle. Then run:

```sh
.venv/bin/python examples/battery_fit.py my_cell.csv \
  --sigma 0.002 --capacity-ah 2.5 --soc0 0.9 --ocv my_ocv.csv --out my_cell.png
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--sigma` | voltage noise standard deviation (V): your sensor's noise, not the fit residual | 0.002 |
| `--capacity-ah` | cell capacity (Ah) | 2.5 |
| `--soc0` | state of charge at t = 0 (0 to 1) | 0.9 |
| `--ocv` | `soc,voltage` CSV of your cell's open-circuit voltage | a generic NMC table |
| `--columns` | column names for time, current and voltage | `time,current,voltage` |

Use your own OCV curve if you have one; the generic table is only a
placeholder. CSVs from a cycler usually need the columns renamed or
`--columns` set to their names.

The model is a first-order Thevenin (1RC) cell:
`V = OCV(SOC) − V1 − I·R0`, with `dV1/dt = −V1/(R1·C1) + I/C1`. It's about 20
lines in `examples/battery_fit.py` (`make_model`). A 2RC model or a
temperature-dependent OCV is an edit to that function.

## 4. Read the result

- **chi2/N** close to 1 means the residuals are the size of your stated noise.
  Much bigger means the model or `--sigma` is wrong. Much smaller means
  `--sigma` is too large.
- **identified** means the data pins that parameter to better than ±10%.
- **NOT identified** together with a **tied:** line means the data can't
  separate those parameters. Only a combination of them is determined. A
  near-perfect curve can still have tied parameters.

For example, keep only the first pulse of the demo, with no rest after it:

```sh
awk -F, 'NR==1 || $1<64' demo.csv > short.csv
.venv/bin/python examples/battery_fit.py short.csv --out short.png
```

```
  R0  = 0.024773 ohm       ±0.8%  identified
  R1  = 0.042943 ohm   unbounded  NOT identified
  C1  = 1556.9 F     unbounded  NOT identified
  tied: R1^1 * C1^0.28 (practical)
```

The curve in `short.png` fits well, but without the relaxation after the
pulse, R1 and C1 trade off against each other. This is the question autophys
answers before you spend more test hours: which test would separate them?

## 5. What we'd like from you

These go into the pitch. Any of them helps:

1. A real cell's CSV run through step 3, plus its OCV table if you have one.
2. Your HPPC protocol: hours per grid, the share of that time spent resting,
   and grids per cell (for example, one per temperature).
3. Whether the R1 ↔ C1 trade-off above matches what you see in practice.
4. How you'd like to be credited on the user slide, and one sentence, in your
   own words, about what characterization costs you.

## The full system

The script above uses only the SDK's fit and identifiability analysis.
The rest of the repo does the following:

| Path | What it is |
| --- | --- |
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
sensitivity, but it doesn't draw the fitted curve yet. Use the script for
curves.
