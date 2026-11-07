# Fit a battery cell and see which parameters your data pins down (Rust)

This project was created by `autophys new --lang rust --example battery-fit`.
It is the Rust version of the Python battery template: it fits a first-order
(1RC) battery model to a time / current / voltage CSV and says which of R0,
R1 and C1 the data determines to better than ±10%. It prints the same report
as the Python version, and writes the measured and fitted curves to a CSV
instead of a plot. It runs locally, with no accounts, keys or network calls
after the first build.

```
.
├── README.md        this file
├── Cargo.toml       the autophys Rust SDK, pinned to one commit of its repository
├── src/main.rs      the model, fit and identifiability check
├── data/
│   ├── demo.csv     a made-up cell with a known answer: three pulses and rests, 2 mV noise
│   ├── short.csv    the first 64 s of demo.csv: one pulse with no rest after it
│   └── ocv_generic.csv  the default OCV table; use it as a template for your cell's own
└── expected/        what a correct run prints
    ├── demo.txt
    └── short.txt
```

You need Rust 1.85 or newer (the SDK uses the 2024 edition) and git, which
Cargo uses to fetch the SDK on the first build.

The `autophys` commands below assume the binary is on your PATH, from a
[release](https://github.com/yuzuquats/autophys/releases) or built from
source (or use its full path). The SDK dependency is a git URL on the public
GitHub repository, fetched over https with no credentials.

## 1. Run the demo

```sh
cargo run --release -- data/demo.csv
```

```
fit: chi2/N = 0.99 (converged; ~1 means the residuals match sigma)
  R0  = 0.024857 ohm       ±0.4%  identified
  R1  = 0.045448 ohm       ±0.4%  identified
  C1  = 1589.3 F         ±0.7%  identified

curve: fit.csv (demo.csv: measured, fitted and residual by time)
```

The demo cell's true values are R0 = 0.025 Ω, R1 = 0.045 Ω and C1 = 1600 F.
`fit.csv` has the columns `time,current,voltage,fitted,residual_mV`; plot
`voltage` and `fitted` against `time` with any tool.

## 2. See what the identifiability check adds

```sh
cargo run --release -- data/short.csv --out short.csv
```

```
  R0  = 0.024773 ohm       ±0.8%  identified
  R1  = 0.042943 ohm   unbounded  NOT identified
  C1  = 1556.9 F     unbounded  NOT identified
  tied: R1^1 * C1^0.28 (practical)
```

One pulse without the relaxation after it can't separate R1 from C1; only a
combination of them is fixed. A good-looking fit alone would not tell you
that.

## 3. Fit your own cell

```sh
cargo run --release -- /path/to/my_cell.csv --sigma 0.002 --capacity-ah 2.5 \
  --soc0 0.9 --ocv /path/to/my_ocv.csv --out my_cell.csv
```

| Input | What to give | Default |
| --- | --- | --- |
| CSV | a header row, then time (s, strictly increasing), current (A, **positive = discharging**) and terminal voltage (V) | n/a |
| `--columns` | your header names for time, current and voltage, comma-separated | `time,current,voltage` |
| `--sigma` | voltage noise standard deviation (V), from the sensor or cycler spec, **not** from the fit residual | 0.002 |
| `--capacity-ah` | cell capacity (Ah) | 2.5 |
| `--soc0` | state of charge at t = 0, from 0 to 1 | 0.9 |
| `--ocv` | `soc,voltage` CSV of your cell's open-circuit voltage, like `data/ocv_generic.csv` | the generic NMC-like table |
| `--out` | where to write the curve CSV | `fit.csv` |

**Reading the result:** chi2/N near 1 means the residuals match your stated
noise. **identified** means the data pins that parameter to better than ±10%,
from a sensitivity (log-Jacobian SVD) analysis at the fit. **NOT identified**
and **tied** mean the data fixes only the printed combination; the test
usually needs a longer rest after a pulse, or pulses at different currents.
**at bounds** means the fit hit a parameter's limit: check units, or widen the
bounds in `make_model`.

## The model

`make_model` in `src/main.rs`: V = OCV(SOC) − V1 − I·R0, with the RC branch
updated exactly for a current held constant between samples. It performs the
same arithmetic, in the same order, as the Python template, so both fit the
same numbers. `cargo run --release -- --demo data/demo.csv` regenerates the
demo file byte for byte.

## Recording investigations

To record investigations on an autophys server, connect this device once with
`autophys connect URL`; the SDK's `autophys::connect(Some(URL))` then finds
the saved key. Proposals are approved in the browser or with
`autophys approve`, and `autophys investigations` lists them.
