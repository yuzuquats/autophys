/** The sidebar: project switcher, the pinned Configuration row and the investigation tree. */
import type { Fit, Investigation, Project, ProjectConfig } from "../domain.ts";
import { awaiting, delivered, expectedMeasurement, pendingDecisions, stateOf } from "../proposal.ts";
import type { IconName, SidebarModel, Trail, TreeNode } from "../../ui/view-model.ts";
import { type View, VIEW_LABEL, viewsOf } from "./charts.ts";
import { int, pct } from "./fmt.ts";
import { configFor, ids, latestConfig, latestFit, projectOf, proposalLabel, rankOf, type State } from "./shared.ts";


const VIEW_ICON: Record<View, IconName> = { fit: "view", residuals: "residuals", landscape: "landscape", envelope: "envelope", frequency: "frequency", "zoom:edges": "zoom" };

export function investigationTrail(inv: Investigation): Trail | undefined {
  const state = stateOf(inv), pending = pendingDecisions(inv);
  if (state === "running" && inv.progress) return { spinner: true, text: `${inv.progress.done}/${inv.progress.total}`, tone: "run" };
  if (state === "validated" && (inv.validation.state === "passed" || inv.validation.state === "failed")) return { text: pct(inv.validation.worst.relative), tone: "ok" };
  if (state === "validated") return { text: "validated", tone: "ok" };
  if (state === "inconclusive") return { text: "inconclusive", tone: "warn" };
  if (pending) return { badge: String(pending) };
  if (state === "awaiting-data") return { text: "waiting", tone: "muted" };
  return undefined;
}

export function fitNode(config: ProjectConfig, inv: Investigation, fit: Fit): TreeNode {
  const running = fit.state === "running";
  return {
    id: ids.fit(inv, fit), label: `Fit #${fit.n}`, icon: "fit", selectable: true,
    trail: fit.state === "failed" ? { text: "not converged", tone: "warn" } : running ? { spinner: true, text: `${fit.evals} evals`, tone: "run" } : { text: `χ² ${fit.chi2N.toFixed(2)}`, tone: fit.chi2N <= 2 ? "ok" : "warn" },
    children: fit.state !== "converged" ? null : viewsOf(config, inv, fit).map((v) => ({ id: ids.view(inv, fit, v), label: VIEW_LABEL[v], icon: VIEW_ICON[v], selectable: true, children: null })),
  };
}

export function investigationNode(project: Project, inv: Investigation): TreeNode {
  const config = configFor(project, inv);
  const data: TreeNode = {
    id: ids.data(inv), label: "Measurements", icon: "measurements", selectable: false, trail: { text: String(inv.measurements.length) },
    children: [
      ...inv.measurements.map((m): TreeNode => ({ id: ids.measurement(inv, m.id), label: m.split === "test" ? `${m.id} · held out` : m.id, icon: "measurement", selectable: true, children: null,
        trail: { text: int(m.output.length) } })),
      ...awaiting(inv).map((p): TreeNode => ({ id: ids.measurement(inv, expectedMeasurement(inv, p)), label: expectedMeasurement(inv, p), icon: "measurement", selectable: true, dim: true, children: null,
        trail: { text: "awaiting" } })),
    ],
  };
  const children: TreeNode[] = [data, ...inv.fits.map((f) => fitNode(config, inv, f))];
  const fit = latestFit(inv);
  if (fit?.sensitivity) {
    const rank = rankOf(fit.sensitivity), n = fit.sensitivity.names.length;
    children.push({ id: ids.sens(inv), label: "Sensitivity", icon: "sensitivity", selectable: true, children: null, trail: { text: `rank ${rank}/${n}`, tone: rank < n ? "warn" : "muted" } });
  } else if (fit?.identification) {
    const { identified, nonIdentified } = fit.identification, n = identified.length + nonIdentified.length;
    children.push({ id: ids.sens(inv), label: "Sensitivity", icon: "sensitivity", selectable: true, children: null, trail: { text: `${identified.length}/${n} identified`, tone: nonIdentified.length ? "warn" : "muted" } });
  }
  for (const p of inv.proposals) {
    const trail: Trail = p.status === "proposed" ? { text: "proposed" } : p.status === "approved" ? { text: delivered(inv, p) ? "data in" : "approved", tone: "ok" } : { text: "rejected", tone: "muted" };
    children.push({ id: ids.proposal(inv, p), label: proposalLabel(p), icon: "proposal", selectable: true, children: null, dim: p.status === "rejected", trail });
  }
  const v = inv.validation;
  children.push({ id: ids.validate(inv), label: "Validate", icon: "validate", selectable: true, children: null, dim: v.state === "needs-data",
    trail: v.state === "needs-data" ? { text: "needs data" } : v.state === "summary" ? { text: v.passed ? "passed" : "failed", tone: v.passed ? "ok" : "warn" }
      : { text: v.state === "passed" ? pct(v.worst.relative) : "failed", tone: v.state === "passed" ? "ok" : "warn" } });
  return { id: ids.inv(inv), label: inv.name, icon: "investigation", selectable: true, trail: investigationTrail(inv), children };
}

export function sidebarModel(s: State): SidebarModel {
  const project = projectOf(s), latest = latestConfig(project);
  return {
    switcher: { label: "Project", value: project.id, options: s.ws.projects.map((p) => ({ value: p.id, label: p.name })) },
    pinned: { id: ids.config(project), label: "Configuration", icon: "config", selectable: true, children: null,
      // Devices waiting to pair are approved from the Configuration panel (O-3).
      trail: s.pairings?.length ? { badge: String(s.pairings.length) } : { text: `v${latest.version}` } },
    section: { label: "Investigations", count: String(project.investigations.length), add: { name: "new-investigation", label: "New investigation", disabled: true, title: "Investigations start from the SDK" } },
    nodes: project.investigations.map((inv) => investigationNode(project, inv)),
    treeLabel: `${project.name} investigations`,
    selectedId: s.selected[project.id] ?? null,
    expandedIds: s.expanded[project.id] ?? [],
  };
}
