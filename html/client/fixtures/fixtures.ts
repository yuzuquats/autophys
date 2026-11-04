/**
 * The fixture workspace: three projects, four investigations, every number computed from a
 * seeded simulation in this browser (noisy measurements, multistart fits, Fisher sensitivity,
 * landscapes, experiment ranking). Deterministic: the same build every time. It stands in for
 * what the SDK uploads and the daemon will serve; no request is made.
 */
import { configOf, sigmaOf, sineLabel, specOf } from "../config.ts";
import { applyDisplay } from "../wire.ts";
import type {
  FrequencyResponse, GainPhase,
  ExperimentSpec, Fit, Investigation, Landscape, Measurement, Project, ProjectConfig, Proposal, RankedCandidate, SensitivityResult, Validation, Workspace,
} from "../domain.ts";
import {
  comboStd, eigSym, type ExperimentKind, fisher, type FitRun, gaussian, inputSeries, jacobian, levenberg, marginalUnder, mulberry32, type Params, type Problem, score, sensitivity,
  type Settings, simulate, solveLinear, timeGrid,
} from "./sim.ts";

export const USER = "james";

// ------------------------------------------------------------------------ configs

/** FNV-1a 64 over the canonical JSON, as 16 hex digits (the SDK uses sha256; same role). */
export function configHash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, "0");
}

function versioned(config: Omit<ProjectConfig, "hash">): ProjectConfig {
  return { ...config, hash: configHash(config) };
}

/**
 * A fixture's display manifest (format 1, as the SDK uploads it), applied by the live path
 * (wire.ts applyDisplay) after hashing: presentation is never part of a config's identity.
 * Previews are each experiment's input at its defaults, 64 points over `span` seconds.
 */
type FixtureDisplay = {
  channels: Record<string, { label: string; unit: string; role: "input" | "output" }>;
  params: Record<string, { label?: string; description: string }>;
  settings: Record<string, { label: string; unit: string; role: "drive" | "sampling" | "known" }>;
  experiments: Record<string, { label: string; description?: string; views: string[]; span?: number; extra?: Settings }>;
};
function displayed(config: ProjectConfig, d: FixtureDisplay): ProjectConfig {
  const input = Object.keys(d.channels).find((k) => d.channels[k].role === "input")!;
  const experiments = Object.fromEntries(config.catalog.map((e) => {
    const m = d.experiments[e.id], defaults = Object.fromEntries(e.settings.map((s) => [s.name, s.default]));
    const t = m.span ? Array.from({ length: 64 }, (_, i) => i * m.span! / 63) : [];
    const u = m.span ? inputSeries(e.id, { ...defaults, ...m.extra }, t) : null;
    return [e.id, { label: m.label, description: m.description ?? "", views: m.views, ...(u ? { preview: { t, u: { [input]: u } } } : {}) }];
  }));
  return applyDisplay(config, { format: 1, simulator: config.simulator.name, channels: d.channels, params: d.params, settings: d.settings, experiments });
}

const OSC_DISPLAY: FixtureDisplay = {
  channels: { force: { label: "Force", unit: "N", role: "input" }, x: { label: "Displacement", unit: "m", role: "output" } },
  params: { m: { description: "moving mass" }, c: { description: "damping coefficient" }, k: { description: "spring stiffness" } },
  settings: {
    amplitude: { label: "Amplitude", unit: "N", role: "drive" }, frequency: { label: "Frequency", unit: "Hz", role: "drive" },
    force: { label: "Force", unit: "N", role: "drive" }, width: { label: "Pulse width", unit: "s", role: "drive" },
    duration: { label: "Duration", unit: "s", role: "sampling" }, rate: { label: "Rate", unit: "Hz", role: "sampling" },
    x0: { label: "Initial displacement", unit: "m", role: "known" },
  },
  experiments: {
    free_response: { label: "Free response", description: "Released from the initial displacement and left to ring down.", views: ["envelope"] },
    impulse: { label: "Impulse", description: "A short force pulse; its width sets the momentum delivered.", views: ["envelope"], span: 1 },
    step: { label: "Step force", description: "A constant force from the start of the record.", views: [] },
    sine: { label: "Sine force", views: ["spectrum"], span: 5 },
  },
};
const CELL_DISPLAY: FixtureDisplay = {
  channels: { current: { label: "Current", unit: "A", role: "input" }, v: { label: "Terminal voltage", unit: "V", role: "output" } },
  params: { R0: { label: "R₀", description: "ohmic resistance" }, R1: { label: "R₁", description: "polarisation resistance" }, C1: { label: "C₁", description: "polarisation capacitance" } },
  settings: {
    current: { label: "Current", unit: "A", role: "drive" }, on: { label: "On time", unit: "s", role: "drive" },
    off: { label: "Rest time", unit: "s", role: "drive" }, cycles: { label: "Cycles", unit: "", role: "drive" },
  },
  experiments: { pulse_train: { label: "Current pulses", description: "Square current pulses with a rest after each.", views: ["edges"], span: 400, extra: { start: 10 } } },
};
const HEAT_DISPLAY: FixtureDisplay = {
  channels: { power: { label: "Heater power", unit: "W", role: "input" }, T: { label: "Temperature", unit: "°C", role: "output" } },
  params: { R: { description: "thermal resistance to ambient" }, C: { description: "heat capacity" }, bias: { description: "sensor offset" } },
  settings: {
    power: { label: "Power", unit: "W", role: "drive" }, on_at: { label: "Heater on at", unit: "s", role: "drive" },
    off_at: { label: "Heater off at", unit: "s", role: "drive" },
  },
  experiments: { power_step: { label: "Power step", description: "The heater is switched on, held, then switched off.", views: [], span: 2400 } },
};

