/** Existing fit/atFit boundaries are also the proposal reasoning trace boundaries. */
import type { Fit, Investigation, Measurement, Proposal } from "../domain.ts";
import type { Sel } from "./shared.ts";

export type Round = { n: number; fit: Fit | null; proposals: Proposal[]; measurements: Measurement[] };
export const anchor = (inv: Investigation, part: string) => `ap-${encodeURIComponent(inv.id)}-${part}`;
export const roundAnchor = (inv: Investigation, round: Round, part = "") =>
  anchor(inv, `round-${round.n}${part ? "-" + part : ""}`);
export const measurementAnchor = (inv: Investigation, round: Round, id: string) =>
  roundAnchor(inv, round, `measurement-${encodeURIComponent(id)}`);

export function investigationRounds(inv: Investigation): Round[] {
  const fits = [...inv.fits].sort((a,b) => a.n - b.n);
  const before = inv.proposals.filter(p => !fits.some(f => f.n === p.atFit));
  const rounds: Round[] = [
    ...(before.length || !fits.length ? [{ n: 1, fit: null, proposals: before, measurements: [] }] : []),
    ...fits.map((fit, i) => ({ n: i + 1 + (before.length ? 1 : 0), fit,
      proposals: inv.proposals.filter(p => p.atFit === fit.n),
      measurements: inv.measurements.filter(m => fit.measurements.includes(m.id)) })),
  ];
  // Held-out and newly arrived data belong to the latest round until a fit consumes them.
  const last = rounds.at(-1)!;
  last.measurements = [...last.measurements, ...inv.measurements.filter(m => !rounds.some(r => r.measurements.some(x => x.id === m.id)))];
  return rounds;
}

/** Legacy selections locate an actual card, including a measurement inside a closed older round. */
export function investigationTarget(inv: Investigation, sel: Exclude<Sel, {kind:"config"}>, rounds = investigationRounds(inv)): string {
  const last = rounds.at(-1)!;
  const atFit = (n: number) => rounds.find(r => r.fit?.n === n) ?? last;
  switch (sel.kind) {
    case "investigation": return anchor(inv, "summary");
    case "data": return roundAnchor(inv, last, "data");
    case "measurement": {
      const r = rounds.find(r => r.measurements.some(m => m.id === sel.m.id)) ?? last;
      return measurementAnchor(inv, r, sel.m.id);
    }
    case "awaiting": return roundAnchor(inv, atFit(sel.proposal.atFit), "data");
    case "fit": return roundAnchor(inv, atFit(sel.fit.n),
      sel.view === "landscape" ? "landscape" : ["envelope", "frequency", "zoom:edges"].includes(sel.view ?? "") ? sel.view! : "fit");
    case "sensitivity": return roundAnchor(inv, atFit(sel.fit.n), "identifiability");
    case "proposal": return roundAnchor(inv, atFit(sel.proposal.atFit), `proposal-${encodeURIComponent(sel.proposal.id)}`);
    case "validate": return anchor(inv, "validate");
    case "truth": return anchor(inv, "truth");
  }
}
