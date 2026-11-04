/** Number and axis formatting for the derivations: every string the view model shows. */
import type { Axis, Tick } from "../../ui/view-model.ts";

/** `v` to `n` significant digits, without exponent notation for ordinary magnitudes. */
export function sig(v: number, n = 3): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(n - 1).replace("e+", "e");
  const digits = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
  return v.toFixed(Math.min(digits, 6));
}

export const int = (v: number) => Math.round(v).toLocaleString("en-US");
export const pct = (fraction: number) => `±${sig(fraction * 100, 2)}%`;
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Round-number ticks spanning [min, max]. */
export function niceTicks(min: number, max: number, count = 5, unit = ""): Tick[] {
  const span = max - min || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? 10 * mag;
  const out: Tick[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9 * span; v += step) {
    const value = Math.abs(v) < step * 1e-9 ? 0 : v;
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
    out.push({ value, label: value.toFixed(decimals) });
  }
  if (unit && out.length) out[out.length - 1] = { ...out[out.length - 1], label: `${out[out.length - 1].label} ${unit}` };
  return out;
}

/** Decade ticks (and 2, 5 when the span is short) for a log axis. */
export function logTicks(min: number, max: number): Tick[] {
  const out: Tick[] = [], short = Math.log10(max / min) < 2.2;
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of short ? [1, 2, 5] : [1]) {
      const v = m * 10 ** e;
      if (v >= min * 0.999 && v <= max * 1.001) out.push({ value: v, label: sig(v, 2) });
    }
  }
  return out;
}

/** An axis around finite values with a margin. */
export function axisAround(values: number[], opts: { pad?: number; include?: number[]; count?: number; label?: string; symmetric?: boolean } = {}): Axis {
  const finite = [...values.filter(Number.isFinite), ...(opts.include ?? [])];
  let min = Math.min(...finite), max = Math.max(...finite);
  if (opts.symmetric) { const a = Math.max(Math.abs(min), Math.abs(max)) || 1; min = -a; max = a; }
  if (!(max > min)) { min -= 1; max += 1; }
  const pad = (max - min) * (opts.pad ?? 0.08);
  min -= pad; max += pad;
  return { min, max, ticks: niceTicks(min, max, opts.count ?? 4), label: opts.label };
}