const force = { name: "force", label: "force", unit: "N" };
const position = { name: "x", label: "x", unit: "m" };
const sineSpec: ExperimentSpec = {
  id: "sine", label: "Sine force", input: force, output: position, maxRuns: 3, viewHints: ["frequency"],
  settings: [
    { name: "amplitude", label: "Amplitude", unit: "N", lo: 0.1, hi: 5, default: 2 },
    { name: "frequency", label: "Frequency", unit: "Hz", lo: 0.05, hi: 5, default: 0.44 },
    { name: "duration", label: "Duration", unit: "s", lo: 2, hi: 60, default: 10 },
    { name: "rate", label: "Rate", unit: "Hz", lo: 10, hi: 1000, default: 100 },
  ],
};
const oscCatalog = (impulse: boolean): ExperimentSpec[] => [
  { id: "free_response", label: "Free response", input: null, output: position, maxRuns: 2, viewHints: ["envelope"],
    settings: [{ name: "x0", label: "Initial x₀", unit: "m", lo: 0.1, hi: 2, default: 1 }] },
  ...(impulse ? [{ id: "impulse" as const, label: "Impulse", input: force, output: position, maxRuns: 2, viewHints: ["envelope" as const],
    settings: [{ name: "force", label: "Force", unit: "N", lo: 0.5, hi: 10, default: 5 }, { name: "width", label: "Width", unit: "s", lo: 0.01, hi: 0.5, default: 0.1 }] }] : []),
  { id: "step", label: "Step force", input: force, output: position, maxRuns: 2, viewHints: [],
    settings: [{ name: "force", label: "Force", unit: "N", lo: 0.1, hi: 5, default: 2 }] },
  sineSpec,
];

const oscBase = {
  simulator: { kind: "oscillator" as const, name: "oscillator", version: "0.1", sourceHash: "9c41e2a07d55" },
  params: [
    { name: "m", unit: "kg", lo: 0.5, hi: 4, initial: 1, fixed: false, coord: "log" as const },
    { name: "c", unit: "N·s/m", lo: 0.05, hi: 3, initial: 0.3, fixed: false, coord: "log" as const },
    { name: "k", unit: "N/m", lo: 4, hi: 30, initial: 9, fixed: false, coord: "log" as const },
  ],
  noise: { sigma: { x: 0.01 }, estimate: false, bias: "off" as const },
  policy: { kind: "reason-lane" as const, effort: "low", label: "reason lane · Spark" },
  combinations: [{ name: "k/m", exponents: { k: 1, m: -1 } }, { name: "c/m", exponents: { c: 1, m: -1 } }] as ProjectConfig["combinations"],
  landscape: { x: "m", y: "k", held: "c/m" },
};
const OSC_V1 = displayed(versioned({ version: 1, ...oscBase, catalog: oscCatalog(false), budgets: { maxSteps: 20, maxSimulations: 4000, maxExperiments: 2 } }), OSC_DISPLAY);
const OSC_V2 = displayed(versioned({ version: 2, ...oscBase, catalog: oscCatalog(true), budgets: { maxSteps: 20, maxSimulations: 4000, maxExperiments: 3 } }), OSC_DISPLAY);

const CELL_V1 = displayed(versioned({
  version: 1,
  simulator: { kind: "thevenin", name: "thevenin", version: "0.3", sourceHash: "4be07f31c2a9" },
  params: [
    { name: "R0", unit: "Ω", lo: 0.005, hi: 0.2, initial: 0.05, fixed: false, coord: "log" },
    { name: "R1", unit: "Ω", lo: 0.005, hi: 0.2, initial: 0.05, fixed: false, coord: "log" },
    { name: "C1", unit: "F", lo: 100, hi: 20000, initial: 1000, fixed: false, coord: "log" },
  ],
  catalog: [
    { id: "pulse_train", label: "Current pulses", input: { name: "current", label: "current", unit: "A" }, output: { name: "v", label: "voltage", unit: "V" }, maxRuns: 3, viewHints: ["zoom:edges"],
      settings: [{ name: "current", label: "Current", unit: "A", lo: 1, hi: 20, default: 10 }, { name: "on", label: "On", unit: "s", lo: 5, hi: 120, default: 30 },
        { name: "off", label: "Off", unit: "s", lo: 5, hi: 300, default: 60 }, { name: "cycles", label: "Cycles", unit: "", lo: 1, hi: 10, default: 4 }] },
  ],
  noise: { sigma: { v: 0.002 }, estimate: true, bias: "off" },
  budgets: { maxSteps: 40, maxSimulations: 6000, maxExperiments: 3 },
  policy: { kind: "scripted", effort: null, label: "scripted" },
  combinations: [{ name: "τ = R1·C1", exponents: { R1: 1, C1: 1 } }],
  landscape: { x: "R1", y: "C1", held: "R0" },
}), CELL_DISPLAY);

