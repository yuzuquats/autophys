/**
 * The numerics behind the fixture: the three simulators, their inputs, seeded noise, small
 * dense linear algebra, a Levenberg-Marquardt fit, and the Fisher-information sensitivity and
 * experiment scores. This is a browser stand-in for what the Python SDK computes and uploads
 * (hacks-site exp/modellab/python); nothing here calls a server.
 */

import type { Coord, ExperimentKind, Params, Settings, SimulatorKind } from "../domain.ts";

export type { Coord, ExperimentKind, Params, Settings, SimulatorKind };

// ------------------------------------------------------------------------ noise

/** mulberry32: a seeded uniform generator in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box-Muller) from a uniform generator. */
export function gaussian(rnd: () => number): () => number {
  return () => {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// ------------------------------------------------------------------------ inputs and simulators

export { timeGrid } from "../config.ts";

/** The drive at time t: force (N), heater power (W) or discharge current (A). */
export function inputAt(kind: ExperimentKind, s: Settings, t: number): number {
  switch (kind) {
    case "free_response": return 0;
    case "impulse": return t < s.width ? s.force : 0;
    case "step": return s.force;
    case "sine": return s.amplitude * Math.sin(2 * Math.PI * s.frequency * t);
    case "power_step": return t >= s.on_at && t < s.off_at ? s.power : 0;
    case "pulse_train": {
      const period = s.on + s.off, k = Math.floor((t - s.start) / period), phase = t - s.start - k * period;
      return t >= s.start && k < s.cycles && phase < s.on ? s.current : 0;
    }
  }
}

export function inputSeries(kind: ExperimentKind, s: Settings, t: number[]): number[] | null {
  return kind === "free_response" ? null : t.map((x) => inputAt(kind, s, x));
}

/** The simulator's output at every time in `t` (a uniform grid starting at 0). */
export function simulate(sim: SimulatorKind, p: Params, kind: ExperimentKind, s: Settings, t: number[]): number[] {
  const n = t.length, dt = t[1] - t[0], out = new Array<number>(n);
  if (sim === "oscillator") {
    const { m, c, k } = p;
    let x = s.x0 ?? 0, v = 0;
    const a = (tt: number, xx: number, vv: number) => (inputAt(kind, s, tt) - c * vv - k * xx) / m;
    out[0] = x;
    for (let i = 1; i < n; i++) {
      const t0 = t[i - 1];
      const k1x = v, k1v = a(t0, x, v);
      const k2x = v + 0.5 * dt * k1v, k2v = a(t0 + 0.5 * dt, x + 0.5 * dt * k1x, v + 0.5 * dt * k1v);
      const k3x = v + 0.5 * dt * k2v, k3v = a(t0 + 0.5 * dt, x + 0.5 * dt * k2x, v + 0.5 * dt * k2v);
      const k4x = v + dt * k3v, k4v = a(t0 + dt, x + dt * k3x, v + dt * k3v);
      x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      out[i] = x;
    }
    return out;
  }
  if (sim === "thermal") {
    // Exact for power held over each sample interval: T relaxes to ambient + P·R with time constant R·C.
    const { R, C } = p, bias = p.bias ?? 0, ambient = s.ambient ?? 20, decay = Math.exp(-dt / (R * C));
    let temp = ambient;
    for (let i = 0; i < n; i++) {
      out[i] = temp + bias;
      const target = ambient + inputAt(kind, s, t[i]) * R;
      temp = target + (temp - target) * decay;
    }
    return out;
  }
  // Thevenin: V = OCV - I·R0 - V1, with V1 relaxing to I·R1 with time constant R1·C1.
  const { R0, R1, C1 } = p, ocv = s.ocv ?? 3.7, decay = Math.exp(-dt / (R1 * C1));
  let v1 = 0;
  for (let i = 0; i < n; i++) {
    const current = inputAt(kind, s, t[i]);
    out[i] = ocv - current * R0 - v1;
    v1 = current * R1 + (v1 - current * R1) * decay;
  }
  return out;
}

/** Steady-state response of the oscillator to a sine force: gain (m/N) and phase (degrees, lag negative). */
export function oscillatorResponse(p: Params, frequency: number): { gain: number; phase: number } {
  const w = 2 * Math.PI * frequency, re = p.k - p.m * w * w, im = p.c * w;
  return { gain: 1 / Math.hypot(re, im), phase: (-Math.atan2(im, re) * 180) / Math.PI };
}

// ------------------------------------------------------------------------ linear algebra

export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Eigen-decomposition of a small symmetric matrix (cyclic Jacobi), values descending. */
export function eigSym(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length, a = A.map((r) => [...r]), V: number[][] = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    const scale = a.reduce((s, r, i) => s + r[i] * r[i], 0);
    if (off <= 1e-30 * Math.max(scale, 1e-300)) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
        for (let k = 0; k < n; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
        for (let k = 0; k < n; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
        for (let k = 0; k < n; k++) { const kp = V[k][p], kq = V[k][q]; V[k][p] = c * kp - s * kq; V[k][q] = s * kp + c * kq; }
      }
    }
  }
  const order = a.map((_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => V.map((row) => row[i])) };
}

// ------------------------------------------------------------------------ fitting

export type Problem = {
  names: string[];
  coord: Record<string, Coord>;
  lo: Params;
  hi: Params;
  fixed: Params;
  /** Weighted residuals (y − f)/σ over every finite sample, in a fixed order. */
  residuals: (p: Params) => number[];
};

const toU = (pr: Problem, k: string, v: number) => (pr.coord[k] === "log" ? Math.log(v) : v / (pr.hi[k] - pr.lo[k]));
const fromU = (pr: Problem, k: string, u: number) => (pr.coord[k] === "log" ? Math.exp(u) : u * (pr.hi[k] - pr.lo[k]));
const clampU = (pr: Problem, k: string, u: number) => Math.min(toU(pr, k, pr.hi[k]), Math.max(toU(pr, k, pr.lo[k]), u));
const sumSq = (r: number[]) => r.reduce((s, x) => s + x * x, 0);

export function paramsOf(pr: Problem, u: number[]): Params {
  const p: Params = { ...pr.fixed };
  pr.names.forEach((k, i) => { p[k] = fromU(pr, k, u[i]); });
  return p;
}

/** Jacobian of the weighted residuals in fitting coordinates (central differences); columns per free name. */
export function jacobian(pr: Problem, p: Params): { J: number[][]; r: number[]; evals: number } {
  const u = pr.names.map((k) => toU(pr, k, p[k])), r = pr.residuals(p), J: number[][] = [];
  const h = 1e-5;
  pr.names.forEach((_, i) => {
    const up = [...u], dn = [...u];
    up[i] += h;
    dn[i] -= h;
    const a = pr.residuals(paramsOf(pr, up)), b = pr.residuals(paramsOf(pr, dn));
    J.push(a.map((x, n) => (b[n] - x) / (2 * h))); // r = (y − f)/σ, so dr/du = −df/du/σ; the sign cancels in JᵀJ
  });
  return { J, r, evals: 1 + 2 * pr.names.length };
}

export function fisher(J: number[][]): number[][] {
  return J.map((a) => J.map((b) => a.reduce((s, x, n) => s + x * b[n], 0)));
}

export type FitRun = { params: Params; cost: number; n: number; evals: number; trail: Params[]; converged: boolean; iterations: number };

/** Levenberg-Marquardt on the problem from `start`, bounded by clamping; stops after `maxIter`. */
export function levenberg(pr: Problem, start: Params, maxIter = 60): FitRun {
  let u = pr.names.map((k) => clampU(pr, k, toU(pr, k, start[k])));
  let p = paramsOf(pr, u), r = pr.residuals(p), cost = sumSq(r), evals = 1, lambda = 1e-3, converged = false, it = 0;
  const trail: Params[] = [p];
  for (; it < maxIter; it++) {
    const jac = jacobian(pr, p);
    evals += jac.evals - 1;
    const A = fisher(jac.J), g = jac.J.map((col) => col.reduce((s, x, n) => s + x * r[n], 0));
    const peak = Math.max(...A.map((row, i) => row[i]), 1e-300);
    let accepted = false;
    for (let tries = 0; tries < 12; tries++) {
      const D = A.map((row, i) => row.map((x, j) => (i === j ? x + lambda * (x + 1e-9 * peak) : x)));
      // jac.J holds d(−r)/du, so the Gauss-Newton step solves (JᵀJ + λD) δ = Jᵀr with that sign.
      const step = solveLinear(D, g);
      if (!step) { lambda *= 10; continue; }
      const next = u.map((x, i) => clampU(pr, pr.names[i], x + step[i]));
      const np = paramsOf(pr, next), nr = pr.residuals(np), nc = sumSq(nr);
      evals++;
      if (nc < cost) {
        const drop = (cost - nc) / Math.max(cost, 1e-300);
        u = next; p = np; r = nr; cost = nc; lambda = Math.max(lambda / 3, 1e-12); accepted = true;
        trail.push(p);
        if (drop < 1e-10) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!accepted || converged) { converged = true; it++; break; }
  }
  return { params: p, cost, n: r.length, evals, trail, converged, iterations: it };
}

// ------------------------------------------------------------------------ sensitivity

/** The SDK's identifiability rule (sensitivity.py DEFAULT_RULE). */
export const RULE = { relTol: 1e-3, maxLogStd: 0.1, loadingTol: 0.2 } as const;

export type Sensitivity = {
  names: string[];
  singular: number[];
  vectors: number[][];
  kinds: ("identifiable" | "structural" | "practical")[];
  condition: number;
  /** Marginal 1σ in fitting coordinates over the identifiable directions (log std for log parameters). */
  marginal: Record<string, number>;
  identified: string[];
  nonIdentified: string[];
};

export function sensitivity(F: number[][], names: string[]): Sensitivity {
  const { values, vectors } = eigSym(F);
  const singular = values.map((v) => Math.sqrt(Math.max(0, v)));
  const smax = singular[0] || 1e-300;
  const kinds = singular.map((s) => (s < RULE.relTol * smax ? "structural" : 1 / s > RULE.maxLogStd ? "practical" : "identifiable") as Sensitivity["kinds"][number]);
  const marginal: Record<string, number> = {}, identified: string[] = [], nonIdentified: string[] = [];
  names.forEach((k, j) => {
    marginal[k] = Math.sqrt(vectors.reduce((s, v, i) => (kinds[i] === "identifiable" ? s + (v[j] / singular[i]) ** 2 : s), 0));
    const loads = vectors.every((v, i) => kinds[i] === "identifiable" || Math.abs(v[j]) <= RULE.loadingTol);
    (loads && marginal[k] <= RULE.maxLogStd ? identified : nonIdentified).push(k);
  });
  const smin = singular[singular.length - 1];
  return { names, singular, vectors, kinds, condition: smin > 0 ? smax / smin : Infinity, marginal, identified, nonIdentified };
}

/** 1σ of log Π θ^a over the identifiable directions, or null when it loads on a non-identifiable one. */
export function comboStd(s: Sensitivity, exponents: Record<string, number>): number | null {
  const a = s.names.map((k) => exponents[k] ?? 0), norm = Math.hypot(...a) || 1;
  let v = 0;
  for (let i = 0; i < s.singular.length; i++) {
    const dot = s.vectors[i].reduce((acc, x, j) => acc + x * a[j], 0);
    if (s.kinds[i] !== "identifiable") { if (Math.abs(dot) / norm > RULE.loadingTol) return null; continue; }
    v += (dot / s.singular[i]) ** 2;
  }
  return Math.sqrt(v);
}

/** E-optimal score of adding an experiment: √(smallest eigenvalue of F0 + F1), as page.html ranks them. */
export function score(F0: number[][], F1: number[][]): number {
  const F = F0.map((row, i) => row.map((x, j) => x + F1[i][j]));
  return Math.sqrt(Math.max(0, eigSym(F).values.at(-1)!));
}

/** Marginal 1σ of each coordinate under F (pseudo-inverse over directions above the structural tolerance). */
export function marginalUnder(F: number[][], names: string[]): Record<string, number | null> {
  const { values, vectors } = eigSym(F), top = Math.sqrt(Math.max(values[0], 0));
  const out: Record<string, number | null> = {};
  names.forEach((k, j) => {
    let v = 0, free = false;
    values.forEach((lam, i) => {
      const s = Math.sqrt(Math.max(lam, 0));
      if (s < RULE.relTol * top) { if (Math.abs(vectors[i][j]) > RULE.loadingTol) free = true; return; }
      v += (vectors[i][j] / s) ** 2;
    });
    out[k] = free ? null : Math.sqrt(v);
  });
  return out;
}
