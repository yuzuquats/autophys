//! Fit a first-order battery model to your own pulse data, and say which
//! parameters the data pins down.
//!
//!     cargo run --release -- data/demo.csv                  # synthetic cell, known answer
//!     cargo run --release -- my_cell.csv --sigma 0.002 --ocv my_ocv.csv
//!     cargo run --release -- --demo                          # regenerate demo.csv
//!
//! The CSV needs time (s), current (A, positive = discharging) and voltage (V)
//! columns. Any current trace works: pulses, rests, drive cycles. The model is
//!
//!     V = OCV(SOC) - V1 - I*R0,   dV1/dt = -V1/(R1*C1) + I/C1,   dSOC/dt = -I/(3600*Q)
//!
//! with Q, the starting SOC and the OCV curve known, and R0, R1, C1 fitted.
//! autophys then says which of the three your data actually pins down (better
//! than ±10%), and which are traded off against each other. The measured and
//! fitted curves are written to a CSV (`--out`, default fit.csv) for plotting.
//!
//! This is the Rust port of the Python template's `battery_fit.py`; both print
//! the same report.
use std::error::Error;
use std::path::Path;

use autophys::data::Observation;
use autophys::fit::{FitOptions, fit};
use autophys::models::battery::{OCV_SOC, OCV_V};
use autophys::sensitivity::analyze;
use autophys::simulator::{
    FIT_OPTIONS, FunctionSimulator, ParamSpec, Params, SimulationError, Simulator, simulator,
};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Used only by `--demo`.
const TRUTH: [(&str, f64); 3] = [("R0", 0.025), ("R1", 0.045), ("C1", 1600.0)];

const USAGE: &str = "usage: battery-fit [CSV] [--demo] [--sigma V] [--capacity-ah AH] [--soc0 SOC]
                   [--ocv OCV.csv] [--columns time,current,voltage] [--out fit.csv]";

struct Args {
    csv: Option<String>,
    demo: bool,
    sigma: f64,
    capacity_ah: f64,
    soc0: f64,
    ocv: Option<String>,
    columns: String,
    out: String,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        csv: None,
        demo: false,
        sigma: 0.002,
        capacity_ah: 2.5,
        soc0: 0.9,
        ocv: None,
        columns: "time,current,voltage".into(),
        out: "fit.csv".into(),
    };
    let mut words = std::env::args().skip(1);
    while let Some(word) = words.next() {
        let (flag, inline) = match word.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (word.clone(), None),
        };
        let mut value = |name: &str| -> Result<String> {
            inline
                .clone()
                .or_else(|| words.next())
                .ok_or_else(|| format!("{name} needs a value\n{USAGE}").into())
        };
        match flag.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "--demo" => args.demo = true,
            "--sigma" => args.sigma = value("--sigma")?.parse()?,
            "--capacity-ah" => args.capacity_ah = value("--capacity-ah")?.parse()?,
            "--soc0" => args.soc0 = value("--soc0")?.parse()?,
            "--ocv" => args.ocv = Some(value("--ocv")?),
            "--columns" => args.columns = value("--columns")?,
            "--out" => args.out = value("--out")?,
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other}\n{USAGE}").into());
            }
            _ if args.csv.is_none() => args.csv = Some(word),
            _ => return Err(format!("unexpected argument {word}\n{USAGE}").into()),
        }
    }
    Ok(args)
}

/// A header row, then comma-separated numbers; returns the named columns.
fn read_columns(path: &str, columns: &[&str]) -> Result<Vec<Vec<f64>>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let header: Vec<&str> = lines
        .next()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .collect();
    let missing: Vec<&str> = columns
        .iter()
        .copied()
        .filter(|c| !header.contains(c))
        .collect();
    let index: Vec<usize> = columns
        .iter()
        .filter_map(|c| header.iter().position(|h| h == c))
        .collect();
    let mut out = vec![Vec::new(); columns.len()];
    for (row, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').map(str::trim).collect();
        for (k, &i) in index.iter().enumerate() {
            let cell = cells.get(i).copied().unwrap_or("");
            out[k].push(
                cell.parse()
                    .map_err(|_| format!("{path}: row {}: {cell:?} is not a number", row + 2))?,
            );
        }
    }
    if !missing.is_empty() || out[0].is_empty() {
        let missing = if missing.is_empty() {
            "all rows".to_string()
        } else {
            format!("{missing:?}")
        };
        return Err(format!("{path}: need columns {columns:?}; missing {missing}").into());
    }
    Ok(out)
}