const HEAT_V1 = displayed(versioned({
  version: 1,
  simulator: { kind: "thermal", name: "thermal-rc", version: "0.2", sourceHash: "e17a5d90b4c3" },
  params: [
    { name: "R", unit: "K/W", lo: 0.5, hi: 10, initial: 1.5, fixed: false, coord: "log" },
    { name: "C", unit: "J/K", lo: 50, hi: 2000, initial: 250, fixed: false, coord: "log" },
    { name: "bias", unit: "K", lo: -2, hi: 2, initial: 0, fixed: false, coord: "linear" },
  ],
  catalog: [
    { id: "power_step", label: "Power step", input: { name: "power", label: "power", unit: "W" }, output: { name: "T", label: "temperature", unit: "°C" }, maxRuns: 4, viewHints: [],
      settings: [{ name: "power", label: "Power", unit: "W", lo: 1, hi: 40, default: 10 }, { name: "on_at", label: "On at", unit: "s", lo: 0, hi: 600, default: 60 },
        { name: "off_at", label: "Off at", unit: "s", lo: 60, hi: 7200, default: 1860 }] },
  ],
  noise: { sigma: { T: 0.05 }, estimate: false, bias: "compare" },
  budgets: { maxSteps: 24, maxSimulations: 8000, maxExperiments: 3 },
  policy: { kind: "reason-lane", effort: "low", label: "reason lane · Spark" },
  combinations: [{ name: "τ = R·C", exponents: { R: 1, C: 1 } }],
  landscape: { x: "R", y: "C", held: "bias" },
}), HEAT_DISPLAY);

// ------------------------------------------------------------------------ builders


function measure(config: ProjectConfig, truth: Params, id: string, kind: ExperimentKind, settings: Settings, duration: number, rate: number,
  seed: number, split: "train" | "test", at: string, missing: number[] = []): Measurement {
  const t = timeGrid(duration, rate), clean = simulate(config.simulator.kind, truth, kind, settings, t);
  const g = gaussian(mulberry32(seed)), sigma = sigmaOf(config);
  const output = clean.map((v, i) => (missing.includes(i) ? NaN : v + sigma * g()));
  return { id, experiment: kind, settings, split, uploadedAt: at, source: "laptop", rate, t, input: inputSeries(kind, settings, t), output, sigmaEstimate: noiseEstimate(output) };
}

/** σ from first differences (robust to a slow signal): std(Δy)/√2 over finite pairs. */
export function noiseEstimate(y: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < y.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(y[i - 1])) d.push(y[i] - y[i - 1]);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  return Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, d.length - 1) / 2);
}

export function problemOf(config: ProjectConfig, ms: Measurement[], free: string[], fixed: Params): Problem {
  const sigma = sigmaOf(config), coord: Problem["coord"] = {}, lo: Params = {}, hi: Params = {};
  for (const p of config.params) { coord[p.name] = p.coord; lo[p.name] = p.lo; hi[p.name] = p.hi; }
  return {
    names: free, coord, lo, hi, fixed,
    residuals: (p) => {
      const r: number[] = [];
      for (const m of ms) {
        const f = simulate(config.simulator.kind, p, m.experiment, m.settings, m.t);
        for (let i = 0; i < f.length; i++) if (Number.isFinite(m.output[i])) r.push((m.output[i] - f[i]) / sigma);
      }
      return r;
    },
  };
}

export function lag1(m: Measurement, f: number[]): number {
  const r = m.output.map((y, i) => y - f[i]).filter(Number.isFinite);
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  let num = 0, den = 0;
  for (let i = 0; i < r.length; i++) { den += (r[i] - mean) ** 2; if (i) num += (r[i] - mean) * (r[i - 1] - mean); }
  return den > 0 ? num / den : 0;
}

function sensitivityAt(config: ProjectConfig, pr: Problem, p: Params): SensitivityResult {
  const s = sensitivity(fisher(jacobian(pr, p).J), pr.names);
  const combos: SensitivityResult["combos"] = [];
  if (s.nonIdentified.length) {
    for (const c of config.combinations) {
      if (!Object.keys(c.exponents).every((k) => pr.names.includes(k))) continue;
      const std = comboStd(s, c.exponents);
      if (std != null) combos.push({ name: c.name, value: Object.entries(c.exponents).reduce((v, [k, a]) => v * p[k] ** a, 1), logStd: std });
    }
  }
  return { ...s, combos };
}

