/** One workspace tree, with each project a collapsible root. */
import type { Fit, Investigation, Project } from "../domain.ts";
import {
  awaiting,
  delivered,
  expectedMeasurement,
  pendingDecisions,
  stateOf,
} from "../proposal.ts";
import type {
  SidebarModel,
  Trail,
  TreeNode,
} from "../../ui/view-model.ts";
import { int, pct } from "./fmt.ts";
import {
  ids,
  latestConfig,
  proposalLabel,
  parseSel,
  type State,
} from "./shared.ts";

export function investigationTrail(inv: Investigation): Trail | undefined {
  const state = stateOf(inv), pending = pendingDecisions(inv);
  if (pending) return { badge: "Approve", tone: "warn" };
  if (state === "running" && inv.progress) {
    return {
      spinner: true,
      text: `${inv.progress.done}/${inv.progress.total}`,
      tone: "run",
    };
  }
  if (
    state === "validated" &&
    (inv.validation.state === "passed" || inv.validation.state === "failed")
  ) return { text: pct(inv.validation.worst.relative), tone: "ok" };
  if (state === "validated") return { text: "validated", tone: "ok" };
  if (state === "inconclusive") return { text: "inconclusive", tone: "warn" };
  if (state === "awaiting-data") return { text: "waiting", tone: "muted" };
  return undefined;
}

export function fitNode(
  inv: Investigation,
  fit: Fit,
): TreeNode {
  const running = fit.state === "running";
  return {
    id: ids.fit(inv, fit),
    label: `Fit #${fit.n}`,
    icon: "fit",
    selectable: true,
    trail: fit.state === "failed"
      ? { text: "not converged", tone: "warn" }
      : running
      ? { spinner: true, text: `${fit.evals} evals`, tone: "run" }
      : {
        text: `χ² ${fit.chi2N.toFixed(2)}`,
        tone: fit.chi2N <= 2 ? "ok" : "warn",
      },
    children: null,
  };
}

export function investigationNode(
  project: Project,
  inv: Investigation,
): TreeNode {
  const data: TreeNode = {
    id: ids.data(inv),
    label: "Data",
    icon: "measurements",
    selectable: false,
    trail: { text: String(inv.measurements.length) },
    children: [
      ...inv.measurements.map((m): TreeNode => ({
        id: ids.measurement(inv, m.id),
        label: m.split === "test" ? `${m.id} · held out` : m.id,
        icon: "measurement",
        selectable: true,
        children: null,
        trail: { text: int(m.output.length) },
      })),
      ...awaiting(inv).map((p): TreeNode => ({
        id: ids.measurement(inv, expectedMeasurement(inv, p)),
        label: expectedMeasurement(inv, p),
        icon: "measurement",
        selectable: true,
        dim: true,
        children: null,
        trail: { text: "awaiting" },
      })),
    ],
  };
  const children: TreeNode[] = [
    data,
    ...inv.fits.map((f) => fitNode(inv, f)),
  ];
  for (const p of inv.proposals) {
    const trail: Trail = p.status === "proposed"
      ? { badge: "proposed", tone: "warn" }
      : p.status === "approved"
      ? { text: delivered(inv, p) ? "data in" : "approved", tone: "ok" }
      : { text: "rejected", tone: "muted" };
    children.push({
      id: ids.proposal(inv, p),
      label: proposalLabel(p),
      icon: "proposal",
      selectable: true,
      children: null,
      dim: p.status === "rejected",
      trail,
    });
  }
  return {
    id: ids.inv(inv),
    label: investigationName(project, inv),
    ...(inv.updatedUtc ? { title: inv.updatedUtc } : {}),
    icon: "investigation",
    selectable: true,
    trail: investigationTrail(inv),
    children,
  };
}

/** Opaque identifiers stay in Details and row tooltips, never in the label. */
export function investigationName(
  project: Project,
  inv: Investigation,
): string {
  const ordinal = project.investigations.indexOf(inv) + 1;
  const time = /(?:T|^|\s)(\d{1,2}:\d{2})/.exec(inv.updated)?.[1];
  return `Investigation ${ordinal}${time ? ` · ${time}` : ""}`;
}

export const projectRootId = (project: Project) => `project:${project.id}`;

export function devicesNode(waiting: number): TreeNode {
  const trail = waiting ? { badge: String(waiting), tone: "danger" as const,
    label: `${waiting} device${waiting === 1 ? "" : "s"} waiting to approve` } : undefined;
  return { id: "devices", label: "Devices", icon: "device", selectable: true, children: null, trail };
}

/** Fixture times mean today; daemon records carry their exact UTC time beside the local label. */
function recency({ updated, updatedUtc }: Investigation): number {
  if (updatedUtc) return Date.parse(updatedUtc.replace(" UTC", "Z").replace(" ", "T")) || 0;
  if (updated === "now") return Infinity;
  const time = /^(\d{1,2}):(\d{2})$/.exec(updated);
  if (time) return Number.MAX_SAFE_INTEGER - 1440 + Number(time[1]) * 60 + Number(time[2]);
  return Date.parse(updated) || 0;
}

/** Removed diagnostic leaves still locate their card; the rail selects its owning record. */
function railSelection(s: State): string | null {
  const id = s.selected[s.projectId];
  const project = s.ws.projects.find(p => p.id === s.projectId);
  const sel = project && id ? parseSel(project, id) : null;
  if (sel?.kind === "fit" || sel?.kind === "sensitivity") return ids.fit(sel.inv, sel.fit);
  if (sel?.kind === "validate" || sel?.kind === "truth") return ids.inv(sel.inv);
  return id ?? null;
}

export function sidebarModel(s: State): SidebarModel {
  const expandedIds = s.ws.projects.flatMap((p) =>
    s.expanded[p.id] ?? [projectRootId(p)]
  );
  return {
    switcher: {
      kind: "none",
      label: "Workspace",
      value: s.projectId,
      options: [],
    },
    pinned: devicesNode(s.pairings?.length ?? 0),
    section: { label: "Projects", count: String(s.ws.projects.length) },
    nodes: s.ws.projects.map((project): TreeNode => {
      const latest = project.configs.length ? latestConfig(project) : null;
      const config: TreeNode = {
        id: ids.config(project),
        label: "Configuration",
        icon: "config",
        selectable: true,
        children: null,
        trail: latest
          ? { text: `v${latest.version}` }
          : { badge: "not set", tone: "muted" },
      };
      const children = [
        config,
        ...project.investigations.toSorted((a, b) => recency(b) - recency(a)).map((inv) => investigationNode(project, inv)),
      ];
      if (!latest) {
        children.splice(1, 0, {
          id: `hint:${project.id}`,
          label: "wb.investigate(data, runner).run()",
          icon: "plus",
          selectable: false,
          children: null,
          dim: true,
        });
      }
      return {
        id: projectRootId(project),
        label: project.name,
        icon: "workspace",
        selectable: false,
        children,
        trail: { text: String(project.investigations.length), tone: "muted" },
      };
    }),
    treeLabel: "Projects and investigations",
    selectedId: railSelection(s),
    expandedIds,
  };
}
