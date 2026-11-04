/** One workspace tree, with each project a collapsible root. */
import type { Fit, Investigation, Project, ProjectConfig } from "../domain.ts";
import {
  awaiting,
  delivered,
  expectedMeasurement,
  pendingDecisions,
  stateOf,
} from "../proposal.ts";
import type {
  IconName,
  SidebarModel,
  Trail,
  TreeNode,
} from "../../ui/view-model.ts";
import { type View, VIEW_LABEL, viewsOf } from "./charts.ts";
import { int, pct } from "./fmt.ts";
import {
  configFor,
  ids,
  latestConfig,
  latestFit,
  proposalLabel,
  rankOf,
  type State,
} from "./shared.ts";

const VIEW_ICON: Record<View, IconName> = {
  fit: "view",
  residuals: "residuals",
  landscape: "landscape",
  envelope: "envelope",
  frequency: "frequency",
  "zoom:edges": "zoom",
};

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
  config: ProjectConfig,
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
    children: fit.state !== "converged"
      ? null
      : viewsOf(config, inv, fit).map((v) => ({
        id: ids.view(inv, fit, v),
        label: VIEW_LABEL[v],
        icon: VIEW_ICON[v],
        selectable: true,
        children: null,
      })),
  };
}

export function investigationNode(
  project: Project,
  inv: Investigation,
): TreeNode {
  const config = configFor(project, inv);
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
    ...inv.fits.map((f) => fitNode(config, inv, f)),
  ];
  const fit = latestFit(inv);
  if (fit?.sensitivity) {
    const rank = rankOf(fit.sensitivity), n = fit.sensitivity.names.length;
    children.push({
      id: ids.sens(inv),
      label: "Sensitivity",
      icon: "sensitivity",
      selectable: true,
      children: null,
      trail: { text: `rank ${rank}/${n}`, tone: rank < n ? "warn" : "muted" },
    });
  } else if (fit?.identification) {
    const { identified, nonIdentified } = fit.identification,
      n = identified.length + nonIdentified.length;
    children.push({
      id: ids.sens(inv),
      label: "Sensitivity",
      icon: "sensitivity",
      selectable: true,
      children: null,
      trail: {
        text: `${identified.length}/${n}`,
        tone: nonIdentified.length ? "warn" : "muted",
      },
    });
  }
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
  const v = inv.validation;
  children.push({
    id: ids.validate(inv),
    label: "Validate",
    icon: "validate",
    selectable: true,
    children: null,
    dim: v.state === "needs-data",
    trail: v.state === "needs-data"
      ? { text: "needs data" }
      : v.state === "summary"
      ? { text: v.passed ? "passed" : "failed", tone: v.passed ? "ok" : "warn" }
      : {
        text: v.state === "passed" ? pct(v.worst.relative) : "failed",
        tone: v.state === "passed" ? "ok" : "warn",
      },
  });
  return {
    id: ids.inv(inv),
    label: investigationName(project, inv),
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

/** Fixture times mean today; daemon labels contain a month/day/time in UTC. */
function recency(updated: string): number {
  if (updated === "now") return Infinity;
  const time = /^(\d{1,2}):(\d{2})$/.exec(updated);
  if (time) return Number.MAX_SAFE_INTEGER - 1440 + Number(time[1]) * 60 + Number(time[2]);
  return Date.parse(updated) || 0;
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
        ...project.investigations.toSorted((a, b) => recency(b.updated) - recency(a.updated)).map((inv) => investigationNode(project, inv)),
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
    selectedId: s.selected[s.projectId] ?? null,
    expandedIds,
  };
}