type FitPlan = { n: number; measurements: string[]; free: string[]; fixed?: Params; variant?: string | null; starts?: number; maxIter?: number; running?: boolean; start?: Params; seed: number };

function fitOf(config: ProjectConfig, inv: { measurements: Measurement[] }, plan: FitPlan): Fit {
  const ms = plan.measurements.map((id) => inv.measurements.find((m) => m.id === id)!);
  const fixed = plan.fixed ?? {};
  const pr = problemOf(config, ms, plan.free, fixed);
  const initial: Params = { ...fixed };
  for (const p of config.params) if (plan.free.includes(p.name)) initial[p.name] = plan.start?.[p.name] ?? p.initial;
  // Multistart: the declared initial guess, then seeded log-uniform jitters around it.
  const rnd = mulberry32(plan.seed), runs: FitRun[] = [];
  const starts = plan.starts ?? 4;
  for (let s = 0; s < starts; s++) {
    const st: Params = { ...initial };
    if (s > 0) for (const k of plan.free) st[k] = config.params.find((q) => q.name === k)!.coord === "log" ? initial[k] * Math.exp((rnd() - 0.5) * 1.2) : initial[k] + (rnd() - 0.5);
    runs.push(levenberg(pr, st, plan.maxIter ?? 60));
  }
  // Report the run from the declared initial guess when it reached the best basin, so the
  // trail on the landscape starts where the configuration says; otherwise the best run.
  const lowest = runs.reduce((a, b) => (b.cost < a.cost ? b : a));
  const best = Math.abs(runs[0].cost - lowest.cost) <= 1e-3 * Math.max(lowest.cost, 1) ? runs[0] : lowest;
  const levels: number[] = [];
  for (const r of runs) if (!levels.some((c) => Math.abs(c - r.cost) <= 1e-3 * Math.max(c, 1))) levels.push(r.cost);
  const lagOf: Record<string, number> = {};
  const curves: Fit["curves"] = {};
  // Display curves include held-out measurements, as an SDK run payload does.
  for (const m of inv.measurements) {
    const fit = simulate(config.simulator.kind, best.params, m.experiment, m.settings, m.t);
    curves[m.id] = { fit, initial: simulate(config.simulator.kind, initial, m.experiment, m.settings, m.t) };
    lagOf[m.id] = lag1(m, fit);
  }
  return {
    n: plan.n, state: plan.running ? "running" : "converged", variant: plan.variant ?? null, measurements: plan.measurements, free: plan.free, fixed,
    initial, params: best.params, chi2N: best.cost / best.n, evals: runs.reduce((s, r) => s + r.evals, 0), starts, basins: levels.length,
    loss: "linear", lag1: lagOf, trail: best.trail, sensitivity: plan.running ? null : sensitivityAt(config, pr, best.params), landscape: null, curves,
    frequency: plan.running ? null : frequencyOf(config, ms, best.params, initial), seed: plan.seed,
  };
}

/** Gain and phase of a sine run at its drive frequency, by least squares over its second half. */
export function sinePoint(m: Pick<Measurement, "t" | "output" | "settings">): GainPhase & { frequency: number } {
  const w = 2 * Math.PI * m.settings.frequency, half = Math.floor(m.t.length / 2);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (let i = half; i < m.t.length; i++) {
    const y = m.output[i];
    if (!Number.isFinite(y)) continue;
    const row = [Math.sin(w * m.t[i]), Math.cos(w * m.t[i]), 1];
    for (let r = 0; r < 3; r++) { b[r] += row[r] * y; for (let c = 0; c < 3; c++) A[r][c] += row[r] * row[c]; }
  }
  const [a, bb] = solveLinear(A, b) ?? [0, 0];
  return { frequency: m.settings.frequency, gain: Math.hypot(a, bb) / m.settings.amplitude, phase: (Math.atan2(bb, a) * 180) / Math.PI };
}

/** The steady-state response the fit implies, simulated at each frequency and read like the data. */
function frequencyOf(config: ProjectConfig, ms: Measurement[], params: Params, initial: Params): FrequencyResponse | null {
  const sines = ms.filter((m) => m.experiment === "sine");
  if (!sines.length) return null;
  const amplitude = sines[0].settings.amplitude;
  const frequencies = Array.from({ length: 81 }, (_, i) => 0.05 * 100 ** (i / 80));
  const curve = (p: Params) => frequencies.map((f) => {
    // At least a minute and 12 periods, so the start-up transient has faded by the second half sinePoint reads.
    const t = timeGrid(Math.max(60, 12 / f), Math.max(20, 20 * f)), settings = { amplitude, frequency: f, x0: 0 };
    const { gain, phase } = sinePoint({ t, settings, output: simulate(config.simulator.kind, p, "sine", settings, t) });
    return { gain, phase };
  });
  return { frequencies, fit: curve(params), initial: curve(initial), points: sines.map((m) => ({ measurement: m.id, ...sinePoint(m) })) };
}

