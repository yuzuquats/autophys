/**
 * Domain → chart specs: every point, tick, label and opacity the main viewer draws. No
 * simulation here (AX-2): curves, gain/phase and previews arrive computed in the domain; this
 * file selects, decimates, subtracts and lays out axes. The ui's charts map it to pixels.
 */
import { sigmaOf, specOf } from "../config.ts";
import type { Fit, Investigation, Measurement, ProjectConfig, Proposal, ViewHint } from "../domain.ts";
import type { BarRow, Chart, ChartPanel, HeatmapChart, LegendItem, Point, RangeRow, XYChart } from "../../ui/view-model.ts";
import { axisAround, int, logTicks, niceTicks, sig } from "./fmt.ts";

/** What a view needs: the configuration the investigation pinned, and the investigation. */
export type Ctx = { config: ProjectConfig; inv: Investigation };

/** The leaves under a fit: Fit, Residuals and Landscape always, then each hint its experiments ask for, in catalog order. */
export type View = "fit" | "residuals" | "landscape" | ViewHint;
export const VIEW_LABEL: Record<View, string> = { fit: "Fit", residuals: "Residuals", landscape: "Landscape", envelope: "Envelope", frequency: "Frequency", "zoom:edges": "Edges" };

export function viewsOf(config: ProjectConfig, inv: Investigation, fit: Fit): View[] {
  const kinds = new Set(fit.measurements.map((id) => inv.measurements.find((m) => m.id === id)!.experiment));
  const hints: ViewHint[] = [];
  for (const e of config.catalog) if (kinds.has(e.id)) for (const h of e.viewHints) if (!hints.includes(h)) hints.push(h);
  return ["fit", "residuals", "landscape", ...hints];
}

const MAX_DOTS = 500;
const decimate = <T>(xs: T[]) => { const step = Math.ceil(xs.length / MAX_DOTS); return xs.filter((_, i) => i % step === 0); };
const zip = (t: number[], y: number[]): Point[] => t.map((x, i) => [x, y[i]]);
const measurementOf = (inv: Investigation, id: string) => inv.measurements.find((m) => m.id === id)!;
/** The fit's curve on a measurement it was fitted to (computed upstream), or NaNs if the source sent none. */
const curve = (fit: Fit, m: Measurement, which: "fit" | "initial") => fit.curves[m.id]?.[which] ?? m.t.map(() => NaN);

function timeAxis(t: number[]): XYChart["x"] {
  const max = t[t.length - 1];
  return { min: 0, max, ticks: niceTicks(0, max, 5, "s") };
}

/** The thin input strip over an output chart: force, current or power; a flat line when there is none. */
export function inputStrip(config: ProjectConfig, m: { experiment: Measurement["experiment"]; t: number[]; input: number[] | null }, height = 46): XYChart {
  const spec = specOf(config, m.experiment);
  const channel = spec.input ?? { label: "force", unit: "N" };
  const values = m.input ?? m.t.map(() => 0);
  const y = axisAround(values, { include: [0], count: 2, pad: 0.15 });
  return {
    kind: "xy", height, x: timeAxis(m.t), y, xTicks: false,
    label: `${channel.label} · ${m.input ? channel.unit : "none"}`,
    layers: [{ kind: "line", points: zip(m.t, values), tone: "input" }],
  };
}

function outputChart(config: ProjectConfig, m: Measurement, lines: { y: number[]; tone: "fit" | "initial" | "run"; dashed?: boolean }[], legend: LegendItem[], height = 150): XYChart {
  const out = specOf(config, m.experiment).output;
  return {
    kind: "xy", height, x: timeAxis(m.t), y: axisAround([...m.output, ...lines.flatMap((l) => l.y)], { count: 4 }),
    label: `${out.label} · ${out.unit}`, legend,
    layers: [
      { kind: "dots", points: decimate(zip(m.t, m.output)), tone: "measured" },
      ...lines.map((l) => ({ kind: "line" as const, points: zip(m.t, l.y), tone: l.tone, dashed: l.dashed })),
    ],
  };
}

const FIT_LEGEND: LegendItem[] = [{ label: "measured", mark: "dot", tone: "measured" }, { label: "initial", mark: "dashed", tone: "initial" }, { label: "fit", mark: "line", tone: "fit" }];
const RUN_LEGEND: LegendItem[] = [{ label: "measured", mark: "dot", tone: "measured" }, { label: "initial", mark: "dashed", tone: "initial" }, { label: "current", mark: "line", tone: "run" }];

