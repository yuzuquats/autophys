/**
 * Intent → the next selection plus effects: post a decision, save a file, tell the shell a
 * pick happened. `reduce` is pure; `Controller` holds the selection, runs the effects against
 * the Store and tells subscribers to redraw. It imports the ui's Intent type only.
 */
import { approvalsPath, type Snapshot } from "./api.ts";
import type { Investigation, Project, Workspace } from "./domain.ts";
import { latestFit, proposalLabel, statusText } from "./derive/shared.ts";
import { ancestors, covers, defaultExpanded, defaultSelection, derive, displayedFields, draftKey, parseSel, type Selection, type View } from "./derive/index.ts";
import { sig } from "./derive/fmt.ts";
import { type Decision, parseField } from "./proposal.ts";
import type { Store } from "./store.ts";
import type { Intent } from "../ui/intent.ts";

export type Env = { user: string; now: () => string };

export type Effect =
  | { kind: "post"; path: string; body: Decision }
  | { kind: "download"; filename: string; type: string; data: string }
  | { kind: "picked" };

export type Step = { selection: Selection; effects: Effect[] };

export function initialSelection(ws: Workspace): Selection {
  return {
    projectId: ws.projects[0].id,
    selected: Object.fromEntries(ws.projects.map((p) => [p.id, defaultSelection(p)])),
    expanded: Object.fromEntries(ws.projects.map((p) => [p.id, defaultExpanded(p)])),
    drafts: {}, edits: {},
  };
}