/** χ²/N over a grid of the config's landscape pair, the other parameters held as the config says. */
export function landscapeOf(config: ProjectConfig, ms: Measurement[], fit: Fit, size = 32): Landscape {
  const { x, y, held } = config.landscape, kind = config.simulator.kind, sigma = sigmaOf(config);
  const spec = (n: string) => config.params.find((p) => p.name === n)!;
  const log = kind !== "oscillator";
  const axis = (n: string) => Array.from({ length: size + 1 }, (_, i) => log ? spec(n).lo * (spec(n).hi / spec(n).lo) ** (i / size) : spec(n).lo + (spec(n).hi - spec(n).lo) * (i / size));
  const xs = axis(x), ys = axis(y);
  const nTotal = ms.reduce((s, m) => s + m.output.filter(Number.isFinite).length, 0);
  const sumSq = (p: Params, m: Measurement) => {
    const f = simulate(kind, p, m.experiment, m.settings, m.t);
    let s = 0;
    for (let i = 0; i < f.length; i++) if (Number.isFinite(m.output[i])) s += ((m.output[i] - f[i]) / sigma) ** 2;
    return s;
  };
  const chi2: number[] = [];
  if (kind === "oscillator") {
    // Free response depends on k/m and c/m only; with c/m held, tabulate it over r = k/m and take the
    // best value inside each cell, so a ridge thinner than a cell is not lost (page.html).
    const ratio = fit.params.c / fit.params.m;
    const free = ms.filter((m) => m.experiment === "free_response"), other = ms.filter((m) => m.experiment !== "free_response");
    const r0 = ys[0] / xs[size], r1 = ys[size] / xs[0], NR = 900;
    const rs = Array.from({ length: NR }, (_, q) => r0 * (r1 / r0) ** (q / (NR - 1)));
    const table = rs.map((r) => free.reduce((s, m) => s + sumSq({ m: 1, c: ratio, k: r }, m), 0));
    const idx = (r: number) => Math.max(0, Math.min(NR - 1, Math.round((Math.log(r / r0) / Math.log(r1 / r0)) * (NR - 1))));
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        let best = Infinity;
        for (let q = idx(ys[j] / xs[i + 1]); q <= idx(ys[j + 1] / xs[i]); q++) best = Math.min(best, table[q]);
        const m = (xs[i] + xs[i + 1]) / 2, k = (ys[j] + ys[j + 1]) / 2;
        const rest = other.reduce((s, ms1) => s + sumSq({ m, c: ratio * m, k }, ms1), 0);
        chi2.push((best + rest) / nTotal);
      }
    }
  } else {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const p: Params = { ...fit.params, [x]: Math.sqrt(xs[i] * xs[i + 1]), [y]: Math.sqrt(ys[j] * ys[j + 1]) };
        chi2.push(ms.reduce((s, m) => s + sumSq(p, m), 0) / nTotal);
      }
    }
  }
  return { x, y, held, xs, ys, chi2, log };
}

/** Fisher information of one candidate experiment at `p`, in the fit's coordinates. */
export function experimentFisher(config: ProjectConfig, p: Params, names: string[], kind: ExperimentKind, settings: Settings, duration: number, rate: number): number[][] {
  const t = timeGrid(duration, rate), probe: Measurement = {
    id: "candidate", experiment: kind, settings, split: "train", uploadedAt: "", source: "", rate, t, input: null,
    output: simulate(config.simulator.kind, p, kind, settings, t), sigmaEstimate: 0,
  };
  return fisher(jacobian(problemOf(config, [probe], names, p), p).J);
}

export type Candidate = { label: string; kind: ExperimentKind; settings: Settings; duration: number; rate: number };

/** The oscillator candidates page.html ranks after a free response. */
export function oscillatorCandidates(): Candidate[] {
  return [
    { label: "Step 2 N", kind: "step", settings: { force: 2 }, duration: 10, rate: 100 },
    { label: "Impulse 5 N", kind: "impulse", settings: { force: 5, width: 0.1 }, duration: 10, rate: 100 },
    { label: "Sine 0.1 Hz", kind: "sine", settings: { amplitude: 2, frequency: 0.1 }, duration: 10, rate: 100 },
    { label: "Sine 2 Hz", kind: "sine", settings: { amplitude: 2, frequency: 2 }, duration: 10, rate: 100 },
    { label: "Repeat free response", kind: "free_response", settings: { x0: 1 }, duration: 10, rate: 100 },
  ];
}


/** Score of the proposal as currently edited, and its expected 1σ for the parameters not yet identified. */
/** What a proposal achieves: its E-optimal score and the expected 1σ of each parameter not yet identified. */
export type Outlook = { score: number; expected: Proposal["expected"] };