export function fitPanels(ctx: Ctx, fit: Fit): ChartPanel[] {
  const { config, inv } = ctx, running = fit.state === "running";
  return fit.measurements.map((id) => {
    const m = measurementOf(inv, id);
    return {
      title: m.id,
      charts: [inputStrip(config, m), outputChart(config, m, [
        { y: curve(fit, m, "initial"), tone: "initial", dashed: true },
        { y: curve(fit, m, "fit"), tone: running ? "run" : "fit" },
      ], running ? RUN_LEGEND : FIT_LEGEND)],
    };
  });
}

export function residualPanels(ctx: Ctx, fit: Fit): ChartPanel[] {
  const { config, inv } = ctx, sigma = sigmaOf(config);
  return fit.measurements.map((id) => {
    const m = measurementOf(inv, id), f = curve(fit, m, "fit"), r = m.output.map((y, i) => y - f[i]);
    const rho = fit.lag1[id] ?? 0, structured = Math.abs(rho) > 0.3;
    const unit = specOf(config, m.experiment).output.unit;
    return {
      title: `${m.id} · ${structured ? `structured, ρ₁ ${rho.toFixed(2)}` : `white, ρ₁ ${rho.toFixed(2)}`}`,
      charts: [{
        kind: "xy", height: 140, x: timeAxis(m.t), y: axisAround(r, { symmetric: true, include: [3 * sigma, -3 * sigma], count: 4 }),
        label: `residual · ${unit}`,
        layers: [
          { kind: "hband", from: -sigma, to: sigma, tone: "muted" },
          { kind: "hline", y: 0, tone: "muted" },
          { kind: "dots", points: decimate(zip(m.t, r)), tone: structured ? "warn" : "measured" },
        ],
      }],
    };
  });
}

export function landscapeChart(config: ProjectConfig, fit: Fit): HeatmapChart | null {
  const L = fit.landscape;
  if (!L) return null;
  const logs = L.chi2.map((v) => Math.log10(Math.max(v, 1e-12)));
  const lo = Math.min(...logs), hi = Math.max(...logs);
  const values = logs.map((v) => { const g = 1 - (v - lo) / (hi - lo || 1); return 0.04 + 0.92 * g * g * g; });
  const unit = (n: string) => config.params.find((p) => p.name === n)!.unit;
  const ax = (vals: number[], name: string) => {
    const min = vals[0], max = vals[vals.length - 1];
    return L.log ? { min, max, log: true, ticks: logTicks(min, max), label: `${name} · ${unit(name)}` }
      : { min, max, ticks: niceTicks(min, max, 4).filter((t) => t.value > min && t.value < max), label: `${name} · ${unit(name)}` };
  };
  return {
    kind: "heatmap", height: 300, cols: L.xs.length - 1, rows: L.ys.length - 1, values, x: ax(L.xs, L.x), y: ax(L.ys, L.y),
    label: `fit error over ${L.x}, ${L.y} · ${L.held} held · darker is better`,
    trail: { points: fit.trail.map((p) => [p[L.x], p[L.y]] as Point), label: `Fit #${fit.n}` },
  };
}

/** Peaks of |y| (local maxima above 3σ), the points an envelope runs through. */
export function peaks(t: number[], y: number[], sigma: number, window = 3): Point[] {
  const out: Point[] = [];
  for (let i = window; i < y.length - window; i++) {
    const a = Math.abs(y[i]);
    if (!Number.isFinite(a) || a < 3 * sigma) continue;
    let top = true;
    for (let k = i - window; k <= i + window && top; k++) if (k !== i && Number.isFinite(y[k]) && Math.abs(y[k]) > a) top = false;
    if (top && (!out.length || t[i] - out[out.length - 1][0] > (window + 1) * (t[1] - t[0]))) out.push([t[i], a]);
  }
  return out;
}

