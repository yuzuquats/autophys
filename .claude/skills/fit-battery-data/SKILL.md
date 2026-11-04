---
name: fit-battery-data
description: Fit a 1RC battery model to a cell's time/current/voltage CSV with autophys, plot measured vs fitted voltage, and report which parameters (R0, R1, C1) the data actually identifies. Use when someone wants to fit, calibrate or plot a battery pulse test, HPPC run or drive cycle in this repo, or asks whether their data determines the cell parameters.
---

# Fit battery data with autophys

Everything is in `examples/battery_fit/`: the script, `run.sh`, sample data
and expected output. Its README is the reference for inputs and output. It
runs locally with no network, accounts or API keys after setup. Python 3.10 or
newer is required.

## 1. Set up and check the install

```sh
examples/battery_fit/run.sh
```

The first run creates `examples/battery_fit/.venv` and installs the SDK and
matplotlib. It then fits `data/demo.csv` and writes `fit.png` to the current
directory. Compare the output with `examples/battery_fit/expected/demo.txt`:
chi2/N 0.99, with all three parameters identified near R0 = 0.025,
R1 = 0.045 and C1 = 1600. If it differs, stop and report it; don't go on to
real data.

## 2. Ask for what can't be inferred

Get these from the user before fitting, and don't guess them:

- **CSV columns** for time (s), current (A, positive = discharging) and
  voltage (V). Read the header and propose a `--columns time,current,voltage`
  mapping. Convert units first if the file uses ms, mA or mV.
- **Voltage noise sigma** (V) from the sensor or cycler spec. Never derive it
  from the fit residual, because that makes chi2/N meaningless.
- **Capacity** (Ah) and **starting SOC** (0 to 1).
- **OCV curve**, as a `soc,voltage` CSV, if they have one. Without it the
  script uses the generic NMC table in `data/ocv_generic.csv`. Say that this limits the result.

## 3. Fit

```sh
examples/battery_fit/run.sh CELL.csv --sigma S --capacity-ah Q --soc0 SOC \
  [--ocv OCV.csv] [--columns T,I,V] --out CELL.png
```

The script exits with a message if columns are missing or time doesn't
increase. Fix the input; don't edit around the check.

## 4. Report

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
  A perfect fit can leave R1 and C1 tied; `examples/battery_fit/data/short.csv` shows one.
- Present demo or synthetic results as measurements from a real cell.
- Change the ±10% identifiability rule, or the bounds in `make_model`, to get
  a nicer verdict without telling the user.

## Going further

- **A 2RC model or temperature dependence:** edit `make_model` in
  `examples/battery_fit/battery_fit.py`. It's an `@ap.simulator` function that returns
  `{"t": t, "v": volts}`.
- **The closed loop:** `examples/battery_fit/closed_loop.py`, run as
  `examples/battery_fit/run.sh agent ...`. Section 5 of the example README covers it.
  It proposes the next test from a fixed list of cycler programs
  (`./run.sh agent tests`), and a person approves it. Never approve a
  proposal on the user's behalf. `./run.sh agent approve` is for the user to
  run. `--simulate` data is synthetic, from a hidden demo cell: never present
  it as a measurement. Real data must follow the listed programs.