/// A soc,voltage CSV for your cell; default: a generic NMC-like table.
fn load_ocv(path: Option<&str>) -> Result<(Vec<f64>, Vec<f64>)> {
    let Some(path) = path else {
        return Ok((OCV_SOC.to_vec(), OCV_V.to_vec()));
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut rows: Vec<(f64, f64)> = Vec::new();
    for line in text
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        let (soc, volts) = line
            .split_once(',')
            .ok_or_else(|| format!("{path}: need soc,voltage rows"))?;
        rows.push((soc.trim().parse()?, volts.trim().parse()?));
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(rows.into_iter().unzip())
}

/// NumPy's `interp`: linear inside the table, clamped to its end values outside.
fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    let n = xp.len();
    if x <= xp[0] {
        return fp[0];
    }
    if x >= xp[n - 1] {
        return fp[n - 1];
    }
    let j = xp.partition_point(|v| *v <= x) - 1;
    let slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    slope * (x - xp[j]) + fp[j]
}

fn numbers(experiment: &Value, key: &str) -> std::result::Result<Vec<f64>, SimulationError> {
    serde_json::from_value(experiment[key].clone())
        .map_err(|e| SimulationError::Invalid(format!("experiment {key}: {e}")))
}

/// 1RC cell driven by a measured current trace (zero-order hold, exact update).
fn make_model(ocv_soc: Vec<f64>, ocv_v: Vec<f64>) -> Result<FunctionSimulator> {
    let params = vec![
        ParamSpec::new("R0", "ohm", 1e-3, 0.5)?,
        ParamSpec::new("R1", "ohm", 1e-3, 0.5)?,
        ParamSpec::new("C1", "F", 10.0, 1e5)?,
    ];
    let model = simulator(
        "battery_1rc_measured_current",
        params,
        Default::default(),
        vec!["v".into()],
        include_str!("main.rs"),
        move |p, experiment, _options| {
            let t = numbers(experiment, "t")?;
            let i = numbers(experiment, "i")?;
            let soc0 = experiment["soc0"].as_f64().unwrap_or(0.9);
            let capacity = experiment["capacity_ah"].as_f64().unwrap_or(2.5);
            let (r0, r1, c1) = (p["R0"], p["R1"], p["C1"]);
            let mut v = Vec::with_capacity(t.len());
            // The same operations, in the same order, as the Python template's
            // NumPy model, so both print the same fit.
            let (mut charge, mut v1) = (0.0, 0.0);
            for k in 0..t.len() {
                if k > 0 {
                    let dt = t[k] - t[k - 1];
                    charge += i[k - 1] * dt;
                    let decay = (-dt / (r1 * c1)).exp();
                    v1 = v1 * decay + r1 * (1.0 - decay) * i[k - 1];
                }
                let soc = soc0 - charge / (3600.0 * capacity);
                v.push(interp(soc, &ocv_soc, &ocv_v) - v1 - i[k] * r0);
            }
            Ok([("t".to_string(), t), ("v".to_string(), v)]
                .into_iter()
                .collect())
        },
    )?;
    Ok(model)
}

fn settings(t: &[f64], i: &[f64], capacity_ah: f64, soc0: f64) -> Value {
    json!({"kind": "measured", "t": t, "i": i, "capacity_ah": capacity_ah, "soc0": soc0})
}