const none = (selection: Selection): Step => ({ selection, effects: [] });
const json = (filename: string, data: unknown): Effect => ({ kind: "download", filename, type: "application/json", data: JSON.stringify(data, null, 2) });
const without = <T>(r: Record<string, T>, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

export function reduce(sel: Selection, snap: Snapshot, intent: Intent, env: Env): Step {
  const ws = snap.workspace, project = ws.projects.find((p) => p.id === sel.projectId) ?? ws.projects[0];
  const at = parseSel(project, sel.selected[project.id] ?? "");
  switch (intent.kind) {
    case "select": {
      if (!parseSel(project, intent.id)) return none(sel);
      const open = new Set([...(sel.expanded[project.id] ?? []), ...ancestors(intent.id)]);
      return { selection: { ...sel, selected: { ...sel.selected, [project.id]: intent.id }, expanded: { ...sel.expanded, [project.id]: [...open] } }, effects: [{ kind: "picked" }] };
    }
    case "toggle": {
      const now = new Set(sel.expanded[project.id] ?? []);
      if (intent.open) now.add(intent.id);
      else now.delete(intent.id);
      return none({ ...sel, expanded: { ...sel.expanded, [project.id]: [...now] } });
    }
    case "switch":
      return ws.projects.some((p) => p.id === intent.value) && intent.value !== sel.projectId ? none({ ...sel, projectId: intent.value }) : none(sel);
    case "field": {
      if (!intent.commit || at?.kind !== "proposal" || at.proposal.status !== "proposed") return none(sel);
      const field = at.proposal.fields.find((f) => f.name === intent.name);
      if (!field) return none(sel);
      const key = draftKey(at.inv, at.proposal, field.name), parsed = parseField(field, intent.raw);
      const refused = parsed.ok ? covers(at.proposal, field, parsed.value) : parsed.message;
      if (refused || !parsed.ok) return none({ ...sel, drafts: { ...sel.drafts, [key]: { raw: intent.raw, message: refused! } } });
      const edits = parsed.value === field.original ? without(sel.edits, [key]) : { ...sel.edits, [key]: parsed.value };
      return none({ ...sel, drafts: without(sel.drafts, [key]), edits });
    }
    case "action": {
      const name = intent.name;
      if (name === "export") return { selection: sel, effects: [json(`autophys-${snap.source}.json`, exportDocument(snap, sel))] };
      const inv = at && "inv" in at ? at.inv : null;
      if (inv && name === "export-investigation") return { selection: sel, effects: [json(`autophys-${inv.id}.json`, { demo: true, source: snap.source, investigation: inv })] };
      if (inv && name === "report") return { selection: sel, effects: [{ kind: "download", filename: `autophys-${inv.id}-report.md`, type: "text/markdown", data: reportText(snap, project, inv) }] };
      if (at?.kind !== "proposal") return none(sel);
      const p = at.proposal, keys = p.fields.map((f) => draftKey(at.inv, p, f.name));
      const post = (body: Decision): Step => ({ selection: { ...sel, edits: without(sel.edits, keys) }, effects: [{ kind: "post", path: approvalsPath(at.inv.id, p.id), body }] });
      if (name === "approve" && p.status === "proposed") {
        if (keys.some((k) => sel.drafts[k])) return none(sel);
        const changed = displayedFields({ ...sel, ws }, at.inv, p).filter((f) => f.value !== f.original);
        return post(changed.length
          ? { event: "edited", by: env.user, at: env.now(), fields: Object.fromEntries(changed.map((f) => [f.name, f.value])) }
          : { event: "approved", by: env.user, at: env.now() });
      }
      if (name === "reject" && p.status === "proposed") return post({ event: "rejected", by: env.user, at: env.now() });
      if (name === "withdraw" && p.status === "approved") return post({ event: "unapproved" });
      if (name === "restore" && p.status === "rejected") return post({ event: "restored" });
      return none(sel);
    }
  }
}

/** The whole state as JSON: workspace (missing samples become null), selection, source. */
export function exportDocument(snap: Snapshot, sel: Selection) {
  return { demo: true, source: snap.source, gseq: snap.gseq, project: sel.projectId, selected: sel.selected, workspace: snap.workspace };
}

export function reportText(snap: Snapshot, project: Project, inv: Investigation): string {
  const fit = latestFit(inv), lines = [`# ${project.name} · ${inv.name}`, "", statusText(inv).text, ""];
  if (fit?.sensitivity) {
    lines.push(`Fit #${fit.n}: χ²/N ${fit.chi2N.toFixed(2)} over ${fit.measurements.join(", ")}`);
    for (const c of fit.sensitivity.combos) lines.push(`- ${c.name} = ${sig(c.value, 4)} ± ${sig(c.logStd * 100, 2)}%`);
    for (const k of fit.sensitivity.identified) lines.push(`- ${k} = ${sig(fit.params[k], 4)} (identified)`);
    for (const k of fit.sensitivity.nonIdentified) lines.push(`- ${k}: not identified`);
  }
  for (const p of inv.proposals) lines.push("", `Proposal ${proposalLabel(p)}: ${p.status}${p.decidedBy ? ` by ${p.decidedBy} at ${p.decidedAt}` : ""}`);
  lines.push("", `Source: ${snap.source} at record ${snap.gseq}`);
  return lines.join("\n") + "\n";
}

/** Holds the selection, runs effects, and notifies redraws. The app layer gives it the shell's hands. */
export class Controller {
  private sel: Selection | null = null;
  private subs = new Set<() => void>();
  /** The last refused post, shown nowhere yet but kept for tests and the console. */
  error: string | null = null;
  shell: { download(filename: string, type: string, data: string): void; picked(): void } = { download: () => {}, picked: () => {} };

  constructor(readonly store: Store, private env: Env) {
    store.subscribe(() => this.notify());
  }

  get selection(): Selection | null {
    const snap = this.store.snapshot();
    if (snap && !this.sel) this.sel = initialSelection(snap.workspace);
    return this.sel;
  }

  view(): View {
    const snap = this.store.snapshot(), sel = this.selection;
    return derive(snap, sel ?? { projectId: "", selected: {}, expanded: {}, drafts: {}, edits: {} });
  }

  exportDocument(): unknown {
    const snap = this.store.snapshot(), sel = this.selection;
    return snap && sel ? exportDocument(snap, sel) : { demo: true, source: this.store.source.name, loading: true };
  }

  /** The ui's intent handler (an arrow, so it can be passed as is). */
  handle = (intent: Intent): void => {
    const snap = this.store.snapshot(), sel = this.selection;
    if (!snap || !sel) return;
    const step = reduce(sel, snap, intent, this.env);
    const changed = step.selection !== sel;
    this.sel = step.selection;
    for (const e of step.effects) {
      if (e.kind === "picked") this.shell.picked();
      else if (e.kind === "download") this.shell.download(e.filename, e.type, e.data);
      else this.store.post(e.path, e.body).then(() => { this.error = null; }, (err) => { this.error = String(err?.message ?? err); this.notify(); });
    }
    if (changed) this.notify();
  };

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private notify(): void {
    for (const fn of this.subs) fn();
  }
}
