/** Format the evaluator results exactly as recorded; no scoring or uncertainty estimation. */
import type { Investigation, Reveal } from "../domain.ts";
import type { ChartPanel, Layer, TreeNode, XYChart } from "../../ui/view-model.ts";
import { niceTicks, sig } from "./fmt.ts";

export function groundTruthNode(inv: Investigation): TreeNode | null {
  return inv.reveal ? { id: inv.id + "/truth", label: "Ground truth", icon: "validate", selectable: true, children: null } : null;
}

export function truthPanels(reveal: Reveal): ChartPanel[] {
  const qs = reveal.quantities, tolerance = `${+(100 * reveal.tolerance).toPrecision(3)}%`;
  const values = qs.flatMap((q) => [q.ratio, q.ratio - (q.sigma_ratio ?? 0), q.ratio + (q.sigma_ratio ?? 0)]).filter(Number.isFinite);
  const lo = Math.min(1 - reveal.tolerance, ...values), hi = Math.max(1 + reveal.tolerance, ...values), pad = (hi - lo || .2) * .15;
  const layers: Layer[] = [{ kind: "vband", from: 1 - reveal.tolerance, to: 1 + reveal.tolerance, tone: "muted" }, { kind: "vline", x: 1, tone: "muted" }];
  qs.forEach((q, i) => {
    const tone = q.within ? "fit" : "warn", y = qs.length - i;
    if (q.sigma_ratio != null && Number.isFinite(q.sigma_ratio)) {
      const a = q.ratio - q.sigma_ratio, b = q.ratio + q.sigma_ratio;
      layers.push({ kind: "line", points: [[a, y], [b, y]], tone },
        { kind: "line", points: [[a, y - .12], [a, y + .12]], tone },
        { kind: "line", points: [[b, y - .12], [b, y + .12]], tone });
    }
    layers.push({ kind: "dots", points: [[q.ratio, y]], tone, r: 3 });
  });
  const chart: XYChart = { kind: "xy", left: Math.max(44, ...qs.map((q) => q.name.length * 8 + 14)), height: Math.max(140, qs.length * 42 + 50), label: "estimate ÷ truth · ±1σ",
    x: { min: lo - pad, max: hi + pad, ticks: niceTicks(lo - pad, hi + pad, 5) },
    y: { min: .5, max: qs.length + .5, ticks: qs.map((q, i) => ({ value: qs.length - i, label: q.name })) }, layers };
  return [{ title: `${qs.filter((q) => q.within).length} of ${qs.length} within ±${tolerance} of the truth`, charts: [chart], blocks: [
    { kind: "table", rows: [
      { cells: ["quantity", "truth", "recovered", "error", `within ±${tolerance}`].map((text) => ({ text })) },
      ...qs.map((q) => ({ cells: [{ text: q.name }, { text: sig(q.truth, 4) }, { text: sig(q.estimate, 4) },
        { text: Number.isFinite(q.ratio) ? `${sig((q.ratio - 1) * 100, 3)}%` : "–" },
        { text: q.within ? "Yes" : "No", tag: q.identifiable ? undefined : { text: "not identifiable", tone: "muted" as const } }] })),
    ] },
  ] }];
}
