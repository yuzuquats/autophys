/**
 * The proposal's outlook at edited settings: multilinear interpolation of the grid the SDK
 * (here the fixture) uploaded with the proposal. No re-ranking happens in the client; an edit
 * the grid does not cover is refused as a draft (`covers`).
 */
import type { Investigation, Proposal, ProposalField, ProposalOutlook } from "../domain.ts";
import { draftKey, type State } from "./shared.ts";

/** Interpolate one row-major grid at `at` (one value per axis), or null when `at` is off the grid. */
export function interpolate(o: ProposalOutlook, grid: readonly (number | null)[], at: Record<string, number>): number | null {
  const parts: { lo: number; t: number; stride: number }[] = [];
  let stride = 1;
  for (let k = o.axes.length - 1; k >= 0; k--) {
    const { name, values } = o.axes[k], x = at[name];
    if (!(x >= values[0] && x <= values[values.length - 1])) return null;
    let i = 0;
    while (i < values.length - 2 && x > values[i + 1]) i++;
    const span = values[i + 1] - values[i];
    parts[k] = { lo: i, t: values.length === 1 || span === 0 ? 0 : (x - values[i]) / span, stride };
    stride *= values.length;
  }
  let sum = 0;
  for (let corner = 0; corner < 1 << parts.length; corner++) {
    let w = 1, idx = 0;
    parts.forEach((p, k) => {
      const up = (corner >> k) & 1;
      w *= up ? p.t : 1 - p.t;
      idx += (p.lo + up) * p.stride;
    });
    if (w === 0) continue; // a node's own value is returned exactly; an unused neighbour never contaminates it
    const v = grid[idx];
    if (v == null || !Number.isFinite(v)) return Infinity;
    sum += w * v;
  }
  return sum;
}

/** Fields as shown: the proposal's values with the user's unsent edits (only while proposed). */
export function displayedFields(s: State, inv: Investigation, p: Proposal): ProposalField[] {
  if (p.status !== "proposed") return p.fields;
  return p.fields.map((f) => {
    const e = s.edits[draftKey(inv, p, f.name)];
    return e == null ? f : { ...f, value: e };
  });
}

/** Whether the outlook can say anything at `value` for this field: inside its axis, or unchanged when it has none. */
export function covers(p: Proposal, field: ProposalField, value: number): string | null {
  const axis = p.outlook.axes.find((a) => a.name === field.name);
  if (!axis) return value === field.original ? null : `fixed at ${field.original} ${field.unit} in this outlook`;
  const lo = axis.values[0], hi = axis.values[axis.values.length - 1];
  return value >= lo && value <= hi ? null : `${lo} to ${hi} ${field.unit} in this outlook`;
}

/** Score and expected 1σ per parameter at the given fields; null when the grid does not cover them. */
export function outlookAt(p: Proposal, fields: ProposalField[]): { score: number; after: Record<string, number | null> } | null {
  const at = Object.fromEntries(fields.map((f) => [f.name, f.value]));
  const score = interpolate(p.outlook, p.outlook.score, at);
  if (score == null) return null;
  const after: Record<string, number | null> = {};
  for (const [k, grid] of Object.entries(p.outlook.after)) {
    const v = interpolate(p.outlook, grid, at);
    after[k] = v == null || !Number.isFinite(v) ? null : v;
  }
  return { score, after };
}