export function proposalOutlook(config: ProjectConfig, inv: Investigation, proposal: Proposal): Outlook {
  const fit = inv.fits.find((f) => f.n === proposal.atFit)!;
  const ms = fit.measurements.map((id) => inv.measurements.find((m) => m.id === id)!);
  const F0 = fisher(jacobian(problemOf(config, ms, fit.free, fit.fixed), fit.params).J);
  const v = Object.fromEntries(proposal.fields.map((f) => [f.name, f.value]));
  const F1 = experimentFisher(config, fit.params, fit.free, proposal.experiment, { ...proposal.fixedSettings, amplitude: v.amplitude, frequency: v.frequency }, v.duration, v.rate);
  const after = marginalUnder(F0.map((row, i) => row.map((x, j) => x + F1[i][j])), fit.free);
  return { score: score(F0, F1), expected: (fit.sensitivity?.nonIdentified ?? []).map((param) => ({ param, after: after[param] })) };
}

function rankingAt(config: ProjectConfig, inv: Investigation, fit: Fit, proposal: Proposal): RankedCandidate[] {
  const ms = fit.measurements.map((id) => inv.measurements.find((m) => m.id === id)!);
  const F0 = fisher(jacobian(problemOf(config, ms, fit.free, fit.fixed), fit.params).J);
  const own = proposalOutlook(config, inv, proposal);
  return [{ label: sineLabel(proposal.fields.find((f) => f.name === "frequency")!.value), score: own.score, proposal: true },
    ...oscillatorCandidates().map((c) => ({ label: c.label, score: score(F0, experimentFisher(config, fit.params, fit.free, c.kind, c.settings, c.duration, c.rate)), proposal: false }))]
    .sort((a, b) => b.score - a.score);
}

function sineProposal(id: string, atFit: number, status: Proposal["status"], decided: string | null): Proposal {
  const field = (name: string, value: number) => {
    const s = sineSpec.settings.find((x) => x.name === name)!;
    return { name, label: s.label, unit: s.unit, value, original: value, lo: s.lo, hi: s.hi };
  };
  return {
    id, experiment: "sine", atFit, fields: [field("amplitude", 2), field("frequency", 0.44), field("duration", 10), field("rate", 100)],
    fixedSettings: { x0: 0 }, status, decidedBy: decided ? USER : null, decidedAt: decided,
    hypothesis: "Mass is not identifiable from free response: only k/m and c/m are. Driving near resonance separates m.",
    ranking: [], expected: [], dataFrom: "laptop", preview: { t: [], input: null, predicted: [] }, outlook: { axes: [], score: [], after: {} },
    trace: [
      { n: 1, action: "inspect_data", hypothesis: "The free response is a clean decaying oscillation; fit it before choosing anything.", evidence: [], expected: "" },
      { n: 2, action: "optimize_parameters", hypothesis: `Fit #${atFit} should match the ring-down; its residuals will say whether the model is adequate.`, evidence: [], expected: "χ²/N near 1 with white residuals" },
      { n: 3, action: "analyze_sensitivity", hypothesis: "A good fit is not enough: check which parameters this data actually determines.", evidence: [], expected: "" },
      { n: 4, action: "rank_experiments", hypothesis: "Score every catalog experiment on the weakest direction.", evidence: [], expected: "" },
      { n: 5, action: "propose_experiment", hypothesis: "Mass is not identifiable from free response: only k/m and c/m are. Driving near resonance separates m.",
        evidence: ["The weakest direction loads m, c and k equally", "Free response fixes the decay rate and the frequency, not the overall scale", "A drive near resonance scores highest of the candidates"],
        expected: "m, c and k each identified to well under 1%" },
    ],
  };
}

/**
 * The outlook grid over amplitude × frequency × duration at the proposal's rate, as the SDK
 * would upload it. The oscillator is linear, so the information of a drive of amplitude A is
 * A² times that of amplitude 1: one Fisher evaluation per (frequency, duration) node.
 */
export function outlookGrid(config: ProjectConfig, inv: Investigation, p: Proposal): Proposal["outlook"] {
  const fit = inv.fits.find((f) => f.n === p.atFit)!, ms = fit.measurements.map((id) => inv.measurements.find((m) => m.id === id)!);
  const v = Object.fromEntries(p.fields.map((f) => [f.name, f.value]));
  const F0 = fisher(jacobian(problemOf(config, ms, fit.free, fit.fixed), fit.params).J);
  const params = fit.sensitivity?.nonIdentified ?? [];
  const amplitudes = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5];
  const frequencies = [...new Set([...Array.from({ length: 13 }, (_, i) => +(0.05 * 100 ** (i / 12)).toPrecision(3)), v.frequency])].sort((a, b) => a - b);
  const durations = [2, 5, 10, 20, 40, 60];
  const n = amplitudes.length * frequencies.length * durations.length;
  const score = new Array<number>(n), after: Record<string, number[]> = Object.fromEntries(params.map((k) => [k, new Array<number>(n)]));
  frequencies.forEach((f, jf) => durations.forEach((d, jd) => {
    const F1 = experimentFisher(config, fit.params, fit.free, p.experiment, { ...p.fixedSettings, amplitude: 1, frequency: f }, d, v.rate);
    amplitudes.forEach((a, ja) => {
      const F = F0.map((row, i) => row.map((x, j) => x + a * a * F1[i][j]));
      const idx = (ja * frequencies.length + jf) * durations.length + jd;
      score[idx] = Math.sqrt(Math.max(0, eigSym(F).values.at(-1)!));
      const m = marginalUnder(F, fit.free);
      for (const k of params) after[k][idx] = m[k] ?? Infinity;
    });
  }));
  return { axes: [{ name: "amplitude", values: amplitudes }, { name: "frequency", values: frequencies }, { name: "duration", values: durations }], score, after };
}

