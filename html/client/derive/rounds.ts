/** Proposal boundaries use the existing atFit links, as the wire reasoning trace does. */
import type { Fit, Investigation, Proposal } from "../domain.ts";
import { stateOf } from "../proposal.ts";
import type { Sel } from "./shared.ts";

export type Round = { n: number; fits: Fit[]; proposals: Proposal[] };
export const finished = (inv: Investigation) => ["validated", "inconclusive"].includes(stateOf(inv));
/** The same decision is used from every address on the investigation page. */
export const pageProposal = (inv: Investigation): Proposal | undefined => finished(inv) ? undefined :
  inv.proposals.findLast(p => p.status === "proposed") ?? inv.proposals.at(-1);

export function investigationRounds(inv: Investigation): Round[] {
  const rounds: Round[] = [];
  let cursor = 0;
  for (const p of inv.proposals) {
    const end = inv.fits.findIndex(f => f.n === p.atFit);
    // Re-ranking/rejecting without a new fit stays with that fit's round.
    if (end < cursor && rounds.length) { rounds.at(-1)!.proposals.push(p); continue; }
    rounds.push({ n: rounds.length + 1, fits: end < 0 ? [] : inv.fits.slice(cursor, end + 1), proposals: [p] });
    if (end >= 0) cursor = end + 1;
  }
  if (cursor < inv.fits.length || !rounds.length) rounds.push({ n: rounds.length + 1, fits: inv.fits.slice(cursor), proposals: [] });
  return rounds;
}

export const sectionId = (inv: Investigation, name: string) => `ap-${encodeURIComponent(inv.id)}-${encodeURIComponent(name)}`;
/** Legacy node ids remain selections; only their main-pane destination changes. */
export function investigationAnchor(sel: Exclude<Sel, { kind: "config" }>): string {
  const { inv } = sel, rounds = investigationRounds(inv);
  let name: string;
  switch (sel.kind) {
    case "investigation": name = "summary"; break;
    case "measurement": name = `data-${sel.m.id}`; break;
    case "awaiting": name = `data-${sel.id}`; break;
    case "fit": name = `fit-${sel.fit.n}${sel.view && sel.view !== "fit" ? `-${sel.view}` : ""}`; break;
    case "sensitivity": name = `identifiability-${sel.fit.n}`; break;
    case "proposal": name = `proposal-${sel.proposal.id}`; break;
    case "validate": name = "validate"; break;
    case "truth": name = "truth"; break;
    case "data": name = `data-round-${rounds.at(-1)!.n}`; break;
  }
  return sectionId(inv, name);
}
