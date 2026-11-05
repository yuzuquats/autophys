import type { Workspace } from "../client/domain.ts";
import { ids, latestFit } from "../client/derive/shared.ts";

export type TourPart = { title: string; body: string; select?: string; details: boolean; surface: "sidebar" | "main" | "details"; target: string[]; label: string };
export type TourStep = readonly TourPart[];
/** Select the same public row ids as the ordinary sidebar; no shadow selection state. */
export function tourSteps(ws: Workspace): TourStep[] {
  const project = ws.projects.find(p => p.id === "bench-oscillators") ?? ws.projects[0];
  const inv = project.investigations.find(i => i.proposals.some(p => p.status === "proposed") && latestFit(i))!;
  const fit = latestFit(inv)!, proposal = inv.proposals.find(p => p.status === "proposed")!;
  const row = (id: string) => "row:" + id;
  const config = ids.config(project), fitId = ids.view(inv, fit, "fit"), residuals = ids.view(inv, fit, "residuals");
  return [
    [{ title: "Your workspace", body: "Projects live here. Each holds configurations and the investigations run against them.", select: config, details: false, surface: "sidebar", target: [".ck-sidebar"], label: "Workspace sidebar · clipped" }],
    [{ title: "A project's configuration", body: "The model, device, inputs and budget the reasoner works within. Investigations reuse it.", select: config, details: true, surface: "sidebar", target: [row(config)], label: "Configuration row · clipped" }],
    [{ title: "Open an investigation", body: "Its measurements, fits, sensitivity, proposals and validation are rows under it.", select: inv.id, details: false, surface: "sidebar", target: [row(inv.id)], label: "Investigation row · clipped" }],
    [{ title: "Read the measured data", body: "Measurements are the evidence each fit is tested against. Select a measurement to inspect its samples.", select: ids.measurement(inv, inv.measurements[0].id), details: false, surface: "main", target: [".ap-viewer"], label: "Measured data · clipped" }],
    [
      { title: "Read a fit", body: "Measured points against the fitted curve. Parameters and Identifiability sit beside the fit; Details keeps the next decision.", select: fitId, details: true, surface: "main", target: [".ap-viewer"], label: "Fit chart · clipped · 1 of 2" },
      { title: "Check the residuals", body: "No structure left over means the model explains the data. A wave here means a missing term.", select: residuals, details: true, surface: "main", target: [".ap-viewer", row(residuals)], label: "Residuals · clipped · 2 of 2" },
    ],
    [{ title: "See what the data pins down", body: "Sensitivity shows which parameters the data separates, and which still move together.", select: ids.sens(inv), details: true, surface: "main", target: [".ap-viewer"], label: "Sensitivity · clipped" }],
    [{ title: "Decide the next experiment", body: "The reasoner proposes a run. You approve or reject it — on your own data, not here.", select: ids.proposal(inv, proposal), details: true, surface: "details", target: [".ck-decision"], label: "Proposed experiment · disabled on demo data" }],
    [{ title: "Check the validation", body: "A separate experiment tests the fitted model. The verdict tells you whether more evidence is needed.", select: ids.validate(inv), details: true, surface: "main", target: [".ap-viewer"], label: "Validation · clipped" }],
    [{ title: "Start your own", body: "New project sets one up; Devices pairs bench hardware. Done takes you back where you were.", select: config, details: false, surface: "sidebar", target: [".ap-new-project button", ".ap-devices"], label: "New project + Devices · clipped" }],
  ];
}
