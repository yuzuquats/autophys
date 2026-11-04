import { pageProposal } from "./derive/rounds.ts";
/**
 * Intent → the next selection plus effects: post a decision, save a file, tell the shell a
 * pick happened. `reduce` is pure; `Controller` holds the selection, runs the effects against
 * the Store and tells subscribers to redraw. It imports the ui's Intent type only.
 */
import { approvalsPath, type Snapshot } from "./api.ts";
import type { Investigation, Project, Workspace } from "./domain.ts";
import { latestFit, proposalLabel, statusText } from "./derive/shared.ts";
import {
  ancestors,
  connectionFailure,
  covers,
  defaultExpanded,
  defaultSelection,
  derive,
  displayedFields,
  empty,
  draftKey,
  parseSel,
  type Selection,
  type View,
} from "./derive/index.ts";
import {
  beginSetup,
  setupRequest,
  setupBody,
  setupDetails,
  type SetupSession,
} from "./derive/project-setup.ts";
import { projectRootId } from "./derive/tree.ts";
import { sig } from "./derive/fmt.ts";
import { type Decision, parseField } from "./proposal.ts";
import type { Store } from "./store.ts";
import type { Action } from "../ui/view-model.ts";
import type { Intent } from "../ui/intent.ts";
import { demoWrite, demoView } from "./tutorial.ts";

export type Env = { user: string; now: () => string; daemonOrigin?: string };

export type Effect =
  | { kind: "post"; path: string; body: Decision }
  | { kind: "pairing"; code: string; approve: boolean }
  | { kind: "download"; filename: string; type: string; data: string }
  | { kind: "picked" };

export type Step = { selection: Selection; effects: Effect[] };

export function initialSelection(ws: Workspace): Selection {
  return {
    projectId: ws.projects[0]?.id ?? "",
    selected: Object.fromEntries(
      ws.projects.map((p) => [p.id, defaultSelection(p)]),
    ),
    expanded: Object.fromEntries(
      ws.projects.map((p) => [p.id, [projectRootId(p), ...defaultExpanded(p)]]),
    ),
    drafts: {},
    edits: {},
  };
}

const none = (selection: Selection): Step => ({ selection, effects: [] });
const json = (filename: string, data: unknown): Effect => ({
  kind: "download",
  filename,
  type: "application/json",
  data: JSON.stringify(data, null, 2),
});
const without = <T>(r: Record<string, T>, keys: string[]) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