export function envelopePanels(ctx: Ctx, fit: Fit): ChartPanel[] {
  const { config, inv } = ctx, sigma = sigmaOf(config);
  return fit.measurements.map((id) => measurementOf(inv, id)).filter((m) => specOf(config, m.experiment).viewHints.includes("envelope")).map((m) => {
    const measured = peaks(m.t, m.output, sigma), fitted = peaks(m.t, curve(fit, m, "fit"), 0), first = peaks(m.t, curve(fit, m, "initial"), 0);
    return {
      title: `${m.id} · decay envelope`,
      charts: [{
        kind: "xy", height: 200, x: timeAxis(m.t), y: axisAround([...measured, ...fitted].map((p) => p[1]), { include: [0], count: 4 }),
        label: `|${specOf(config, m.experiment).output.label}| · ${specOf(config, m.experiment).output.unit}`, legend: [{ label: "measured peaks", mark: "dot", tone: "measured" }, { label: "initial", mark: "dashed", tone: "initial" }, { label: "fit", mark: "line", tone: "fit" }],
        layers: [
          { kind: "line", points: first, tone: "initial", dashed: true },
          { kind: "line", points: fitted, tone: "fit" },
          { kind: "dots", points: measured, tone: "measured", r: 2.4 },
        ],
      } satisfies XYChart],
    };
  });
}

/** Gain and phase against frequency, from the fit's computed response and the points read from the data. */
export function frequencyPanels(_ctx: Ctx, fit: Fit): ChartPanel[] {
  const fr = fit.frequency;
  if (!fr) return [];
  const fs = fr.frequencies, pts = fr.points;
  const ticks = logTicks(0.05, 5), x = { min: 0.05, max: 5, log: true, ticks: ticks.map((t, i) => (i === ticks.length - 1 ? { ...t, label: `${t.label} Hz` } : t)) };
  const legend: LegendItem[] = [{ label: "measured", mark: "dot", tone: "measured" }, { label: "initial", mark: "dashed", tone: "initial" }, { label: "fit", mark: "line", tone: "fit" }];
  const unwrap = (ph: number) => (ph > 5 ? ph - 360 : ph);
  const gain: XYChart = {
    kind: "xy", height: 170, x, xTicks: false, label: "gain · m/N", legend,
    y: axisAround([...fr.fit.map((r) => r.gain), ...pts.map((p) => p.gain)], { include: [0], count: 4 }),
    layers: [
      { kind: "line", points: fs.map((f, i) => [f, fr.initial[i].gain]), tone: "initial", dashed: true },
      { kind: "line", points: fs.map((f, i) => [f, fr.fit[i].gain]), tone: "fit" },
      { kind: "dots", points: pts.map((p) => [p.frequency, p.gain]), tone: "measured", r: 3.5 },
    ],
  };
  const phase: XYChart = {
    kind: "xy", height: 130, x, label: "phase · °",
    y: { min: -190, max: 10, ticks: [{ value: 0, label: "0" }, { value: -90, label: "-90" }, { value: -180, label: "-180" }] },
    layers: [
      { kind: "line", points: fs.map((f, i) => [f, unwrap(fr.initial[i].phase)]), tone: "initial", dashed: true },
      { kind: "line", points: fs.map((f, i) => [f, unwrap(fr.fit[i].phase)]), tone: "fit" },
      { kind: "dots", points: pts.map((p) => [p.frequency, unwrap(p.phase)]), tone: "measured", r: 3.5 },
    ],
  };
  return [{ title: `${pts.map((p) => p.measurement).join(", ")} · steady state`, charts: [gain, phase] }];
}

/** Windows around the first input edges of each pulse measurement. */
export function edgePanels(ctx: Ctx, fit: Fit): ChartPanel[] {
  const { config, inv } = ctx, out: ChartPanel[] = [];
  for (const m of fit.measurements.map((id) => measurementOf(inv, id)).filter((x) => specOf(config, x.experiment).viewHints.includes("zoom:edges"))) {
    const input = m.input ?? [], f = curve(fit, m, "fit"), unit = specOf(config, m.experiment).output.unit;
    const edges: number[] = [];
    for (let i = 1; i < input.length && edges.length < 4; i++) if (input[i] !== input[i - 1]) edges.push(i);
    edges.forEach((e, n) => {
      const t0 = m.t[e] - 3, t1 = m.t[e] + 15;
      const idx = m.t.map((t, i) => [t, i] as const).filter(([t]) => t >= t0 && t <= t1).map(([, i]) => i);
      out.push({
        title: `${m.id} · edge ${n + 1} · ${input[e] > input[e - 1] ? "on" : "off"} at ${sig(m.t[e], 3)} s`,
        charts: [{
          kind: "xy", height: 150, x: { min: t0, max: t1, ticks: niceTicks(t0, t1, 4, "s") }, label: `${specOf(config, m.experiment).output.label} · ${unit}`,
          y: axisAround(idx.flatMap((i) => [m.output[i], f[i]]), { count: 3 }),
          layers: [{ kind: "vline", x: m.t[e], tone: "muted" }, { kind: "dots", points: idx.map((i) => [m.t[i], m.output[i]]), tone: "measured", r: 2 },
            { kind: "line", points: idx.map((i) => [m.t[i], f[i]]), tone: "fit" }],
        }],
      });
    });
  }
  return out;
}

