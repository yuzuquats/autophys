---
name: fit-battery-data
description: Fit a 1RC battery model to a cell's time/current/voltage CSV with autophys, plot measured vs fitted voltage, and report which parameters (R0, R1, C1) the data actually identifies. Use when someone wants to fit, calibrate or plot a battery pulse test, HPPC run or drive cycle in this repo, or asks whether their data determines the cell parameters.
---

# Fit battery data with autophys

The tool is `examples/battery_fit.py`, which uses the Python SDK in
`sdks/python`. It runs locally with no network, accounts or API keys.

## 1. Set up once, from the repo root

```sh
test -x .venv/bin/python || python3 -m venv .venv
.venv/bin/pip install -q ./sdks/python matplotlib
```

Python 3.10 or newer is required.

## 2. Check that the install works

```sh
.venv/bin/python examples/battery_fit.py --demo
```

Expect chi2/N near 1 and all three parameters identified, near R0 = 0.025,
R1 = 0.045 and C1 = 1600. If not, stop and report the output; don't go on to
real data.

## 3. Ask for what can't be inferred

Get these from the user before fitting, and don't guess them:

- **CSV columns** for time (s), current (A, positive = discharging) and
  voltage (V). Read the header and propose a `--columns time,current,voltage`
  mapping. Convert units first if the file uses ms, mA or mV.
- **Voltage noise sigma** (V) from the sensor or cycler spec. Never derive it
  from the fit residual, because that makes chi2/N meaningless.
- **Capacity** (Ah) and **starting SOC** (0 to 1).
- **OCV curve**, as a `soc,voltage` CSV, if they have one. Without it the
  script uses a generic NMC table. Say that this limits the result.

## 4. Fit

```sh
.venv/bin/python examples/battery_fit.py CELL.csv --sigma S --capacity-ah Q --soc0 SOC \
  [--ocv OCV.csv] [--columns T,I,V] --out CELL.png
```

The script exits with a message if columns are missing or time doesn't
increase. Fix the input; don't edit around the check.

## 5. Report

- Quote the printed parameter lines and the `identified` / `NOT identified`
  verdicts exactly. Only the script's identified list counts.
- Explain any `tied:` line in plain terms: the data fixes only that
  combination. A tie usually means the test lacks a long enough rest after a
  pulse, or lacks pulses at different currents.
- Interpret chi2/N: about 1 is consistent with sigma. Well above 1 means
  model mismatch or sigma too small. Well below 1 means sigma too large.
- Show the PNG. Its panels are measured vs fitted voltage, residuals in mV,
  and current.
- Mention any parameters listed `at bounds`.

## Never

- Claim a parameter is identified because the curve or residuals look good.
  A perfect fit can leave R1 and C1 tied; `short.csv` in the README shows one.
- Present demo or synthetic results as measurements from a real cell.
- Change the ±10% identifiability rule, or the bounds in `make_model`, to get
  a nicer verdict without telling the user.

## Going further

- **A 2RC model or temperature dependence:** edit `make_model` in
  `examples/battery_fit.py`. It's an `@ap.simulator` function that returns
  `{"t": t, "v": volts}`.
- **The closed loop:** autophys ranks the next experiment, a human approves
  it in the browser, and the new data is attached and refitted. See
  `sdks/python/README.md` and `autophys.project.docs/content/muse-plugin.md`.
  That loop currently uses the built-in catalogue experiments, not arbitrary
  traces.