/** Ranking, expected uncertainties, outlook grid and preview, all at the fit the proposal was ranked at. */
function outlookInto(config: ProjectConfig, inv: Investigation, p: Proposal): Proposal {
  const fit = inv.fits.find((f) => f.n === p.atFit)!, v = Object.fromEntries(p.fields.map((f) => [f.name, f.value]));
  const t = timeGrid(v.duration, v.rate), settings = { ...p.fixedSettings, amplitude: v.amplitude, frequency: v.frequency };
  return {
    ...p, ranking: rankingAt(config, inv, fit, p), expected: proposalOutlook(config, inv, p).expected, outlook: outlookGrid(config, inv, p),
    preview: { t, input: inputSeries(p.experiment, settings, t), predicted: simulate(config.simulator.kind, fit.params, p.experiment, settings, t) },
  };
}

function validationOf(config: ProjectConfig, inv: { measurements: Measurement[] }, fit: Fit, testId: string): Validation {
  const m = inv.measurements.find((x) => x.id === testId)!;
  const pr = problemOf(config, [m], fit.free, fit.fixed), r = pr.residuals(fit.params);
  const chi2N = r.reduce((s, x) => s + x * x, 0) / r.length;
  const s = fit.sensitivity!;
  const worst = s.names.filter((k) => config.params.find((p) => p.name === k)!.coord === "log")
    .map((k) => ({ param: k, relative: 2 * s.marginal[k] })).reduce((a, b) => (b.relative > a.relative ? b : a));
  return { state: chi2N <= 2 ? "passed" : "failed", measurement: testId, fit: fit.n, chi2N, threshold: 2, worst,
    predicted: simulate(config.simulator.kind, fit.params, m.experiment, m.settings, m.t) };
}

// ------------------------------------------------------------------------ the workspace

