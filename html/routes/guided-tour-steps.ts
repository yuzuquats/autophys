/** Lessons reference only rows present in the loaded account workspace. */
import type { Workspace } from "../client/domain.ts";
import { ids, latestFit, type Selection } from "../client/derive/shared.ts";

export type TourPart = {
  title: string; body: string; select?: string; details: boolean;
  surface: "sidebar" | "main" | "details"; target: string[]; group?: string;
};

export function tourSteps(ws: Workspace, selection: Selection | null, writable = true): TourPart[] {
  const project = ws.projects.find(p => p.id === selection?.projectId) ?? ws.projects[0];
  const steps: TourPart[] = [{ title: "Your workspace", body: "These are the projects available to your account. Each holds configurations and investigations.",
    select: project ? ids.config(project) : undefined, details: false, surface: "sidebar", target: [".ck-sidebar"] }];
  const setup: TourPart = { title: "Connect your next experiment", body: "New project configures a simulator. Devices connects an SDK or bench setup. Close this walkthrough to continue where you were.",
    details: false, surface: "sidebar", target: [".ap-new-project button", ".ap-devices"] };
  if (!writable) {
    setup.title = "Read-only workspace";
    setup.body = "You can explore these records and their evidence. Creating projects, editing proposals and connecting devices requires write access.";
    setup.target = [".ck-sidebar"];
  }
  if (!project && !writable) return [steps[0], { ...setup, title: "No projects yet", body: "This account has no projects yet. Records will appear when its owner adds them; this walkthrough does not create sample data." }];
  if (!project) return [steps[0], { ...setup, title: "Create your first project", body: "Choose New project to configure a simulator, or Devices to connect your SDK. Measurements and results appear here once recorded." }];
  steps.push({ title: "A project's configuration", body: project.configs.length ? "This project's recorded model, parameters and experiment settings define what each investigation can explore." : "This project has no recorded configuration yet. Connect its SDK or create a configured project to begin.",
    select: ids.config(project), details: false, surface: "main", target: [".ap-viewer"] });
  if (!project.configs.length) return [...steps, setup];
  const selected = selection?.selected[project.id]?.split("/")[0];
  const inv = project.investigations.find(i => i.id === selected) ?? project.investigations.find(i => latestFit(i)) ?? project.investigations[0];
  if (!inv) return [...steps, setup];
  steps.push({ title: "Open an investigation", body: "This recorded investigation groups its measurements, fits, proposals and outcome. Its summary shows the evidence collected so far.",
    select: inv.id, details: true, surface: "main", target: [".ap-viewer"] });
  const measured = inv.measurements.length ? inv : project.investigations.find(i => i.measurements.length);
  if (measured) steps.push({ title: "Read the measured data", body: "These samples were recorded for this investigation. The measurement settings and train or held-out split explain how the data is used.",
    select: ids.measurement(measured, measured.measurements[0].id), details: false, surface: "main", target: [".ap-viewer"] });
  const fitted = latestFit(inv) ? inv : project.investigations.find(i => latestFit(i));
  const fit = fitted && latestFit(fitted);
  if (fitted && fit) steps.push(
    { title: "Read a fit", body: "Compare the recorded model prediction with measured samples. Missing chart series remain explicitly unrecorded.", select: ids.view(fitted, fit, "fit"), details: true, surface: "main", target: [".ap-viewer"], group: "fit" },
    { title: "Check the residuals", body: "Residuals show the difference between measurement and prediction. Patterns can point to behavior the model has not explained.", select: ids.view(fitted, fit, "residuals"), details: true, surface: "main", target: [".ap-viewer"], group: "fit" },
    { title: "See what the data pins down", body: "The recorded sensitivity analysis shows which parameters the data separates, and which remain coupled or uncertain.", select: ids.sens(fitted), details: true, surface: "main", target: [".ap-viewer"] },
  );
  const proposed = (inv.proposals.length ? inv : undefined) ?? project.investigations.find(i => i.proposals.some(p => p.status === "proposed")) ?? project.investigations.find(i => i.proposals.length);
  const proposal = proposed?.proposals.find(p => p.status === "proposed") ?? proposed?.proposals.at(-1);
  if (proposed && proposal) steps.push({ title: "Review the next experiment", body: "This is an actual recorded proposal. Review its reasoning and settings. Approvals and edits affect this investigation, subject to your account permissions.",
    select: ids.proposal(proposed, proposal), details: true, surface: "details", target: [".ck-details .ck-panel-body"] });
  const validated = inv.validation.state !== "needs-data" ? inv : project.investigations.find(i => i.validation.state !== "needs-data");
  if (validated) steps.push({ title: "Check the validation", body: "This investigation's held-out check tests the fitted model against separate measurements. Read the recorded verdict and its evidence.",
    select: ids.validate(validated), details: true, surface: "main", target: [".ap-viewer"] });
  // Cross-investigation lessons state their source instead of implying one run.
  for (const step of steps) {
    const record = project.investigations.find(i => step.select === i.id || step.select?.startsWith(i.id + "/"));
    if (record) step.body = `${project.name} · ${record.name || record.id}. ${step.body}`;
  }
  return [...steps, setup];
}