export function measurementPanels(config: ProjectConfig, m: Measurement): ChartPanel[] {
  return [{ title: m.id, charts: [inputStrip(config, m), outputChart(config, m, [], [])] }];
}

export function validationPanels(ctx: Ctx, fit: Fit, testId: string, predicted: number[]): ChartPanel[] {
  const { config, inv } = ctx, m = measurementOf(inv, testId);
  return [{ title: `${m.id} · held out, predicted by Fit #${fit.n}`, charts: [inputStrip(config, m), outputChart(config, m, [{ y: predicted, tone: "fit" }],
    [{ label: "measured", mark: "dot", tone: "measured" }, { label: "predicted", mark: "line", tone: "fit" }])] }];
}

/** The drive as proposed and the response the ranking fit predicts for it (both computed upstream). */
export function proposalPanels(ctx: Ctx, p: Proposal, ranking: BarRow[], edited: boolean): ChartPanel[] {
  const { config } = ctx, t = p.preview.t;
  const drive = { experiment: p.experiment, t, input: p.preview.input };
  const out = specOf(config, p.experiment).output;
  const charts: Chart[] = [inputStrip(config, drive, 70), {
    kind: "xy", height: 130, x: timeAxis(t), y: axisAround(p.preview.predicted, { count: 4 }), label: `${out.label} · ${out.unit}, predicted at Fit #${p.atFit}`,
    layers: [{ kind: "line", points: decimate(zip(t, p.preview.predicted)), tone: "fit" }],
  }];
  const asProposed = p.fields.map((f) => `${sig(f.original, 3)} ${f.unit}`).join(" · ");
  return [{ title: edited ? `as proposed: ${asProposed}` : asProposed, charts }, { charts: [{ kind: "bars", rows: ranking, label: "ranked against · weakest-direction score" }] }];
}

export function configPanels(config: ProjectConfig): ChartPanel[] {
  const rows: RangeRow[] = config.params.map((p) => ({
    label: p.name, unit: p.unit, lo: sig(p.lo, 3), hi: sig(p.hi, 3),
    at: p.coord === "log" ? Math.log(p.initial / p.lo) / Math.log(p.hi / p.lo) : (p.initial - p.lo) / (p.hi - p.lo),
    tag: p.fixed ? { text: "fixed", tone: "muted" } : { text: "free" },
  }));
  return [{ title: `${config.simulator.name} v${config.simulator.version} · parameter bounds, initial guess marked`, charts: [{ kind: "ranges", rows }] }];
}

export function sensitivityPanels(fit: Fit): ChartPanel[] {
  const s = fit.sensitivity!;
  const top = s.singular[0], floor = top * 1e-7;
  const sv: BarRow[] = s.singular.map((v, i) => ({
    label: `σ${"₁₂₃₄₅"[i] ?? i + 1}`, fraction: Math.log10(Math.max(v, floor) / floor) / Math.log10(top / floor),
    value: s.kinds[i] === "structural" ? "≈ 0" : int(v), tone: s.kinds[i] === "identifiable" ? "default" : "warn",
  }));
  const weakest = s.vectors[s.vectors.length - 1];
  const loads: BarRow[] = s.names.map((k, j) => ({ label: k, fraction: Math.abs(weakest[j]), value: sig(weakest[j], 2), tone: s.kinds[s.kinds.length - 1] === "identifiable" ? "default" : "warn" }));
  return [{ charts: [{ kind: "bars", rows: sv, label: "singular values, log scale" }] }, { charts: [{ kind: "bars", rows: loads, label: "weakest direction, loading per parameter" }] }];
}

export { int };
