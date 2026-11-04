/**
 * What every derivation shares: the client's selection state, node ids, selection parsing,
 * and the small text helpers (status lines, ±, labels).
 */
import { configOf, sineLabel } from "../config.ts";
import type { Fit, Investigation, Measurement, Pairing, Project, ProjectConfig, Proposal, SensitivityResult, Workspace } from "../domain.ts";
import { awaiting, type Decision, expectedMeasurement, stateOf } from "../proposal.ts";
import { pct, sig } from "./fmt.ts";
import { type View, viewsOf } from "./charts.ts";

export type Draft = { raw: string; message: string };

/** What the controller owns: the selection and the unsent edits. Derive reads it, never changes it. */
export type Selection = {
  projectId: string;
  selected: Record<string, string>;
  expanded: Record<string, string[]>;
  /** Raw text of proposal fields that did not parse (or fall outside the outlook), keyed by draftKey. */
  drafts: Record<string, Draft>;
  /** Parsed edits not yet sent (they go with Approve), keyed by draftKey. */
  edits: Record<string, number>;
  /** The last refused write, shown in details until the next pick or decision. */
  notice?: string;
  copyStatus?: "copied" | "select";
};

/** A selection over a loaded workspace: what every derivation reads. */
export type State = Selection & {
  ws: Workspace;
  /** Decision events the source records (absent: all). */
  events?: readonly Decision["event"][];
  /** Devices waiting to pair (absent: the source has no pairing). */
  pairings?: Pairing[];
};

export const draftKey = (inv: Investigation, p: Proposal, field: string) => `${inv.id}/${p.id}/${field}`;

export type Sel =
  | { kind: "config"; project: Project }
  | { kind: "investigation"; inv: Investigation }
  | { kind: "measurement"; inv: Investigation; m: Measurement }
  | { kind: "awaiting"; inv: Investigation; proposal: Proposal; id: string }
  | { kind: "fit"; inv: Investigation; fit: Fit; view: View | null }
  | { kind: "sensitivity"; inv: Investigation; fit: Fit }
  | { kind: "proposal"; inv: Investigation; proposal: Proposal }
  | { kind: "validate"; inv: Investigation };

// ------------------------------------------------------------------------ ids and selection

export const ids = {
  config: (p: Project) => `config:${p.id}`,
  inv: (i: Investigation) => i.id,
  data: (i: Investigation) => `${i.id}/data`,
  measurement: (i: Investigation, id: string) => `${i.id}/data/${id}`,
  fit: (i: Investigation, f: Fit) => `${i.id}/fit-${f.n}`,
  view: (i: Investigation, f: Fit, v: View) => `${i.id}/fit-${f.n}/${v}`,
  sens: (i: Investigation) => `${i.id}/sens`,
  proposal: (i: Investigation, p: Proposal) => `${i.id}/prop/${p.id}`,
  validate: (i: Investigation) => `${i.id}/validate`,
};

export const projectOf = (s: State): Project => s.ws.projects.find((p) => p.id === s.projectId) ?? s.ws.projects[0];
export const configFor = (p: Project, inv: Investigation): ProjectConfig => configOf(p, inv.configVersion);
export const latestConfig = (p: Project): ProjectConfig => p.configs.reduce((a, b) => (b.version > a.version ? b : a));
/** The newest converged fit, which the investigation's diagnosis and sensitivity describe. */
export const latestFit = (inv: Investigation): Fit | null => [...inv.fits].reverse().find((f) => f.state === "converged") ?? null;