export function buildWorkspace(): Workspace {
  // Bench oscillators: bench A has one free response and a pending proposal; bench B is done.
  const truthA = { m: 2, c: 0.8, k: 15 };
  const benchA: Investigation = {
    id: "bench-a", name: "bench A", projectId: "bench-oscillators", configVersion: 2, free: ["m", "c", "k"], host: "laptop", seed: 42,
    state: "awaiting-approval", progress: null, updated: "10:44", budget: { steps: 7, simulations: 0, experiments: 1 },
    measurements: [measure(OSC_V2, truthA, "free_response@1", "free_response", { x0: 1 }, 10, 100, 42, "train", "10:41")],
    fits: [], proposals: [], validation: { state: "needs-data" },
  };
  benchA.fits.push(fitOf(OSC_V2, benchA, { n: 1, measurements: ["free_response@1"], free: ["m", "c", "k"], seed: 42 }));
  benchA.proposals.push(outlookInto(OSC_V2, benchA, sineProposal("p1", 1, "proposed", null)));

  const truthB = { m: 1.2, c: 0.36, k: 9.6 };
  const benchB: Investigation = {
    id: "bench-b", name: "bench B", projectId: "bench-oscillators", configVersion: 1, free: ["m", "c", "k"], host: "laptop", seed: 7,
    state: "validated", progress: null, updated: "Nov 2", budget: { steps: 14, simulations: 0, experiments: 2 },
    measurements: [
      measure(OSC_V1, truthB, "free_response@1", "free_response", { x0: 1 }, 10, 100, 7, "train", "Nov 2 09:12"),
      measure(OSC_V1, truthB, "sine_044@1", "sine", { amplitude: 2, frequency: 0.44, x0: 0 }, 30, 50, 8, "train", "Nov 2 11:30"),
      measure(OSC_V1, truthB, "step@1", "step", { force: 2, x0: 0 }, 10, 100, 9, "test", "Nov 2 11:52"),
    ],
    fits: [], proposals: [], validation: { state: "needs-data" },
  };
  benchB.fits.push(fitOf(OSC_V1, benchB, { n: 1, measurements: ["free_response@1"], free: ["m", "c", "k"], seed: 7 }));
  benchB.fits.push(fitOf(OSC_V1, benchB, { n: 2, measurements: ["free_response@1", "sine_044@1"], free: ["m", "c", "k"], seed: 8 }));
  // Proposed here; its approval arrives as a canned record (fixtures/source.ts CANNED).
  benchB.proposals.push(outlookInto(OSC_V1, benchB, sineProposal("p1", 1, "proposed", null)));
  benchB.validation = validationOf(OSC_V1, benchB, benchB.fits[1], "step@1");

  // Fixture truth data: these synthetic parameters generated bench B, not an agent observation.
  const recovered = benchB.fits[1];
  benchB.reveal = { source: "synthetic", tolerance: .1, truth: truthB, estimate: recovered.params, fit_id: recovered.n,
    quantities: Object.entries(truthB).map(([name, truth]) => {
      const estimate = recovered.params[name], ratio = estimate / truth;
      return { name, truth, estimate, ratio, sigma_ratio: recovered.sensitivity!.marginal[name] * ratio,
        within: Math.abs(ratio - 1) <= .1, identifiable: recovered.sensitivity!.identified.includes(name) };
    }) };

  // Cell pulse tests: cell A is running its second fit.
  const truthCell = { R0: 0.032, R1: 0.018, C1: 2400 };
  const cellA: Investigation = {
    id: "cell-a", name: "cell A", projectId: "cell-pulse-tests", configVersion: 1, free: ["R0", "R1", "C1"], host: "lab-pc-cycler", seed: 11,
    state: "running", progress: { done: 12, total: 40 }, updated: "now", budget: { steps: 12, simulations: 0, experiments: 1 },
    measurements: [measure(CELL_V1, truthCell, "pulse_train@1", "pulse_train", { current: 10, on: 30, off: 60, cycles: 4, start: 10 }, 400, 2, 11, "train", "09:58")],
    fits: [], proposals: [], validation: { state: "needs-data" },
  };
  cellA.fits.push(fitOf(CELL_V1, cellA, { n: 1, measurements: ["pulse_train@1"], free: ["R0", "R1", "C1"], seed: 11 }));
  cellA.fits.push(fitOf(CELL_V1, cellA, { n: 2, measurements: ["pulse_train@1"], free: ["R0", "R1", "C1"], seed: 12, starts: 1, maxIter: 2, running: true, start: { R0: 0.1, R1: 0.01, C1: 6000 } }));

  // Lab heaters: heater 1 compared a model without and with a sensor bias, then validated.
  const truthHeat = { R: 2.5, C: 400, bias: 0.4 };
  const step = (power: number) => ({ power, on_at: 60, off_at: 1860, ambient: 20 });
  const heater: Investigation = {
    id: "heater-1", name: "heater 1", projectId: "lab-heaters", configVersion: 1, free: ["R", "C", "bias"], host: "lab-pc-thermal", seed: 3,
    state: "validated", progress: null, updated: "Nov 2", budget: { steps: 9, simulations: 0, experiments: 2 },
    measurements: [
      measure(HEAT_V1, truthHeat, "power_step@1", "power_step", step(10), 3600, 0.1, 3, "train", "Nov 2 08:00"),
      measure(HEAT_V1, truthHeat, "power_step@2", "power_step", step(20), 3600, 0.1, 4, "train", "Nov 2 09:10", [101, 102, 103]),
      measure(HEAT_V1, truthHeat, "power_step@3", "power_step", step(15), 3600, 0.1, 5, "test", "Nov 2 10:20"),
    ],
    fits: [], proposals: [], validation: { state: "needs-data" },
  };
  heater.fits.push(fitOf(HEAT_V1, heater, { n: 1, measurements: ["power_step@1", "power_step@2"], free: ["R", "C"], fixed: { bias: 0 }, variant: "no sensor bias", seed: 3 }));
  heater.fits.push(fitOf(HEAT_V1, heater, { n: 2, measurements: ["power_step@1", "power_step@2"], free: ["R", "C", "bias"], variant: "sensor bias fitted", seed: 4 }));
  heater.validation = validationOf(HEAT_V1, heater, heater.fits[1], "power_step@3");

  const projects: Project[] = [
    { id: "bench-oscillators", name: "Bench oscillators", configs: [OSC_V1, OSC_V2], investigations: [benchA, benchB] },
    { id: "cell-pulse-tests", name: "Cell pulse tests", configs: [CELL_V1], investigations: [cellA] },
    { id: "lab-heaters", name: "Lab heaters", configs: [HEAT_V1], investigations: [heater] },
  ];
  for (const p of projects) {
    for (const inv of p.investigations) {
      const config = configOf(p, inv.configVersion);
      for (const fit of inv.fits) {
        if (fit.state === "converged") fit.landscape = landscapeOf(config, fit.measurements.map((id) => inv.measurements.find((m) => m.id === id)!), fit);
      }
      inv.budget.simulations = inv.fits.reduce((s, f) => s + f.evals, 0) + inv.proposals.length * 6 * (2 * inv.free.length + 1);
    }
  }
  return { user: USER, projects };
}