/// Python's float repr for the values this file writes.
fn py_float(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e16 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

/// A made-up test: two discharge pulses, a charge pulse and rests, with sensor
/// noise. Byte for byte the file the Python template writes (`csv` module
/// line endings included).
fn write_demo(
    path: &str,
    model: &FunctionSimulator,
    sigma: f64,
    capacity_ah: f64,
    soc0: f64,
) -> Result<()> {
    let t: Vec<f64> = (0..1800).map(|k| k as f64 * 0.5).collect();
    let i: Vec<f64> = t
        .iter()
        .map(|&t| match t {
            t if (30.0..60.0).contains(&t) => 2.0,
            t if (300.0..420.0).contains(&t) => 1.0,
            t if (600.0..630.0).contains(&t) => -1.5,
            _ => 0.0,
        })
        .collect();
    let truth: Params = TRUTH.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let v = model.simulate(&truth, &settings(&t, &i, capacity_ah, soc0), FIT_OPTIONS)?["v"].clone();
    let mut rng = autophys::fit::rng::NumpyRng::new(0);
    let mut text = String::from("time,current,voltage\r\n");
    for k in 0..t.len() {
        let noisy = v[k] + sigma * rng.normal();
        let rounded = (noisy * 1e5).round_ties_even() / 1e5;
        text.push_str(&format!(
            "{},{},{}\r\n",
            py_float(t[k]),
            py_float(i[k]),
            py_float(rounded)
        ));
    }
    std::fs::write(path, text)?;
    println!(
        "wrote {path}: {} samples, true R0={} R1={} C1={}",
        t.len(),
        TRUTH[0].1,
        TRUTH[1].1,
        py_float(TRUTH[2].1)
    );
    Ok(())
}

/// Python's `format(v, ".5g")`.
fn g5(v: f64) -> String {
    const P: i32 = 5;
    if !v.is_finite() {
        return format!("{v}");
    }
    let sci = format!("{:.*e}", (P - 1) as usize, v);
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let trim = |s: &str| {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            s.to_string()
        }
    };
    if (-4..P).contains(&exp) {
        trim(&format!("{:.*}", (P - 1 - exp) as usize, v))
    } else {
        format!(
            "{}e{}{:02}",
            trim(mantissa),
            if exp < 0 { '-' } else { '+' },
            exp.abs()
        )
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let (ocv_soc, ocv_v) = load_ocv(args.ocv.as_deref())?;
    let model = make_model(ocv_soc, ocv_v)?;
    let mut path = args.csv.clone();
    if args.demo {
        let demo = path.get_or_insert_with(|| "demo.csv".into());
        write_demo(demo, &model, args.sigma, args.capacity_ah, args.soc0)?;
    }
    let path = path.ok_or_else(|| format!("give a CSV path, or --demo\n{USAGE}"))?;

    let columns: Vec<&str> = args.columns.split(',').collect();
    if columns.len() != 3 {
        return Err("--columns needs three names: time,current,voltage".into());
    }
    let mut data = read_columns(&path, &columns)?.into_iter();
    let (t, i, v) = (
        data.next().unwrap(),
        data.next().unwrap(),
        data.next().unwrap(),
    );
    if t.windows(2).any(|w| w[1] <= w[0]) {
        return Err(format!("{path}: time must strictly increase").into());
    }
    let settings = settings(&t, &i, args.capacity_ah, args.soc0);
    let obs = Observation::new(
        "measured",
        settings.clone(),
        t.clone(),
        [("v".to_string(), v.clone())].into_iter().collect(),
        [("v".to_string(), args.sigma)].into_iter().collect(),
    )?;
    let observations = [obs];

    let fitted = fit(
        &model,
        &observations,
        &FitOptions {
            n_starts: 8,
            ..Default::default()
        },
    )?;
    let (report, _) = analyze(
        &model,
        &fitted.params,
        &observations,
        Default::default(),
        None,
    )?;
    let v_fit = model.simulate(&fitted.params, &settings, FIT_OPTIONS)?["v"].clone();

    println!(
        "\nfit: chi2/N = {:.2} ({}; ~1 means the residuals match sigma)",
        fitted.chi2_per_n,
        if fitted.success {
            "converged"
        } else {
            "NOT converged"
        }
    );
    for (name, spec) in model.params() {
        let log_std = report.marginal_log_std[name];
        let spread = if log_std < 10f64.ln() {
            format!("±{:.1}%", 100.0 * log_std.exp_m1())
        } else {
            "unbounded".into()
        };
        let verdict = if report.identified.contains(name) {
            "identified"
        } else {
            "NOT identified"
        };
        println!(
            "  {name:3} = {} {:4}  {spread:>9}  {verdict}",
            g5(fitted.params[name]),
            spec.unit
        );
    }
    for d in report.non_identifiable_directions() {
        println!("  tied: {} ({})", d.combination, d.kind);
    }
    if !fitted.at_bounds.is_empty() {
        println!(
            "  at bounds: {}: widen the range or check units",
            fitted.at_bounds.join(", ")
        );
    }

    let mut curve = String::from("time,current,voltage,fitted,residual_mV\n");
    for k in 0..t.len() {
        curve.push_str(&format!(
            "{},{},{},{},{}\n",
            t[k],
            i[k],
            v[k],
            v_fit[k],
            (v[k] - v_fit[k]) * 1e3
        ));
    }
    std::fs::write(&args.out, curve).map_err(|e| format!("{}: {e}", args.out))?;
    let name = Path::new(&path)
        .file_name()
        .map_or(path.clone(), |n| n.to_string_lossy().into_owned());
    println!(
        "\ncurve: {} ({name}: measured, fitted and residual by time)",
        args.out
    );
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