export function parseSel(project: Project, id: string): Sel | null {
  if (id === ids.config(project)) return { kind: "config", project };
  const [invId, part, ...rest] = id.split("/");
  const inv = project.investigations.find((i) => i.id === invId);
  if (!inv) return null;
  if (part == null) return { kind: "investigation", inv };
  if (part === "data" && rest.length) {
    const mid = rest.join("/"), m = inv.measurements.find((x) => x.id === mid);
    if (m) return { kind: "measurement", inv, m };
    const proposal = awaiting(inv).find((p) => expectedMeasurement(inv, p) === mid);
    return proposal ? { kind: "awaiting", inv, proposal, id: mid } : null;
  }
  const fitMatch = /^fit-(\d+)$/.exec(part);
  if (fitMatch) {
    const fit = inv.fits.find((f) => f.n === Number(fitMatch[1]));
    if (!fit) return null;
    const view = rest[0] as View | undefined;
    if (view && (fit.state !== "converged" || !viewsOf(configFor(project, inv), inv, fit).includes(view))) return null;
    return { kind: "fit", inv, fit, view: view ?? null };
  }
  if (part === "sens") { const fit = latestFit(inv); return fit?.sensitivity || fit?.identification ? { kind: "sensitivity", inv, fit } : null; }
  if (part === "prop") { const proposal = inv.proposals.find((p) => p.id === rest[0]); return proposal ? { kind: "proposal", inv, proposal } : null; }
  if (part === "validate") return { kind: "validate", inv };
  return null;
}

/** What opens first in a project: the mock's bench A / Fit #1 / Landscape, else the first investigation's latest fit. */
export function defaultSelection(project: Project): string {
  const inv = project.investigations[0];
  if (!inv) return ids.config(project);
  const fit = latestFit(inv);
  if (!fit) return ids.inv(inv);
  return project.id === "bench-oscillators" ? ids.view(inv, fit, "landscape") : ids.view(inv, fit, "fit");
}

/** The rows a selection sits under, so selecting opens them. */
export function ancestors(id: string): string[] {
  const parts = id.split("/");
  if (id.startsWith("config:")) return [];
  const out = [parts[0]];
  if (parts[1] === "data") out.push(`${parts[0]}/data`);
  if (parts[1]?.startsWith("fit-") && parts.length > 2) out.push(`${parts[0]}/${parts[1]}`);
  return out;
}

export function defaultExpanded(project: Project): string[] {
  const inv = project.investigations[0];
  if (!inv) return [];
  const fit = latestFit(inv);
  return [inv.id, `${inv.id}/data`, ...(fit ? [ids.fit(inv, fit)] : [])];
}

// ------------------------------------------------------------------------ shared text

export const unitOf = (c: ProjectConfig, name: string) => c.params.find((p) => p.name === name)?.unit ?? "";
const coordOf = (c: ProjectConfig, name: string) => c.params.find((p) => p.name === name)?.coord ?? "log";

/** ± for a parameter's marginal 1σ: relative for log parameters, absolute in its unit otherwise. */
export function plusMinus(c: ProjectConfig, name: string, std: number): string {
  if (coordOf(c, name) === "log") return pct(std);
  const spec = c.params.find((p) => p.name === name)!;
  return `±${sig(std * (spec.hi - spec.lo), 2)} ${spec.unit}`;
}

export const rankOf = (s: SensitivityResult) => s.kinds.filter((k) => k === "identifiable").length;

export const proposalLabel = (p: Proposal) => {
  const frequency = p.fields.find((f) => f.name === "frequency")?.value ?? p.fixedSettings.frequency;
  return p.experiment === "sine" && Number.isFinite(frequency) ? sineLabel(frequency) : p.experiment;
};

const trainCount = (inv: Investigation) => inv.measurements.filter((m) => m.split === "train").length;
export const experimentsUsed = (inv: Investigation) => trainCount(inv) + awaiting(inv).length;

export function statusText(inv: Investigation): { text: string; tone?: "ok" | "run" | "warn" } {
  switch (stateOf(inv)) {
    case "awaiting-approval": return { text: `Awaiting approval · from ${inv.host}` };
    case "awaiting-data": return { text: `Waiting for data · ${inv.host}` };
    case "awaiting-agent": return { text: `Waiting for the agent's next step · ${inv.host}` };
    case "running": return { text: `Running · step ${inv.progress!.done} of ${inv.progress!.total} · ${inv.host}`, tone: "run" };
    case "validated": return { text: `Validated${inv.validation.state === "passed" || inv.validation.state === "failed" ? ` ${pct(inv.validation.worst.relative)}` : ""} · ${inv.updated}`, tone: "ok" };
    case "inconclusive": return { text: `Inconclusive · ${inv.updated}`, tone: "warn" };
  }
}
