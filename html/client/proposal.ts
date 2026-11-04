/**
 * The proposal state machine: a proposal is proposed, approved or rejected; its fields can be
 * edited only while proposed; approval can be withdrawn and a rejection restored. Pure: every
 * transition returns a new proposal (or the same one when the event does not apply). The
 * store applies decision records through `applyDecision`; a Source checks a decision with it
 * before it accepts one (the daemon's 409).
 */
import type { Investigation, Proposal, ProposalField } from "./domain.ts";

/** What the UI posts to …/proposals/<id>/approvals, and what the resulting record carries. */
export type Decision = {
  event: "approved" | "edited" | "rejected" | "unapproved" | "restored";
  by?: string;
  at?: string;
  /** The settings as approved ("edited" only). */
  fields?: Record<string, number>;
};

/** The proposal after a decision, or null when the decision does not apply to its state. */
export function applyDecision(p: Proposal, d: Decision): Proposal | null {
  let next = p;
  switch (d.event) {
    case "edited":
      if (p.status !== "proposed" || !d.fields) return null;
      for (const [name, value] of Object.entries(d.fields)) next = transition(next, { kind: "edit", name, value });
      next = transition(next, { kind: "approve", by: d.by ?? "", at: d.at ?? "" });
      break;
    case "approved": next = transition(p, { kind: "approve", by: d.by ?? "", at: d.at ?? "" }); break;
    case "rejected": next = transition(p, { kind: "reject", by: d.by ?? "", at: d.at ?? "" }); break;
    case "unapproved": next = transition(p, { kind: "withdraw" }); break;
    case "restored": next = transition(p, { kind: "restore" }); break;
  }
  return next === p ? null : next;
}

export type ProposalEvent =
  | { kind: "edit"; name: string; value: number }
  | { kind: "approve"; by: string; at: string }
  | { kind: "reject"; by: string; at: string }
  | { kind: "withdraw" }
  | { kind: "restore" };

/** Parse a raw field text against its limits. */
export function parseField(field: ProposalField, raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim().replace(/,/g, "");
  const value = Number(text);
  if (!text || !Number.isFinite(value)) return { ok: false, message: "Enter a number" };
  if (value < field.lo || value > field.hi) return { ok: false, message: `${field.lo} to ${field.hi} ${field.unit}`.trim() };
  return { ok: true, value };
}

export function transition(p: Proposal, e: ProposalEvent): Proposal {
  switch (e.kind) {
    case "edit": {
      if (p.status !== "proposed") return p;
      const f = p.fields.find((x) => x.name === e.name);
      if (!f || f.value === e.value || e.value < f.lo || e.value > f.hi) return p;
      return { ...p, fields: p.fields.map((x) => (x.name === e.name ? { ...x, value: e.value } : x)) };
    }
    case "approve":
      return p.status === "proposed" ? { ...p, status: "approved", decidedBy: e.by, decidedAt: e.at } : p;
    case "reject":
      return p.status === "proposed" ? { ...p, status: "rejected", decidedBy: e.by, decidedAt: e.at } : p;
    case "withdraw":
      return p.status === "approved" ? { ...p, status: "proposed", decidedBy: null, decidedAt: null } : p;
    case "restore":
      return p.status === "rejected" ? { ...p, status: "proposed", decidedBy: null, decidedAt: null } : p;
  }
}

export const edited = (p: Proposal): ProposalField[] => p.fields.filter((f) => f.value !== f.original);

/** The measurement id the SDK will upload for an approved proposal: sine_044@1 for a 0.44 Hz sine, else `<experiment>@<n>`. */
export function expectedMeasurement(inv: Investigation, p: Proposal): string {
  const f = p.fields.find((x) => x.name === "frequency")?.value;
  const base = p.experiment === "sine" && f != null ? `${p.experiment}_${String(Math.round(f * 100)).padStart(3, "0")}` : p.experiment;
  const runs = inv.measurements.filter((m) => m.id.startsWith(`${base}@`)).length;
  return `${base}@${runs + 1}`;
}

/** Whether an approved proposal's data has arrived (its experiment has a measurement uploaded after approval). */
export const delivered = (inv: Investigation, p: Proposal): boolean =>
  p.status === "approved" && (p.delivered ?? inv.measurements.some((m) => m.experiment === p.experiment && m.split === "train"));

/** Decisions waiting on the user in an investigation. */
export const pendingDecisions = (inv: Investigation): number => inv.proposals.filter((p) => p.status === "proposed").length;

/** Approved proposals still waiting for their data. */
export const awaiting = (inv: Investigation): Proposal[] => inv.proposals.filter((p) => p.status === "approved" && !delivered(inv, p));

/** The investigation's state after local decisions. */
export function stateOf(inv: Investigation): Investigation["state"] {
  if (inv.state === "running" || inv.state === "validated" || inv.state === "inconclusive") return inv.state;
  if (pendingDecisions(inv)) return "awaiting-approval";
  return awaiting(inv).length ? "awaiting-data" : "awaiting-agent";
}