export function reduce(
  sel: Selection,
  snap: Snapshot,
  intent: Intent,
  env: Env,
): Step {
  const ws = snap.workspace;
  const owner = intent.kind === "select"
    ? ws.projects.find((p) => !!parseSel(p, intent.id))
    : intent.kind === "toggle"
    ? ws.projects.find((p) =>
      projectRootId(p) === intent.id ||
      p.investigations.some((inv) =>
        intent.id === inv.id || intent.id.startsWith(`${inv.id}/`)
      )
    )
    : undefined;
  if (owner && intent.kind === "select") sel = { ...sel, projectId: owner.id };
  const project = owner ?? ws.projects.find((p) => p.id === sel.projectId) ??
    ws.projects[0];
  // A refused write is shown until the next pick or decision.
  if (
    sel.notice &&
    (intent.kind === "select" || intent.kind === "switch" ||
      intent.kind === "action")
  ) sel = without(sel, ["notice"]) as Selection;
  if (intent.kind === "action") {
    const pairing = /^pair-(approve|deny):(.+)$/.exec(intent.name);
    if (pairing && snap.pairings?.some((p) => p.code === pairing[2])) {
      return {
        selection: sel,
        effects: [{
          kind: "pairing",
          code: pairing[2],
          approve: pairing[1] === "approve",
        }],
      };
    }
  }
  if (
    intent.kind === "action" &&
    (intent.name === "sdk-copied" || intent.name === "sdk-select")
  ) {
    return none({
      ...sel,
      copyStatus: intent.name === "sdk-copied" ? "copied" : "select",
    });
  }
  if (
    sel.copyStatus && (intent.kind === "switch" || intent.kind === "select")
  ) sel = without(sel, ["copyStatus"]) as Selection;
  if (!project) return none(sel);
  const selected = parseSel(project, sel.selected[project.id] ?? "");
  const decision = selected && "inv" in selected ? pageProposal(selected.inv) : undefined;
  const at = selected && "inv" in selected && decision ? { kind: "proposal" as const, inv: selected.inv, proposal: decision } : selected;
  switch (intent.kind) {
    case "select": {
      if (!parseSel(project, intent.id)) return none(sel);
      const open = new Set([
        ...(sel.expanded[project.id] ?? []),
        projectRootId(project),
        ...ancestors(intent.id),
      ]);
      return {
        selection: {
          ...sel,
          selected: { ...sel.selected, [project.id]: intent.id },
          expanded: { ...sel.expanded, [project.id]: [...open] },
        },
        effects: [{ kind: "picked" }],
      };
    }
    case "toggle": {
      const now = new Set(sel.expanded[project.id] ?? []);
      if (intent.open) now.add(intent.id);
      else now.delete(intent.id);
      return none({
        ...sel,
        expanded: { ...sel.expanded, [project.id]: [...now] },
      });
    }
    case "switch":
      return ws.projects.some((p) => p.id === intent.value) &&
          intent.value !== sel.projectId
        ? none({ ...sel, projectId: intent.value })
        : none(sel);
    case "field": {
      if (
        !intent.commit || at?.kind !== "proposal" ||
        at.proposal.status !== "proposed"
      ) return none(sel);
      const field = at.proposal.fields.find((f) => f.name === intent.name);
      if (!field) return none(sel);
      const key = draftKey(at.inv, at.proposal, field.name),
        parsed = parseField(field, intent.raw);
      const refused = parsed.ok
        ? covers(at.proposal, field, parsed.value)
        : parsed.message;
      if (refused || !parsed.ok) {
        return none({
          ...sel,
          drafts: {
            ...sel.drafts,
            [key]: { raw: intent.raw, message: refused! },
          },
        });
      }
      const edits = parsed.value === field.original
        ? without(sel.edits, [key])
        : { ...sel.edits, [key]: parsed.value };
      return none({ ...sel, drafts: without(sel.drafts, [key]), edits });
    }
    case "action": {
      const name = intent.name;
      if (name === "export") {
        return {
          selection: sel,
          effects: [
            json(`autophys-${snap.source}.json`, exportDocument(snap, sel)),
          ],
        };
      }
      const inv = at && "inv" in at ? at.inv : null;
      if (inv && name === "export-investigation") {
        return {
          selection: sel,
          effects: [
            json(`autophys-${inv.id}.json`, {
              demo: snap.source === "fixture",
              source: snap.source,
              investigation: inv,
            }),
          ],
        };
      }
      if (inv && name === "report") {
        return {
          selection: sel,
          effects: [{
            kind: "download",
            filename: `autophys-${inv.id}-report.md`,
            type: "text/markdown",
            data: reportText(snap, project, inv),
          }],
        };
      }
      if (at?.kind !== "proposal") return none(sel);
      const p = at.proposal,
        keys = p.fields.map((f) => draftKey(at.inv, p, f.name));
      const post = (body: Decision): Step => ({
        selection: { ...sel, edits: without(sel.edits, keys) },
        effects: [{ kind: "post", path: approvalsPath(at.inv.id, p.id), body }],
      });
      if (name === "approve" && p.status === "proposed") {
        if (keys.some((k) => sel.drafts[k])) return none(sel);
        const changed = displayedFields({ ...sel, ws }, at.inv, p).filter((f) =>
          f.value !== f.original
        );
        return post(
          changed.length
            ? {
              event: "edited",
              by: env.user,
              at: env.now(),
              fields: Object.fromEntries(changed.map((f) => [f.name, f.value])),
            }
            : { event: "approved", by: env.user, at: env.now() },
        );
      }
      if (name === "reject" && p.status === "proposed") {
        return post({ event: "rejected", by: env.user, at: env.now() });
      }
      const allowed = (e: Decision["event"]) =>
        !snap.events || snap.events.includes(e);
      if (
        name === "withdraw" && p.status === "approved" && allowed("unapproved")
      ) return post({ event: "unapproved" });
      if (
        name === "restore" && p.status === "rejected" && allowed("restored")
      ) return post({ event: "restored" });
      return none(sel);
    }
  }
}

/** The whole state as JSON: workspace (missing samples become null), selection, source. */
export function exportDocument(snap: Snapshot, sel: Selection) {
  return {
    demo: snap.source === "fixture",
    source: snap.source,
    gseq: snap.gseq,
    project: sel.projectId,
    selected: sel.selected,
    workspace: snap.workspace,
  };
}

export function reportText(
  snap: Snapshot,
  project: Project,
  inv: Investigation,
): string {
  const fit = latestFit(inv),
    lines = [`# ${project.name} · ${inv.name}`, "", statusText(inv).text, ""];
  if (fit?.sensitivity) {
    lines.push(
      `Fit #${fit.n}: χ²/N ${fit.chi2N.toFixed(2)} over ${
        fit.measurements.join(", ")
      }`,
    );
    for (const c of fit.sensitivity.combos) {
      lines.push(
        `- ${c.name} = ${sig(c.value, 4)} ± ${sig(c.logStd * 100, 2)}%`,
      );
    }
    for (const k of fit.sensitivity.identified) {
      lines.push(`- ${k} = ${sig(fit.params[k], 4)} (identified)`);
    }
    for (const k of fit.sensitivity.nonIdentified) {
      lines.push(`- ${k}: not identified`);
    }
  }
  for (const p of inv.proposals) {
    lines.push(
      "",
      `Proposal ${proposalLabel(p)}: ${p.status}${
        p.decidedBy ? ` by ${p.decidedBy} at ${p.decidedAt}` : ""
      }`,
    );
  }
  lines.push("", `Source: ${snap.source} at record ${snap.gseq}`);
  return lines.join("\n") + "\n";
}

/** Holds the selection, runs effects, and notifies redraws. The app layer gives it the shell's hands. */
export class Controller {
  private sel: Selection | null = null;
  private setup: SetupSession | null = null;
  private devicesActive = false;
  private startingRun = false;
  private setupDevices = false;
  private subs = new Set<() => void>();
  /** The last refused write; the details panel shows it (selection.notice) until the next pick. */
  error: string | null = null;
  shell: {
    download(filename: string, type: string, data: string): void;
    picked(): void;
  } = { download: () => {}, picked: () => {} };

  constructor(readonly store: Store, private env: Env) {
    store.subscribe(() => this.notify());
  }

  get selection(): Selection | null {
    const snap = this.store.snapshot();
    if (snap && !this.sel) this.sel = initialSelection(snap.workspace);
    if (snap && this.sel) {
      for (const p of snap.workspace.projects) {
        if (!(p.id in this.sel.selected)) {
          this.sel = {
            ...this.sel,
            selected: { ...this.sel.selected, [p.id]: defaultSelection(p) },
            expanded: {
              ...this.sel.expanded,
              [p.id]: [projectRootId(p), ...defaultExpanded(p)],
            },
          };
        }
      }

    }
    return this.sel;
  }

  view(): View {
    const snap = this.store.snapshot(), sel = this.selection;
    let view = derive(
      snap,
      sel ??
        { projectId: "", selected: {}, expanded: {}, drafts: {}, edits: {} },
      this.store.source.name,
    );
    const error = this.store.error;
    if (error) view = connectionFailure(view, error, !!snap);
    const selectedProject = snap?.workspace.projects.find(p => p.id === sel?.projectId);
    if (view.main.body.kind === "configuration" && selectedProject?.configs.at(-1)?.simulator.name === "thermal_rc" && this.store.source.projects) {
      view.main = { ...view.main, actions: [...view.main.actions, {
        name: "start-investigation", label: this.startingRun ? "Starting…" : "Start simulated investigation",
        variant: "primary", disabled: this.startingRun || !!error,
      }] };
    }
    if (this.setup && snap) {
      const origin = this.env.daemonOrigin ?? "";
      view = { ...view,
        main: { ...view.main, crumb: [{ label: "Workspace" }, { label: "New project" }], meta: "",
          actions: [{ name: "cancel-project", label: "Cancel", disabled: this.setup.busy }], body: { ...setupBody(this.setup, snap, origin), notice: this.setup.notice ?? sel?.notice }, credit: "" },
        details: setupDetails(this.setup, snap, origin, sel?.notice),
      };
    }
    if (this.devicesActive && snap) view = { ...view,
      sidebar: { ...view.sidebar, selectedId: "devices" },
      details: empty(snap.source, snap.pairings, sel?.notice).details,
    };
    if (error) {
      const pause = (a: Action): Action => /^(pair-(approve|deny):|approve$|reject$|withdraw$|restore$)/.test(a.name)
        ? { ...a, disabled: true, title: "Approvals are paused until the daemon reconnects" } : a;
      const pair = (a: [Action, Action]): [Action, Action] => [pause(a[0]), pause(a[1])];
      view.details = { ...view.details, decision: view.details.decision && pair(view.details.decision), actions: view.details.actions?.map(pause),
        sections: view.details.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => b.kind === "pairing" ? { ...b, decision: pair(b.decision) } : b) })) };

    }
    view = demoView(view, snap?.source ?? this.store.source.name);
    return { ...view, sidebar: { ...view.sidebar,
      creatingProject: !!this.setup,
    } };
  }

  /** Host-owned polling retries a failed workspace read. Setup writes refresh explicitly. */
  refresh(): Promise<void> {
    return this.store.error ? this.store.refreshWorkspace() : Promise.resolve();
  }

  exportDocument(): unknown {
    const snap = this.store.snapshot(), sel = this.selection;
    return snap && sel
      ? exportDocument(snap, sel)
      : { demo: true, source: this.store.source.name, loading: true };
  }

  /** The ui's intent handler (an arrow, so it can be passed as is). */
  handle = (intent: Intent): void => {
    const snap = this.store.snapshot(), sel = this.selection;
    if (!snap || !sel) return;
    if (intent.kind === "action" && demoWrite(snap.source, intent.name)) return;
    if (intent.kind === "action" && intent.name === "start-investigation") {
      const project = snap.workspace.projects.find(p => p.id === sel.projectId);
      const config = project?.configs.at(-1), projects = this.store.source.projects;
      if (!project || !config || !projects || this.store.error || this.startingRun) return;
      this.startingRun = true;
      this.settle((async () => {
        try {
          const { id } = await projects.start(project.id, config.hash);
          await this.store.refreshWorkspace();
          if (this.sel) this.sel = { ...this.sel, projectId: project.id,
            selected: { ...this.sel.selected, [project.id]: id },
            expanded: { ...this.sel.expanded, [project.id]: [`project:${project.id}`, id] } };
          this.shell.picked();
        } finally { this.startingRun = false; this.notify(); }
      })(), "Investigation not started");
      this.notify();
      return;
    }
    if (intent.kind === "action" && intent.name === "new-project") {
      if (!this.setup) {
        this.setupDevices = this.devicesActive;
        this.setup = beginSetup(snap);
      }
      this.devicesActive = false;
      this.shell.picked();
      this.notify();
      return;
    }
    if (this.setup && intent.kind === "field" && intent.name.startsWith("setup:")) {
      const key = intent.name.slice(6) as keyof SetupSession["draft"];
      if (key in this.setup.draft && !this.setup.busy) this.setup.draft[key] = intent.raw;
      return;
    }
    if (this.setup && intent.kind === "action" && intent.name.startsWith("setup-")) {
      const setup = this.setup;
      if (setup.busy) return;
      setup.notice = undefined;
      if (intent.name === "setup-back" && !setup.created) setup.step = 1;
      if (intent.name === "setup-next") {
        if (!setup.draft.name.trim()) setup.notice = "Enter a project name.";
        else setup.step = 2;
      }
      if (intent.name === "setup-create" || intent.name === "setup-start") {
        const projects = this.store.source.projects;
        if (this.store.error) setup.notice = "Reconnect to the daemon before saving or starting.";
        else if (!projects) setup.notice = "Open the live daemon to create a project. Demo data is read-only.";
        else {
          try {
            const request = setupRequest(setup);
            setup.busy = true;
            void (async () => {
              try {
                if (intent.name === "setup-create") {
                  setup.created = await projects.create(request);
                  setup.step = 3;
                  await this.store.refreshWorkspace();
                } else if (setup.created) {
                  const { project_id, config_version } = setup.created;
                  const { id } = await projects.start(project_id, config_version);
                  await this.store.refreshWorkspace();
                  if (this.setup === setup && this.sel) {
                    this.sel = { ...this.sel, projectId: project_id,
                      selected: { ...this.sel.selected, [project_id]: id },
                      expanded: { ...this.sel.expanded, [project_id]: [`project:${project_id}`, id] } };
                    this.setup = null;
                    this.shell.picked();
                  }
                }
              } catch (error) { setup.notice = String((error as Error)?.message ?? error); }
              finally { setup.busy = false; this.notify(); }
            })();
          } catch (error) { setup.notice = String((error as Error)?.message ?? error); }
        }
      }
      this.notify();
      return;
    }
    if (intent.kind === "action" && intent.name === "cancel-project") {
      this.setup = null;
      this.devicesActive = this.setupDevices;
      this.shell.picked();
      this.notify();
      return;
    }
    if (
      this.store.error && intent.kind === "action" &&
      /^(pair-(approve|deny):|approve$|reject$|withdraw$|restore$)/.test(
        intent.name,
      )
    ) return;
    if (intent.kind === "select") {
      if (intent.id !== "devices") this.setup = null;
      this.devicesActive = intent.id === "devices";
      if (this.devicesActive) {
        this.notify();
        return;
      }
    }
    const step = reduce(sel, snap, intent, this.env);
    const changed = step.selection !== sel;
    this.sel = step.selection;
    for (const e of step.effects) {
      if (e.kind === "picked") this.shell.picked();
      else if (e.kind === "download") {
        this.shell.download(e.filename, e.type, e.data);
      } else if (e.kind === "pairing") {
        this.settle(
          this.store.decidePairing(e.code, e.approve).then(() => {
            this.notify();
          }),
          `${e.approve ? "Approving" : "Denying"} ${e.code}`,
        );
      } else this.settle(this.store.post(e.path, e.body), "Not saved");
    }
    if (changed) this.notify();
  };

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** A write's outcome: a refusal becomes the visible notice; success clears it. */
  private settle(write: Promise<unknown>, what: string): void {
    write.then(() => {
      this.error = null;
      if (this.sel?.notice) {
        this.sel = without(this.sel, ["notice"]) as Selection;
        this.notify();
      }
    }, (err) => {
      this.error = `${what}: ${String(err?.message ?? err)}`;
      if (this.sel) this.sel = { ...this.sel, notice: this.error };
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of this.subs) fn();
  }
}
