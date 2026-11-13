/** Compact evidence for a document insert; no invented results or model evaluation. */
import type { Investigation, Project } from "../domain.ts";
import type { InvestigationSummary } from "../../ui/view-model.ts";
import { stateOf } from "../proposal.ts";
import { ids, investigationLabel, latestFit } from "./shared.ts";

export function investigationSummary(project: Project, inv: Investigation): InvestigationSummary {
  const fit = latestFit(inv), diagnosis = fit?.sensitivity ?? fit?.identification;
  const validation = inv.validation;
  const checked = validation.state !== "needs-data";
  const current = checked && (validation.state === "summary" || validation.fit === fit?.n);
  const passed = checked && (validation.state === "summary" ? validation.passed : validation.state === "passed");
  const complete = inv.state === "validated" || inv.state === "inconclusive";
  const state = stateOf(inv);
  const waiting = { "awaiting-approval": "Awaiting approval", "awaiting-data": "Awaiting data",
    "awaiting-agent": "Awaiting agent", running: "Running", validated: "Complete", inconclusive: "Complete" };
  const status = complete ? current ? passed ? "Complete · validated" : "Complete · failed validation"
    : checked ? "Complete · validation out of date" : diagnosis?.nonIdentified.length ? "Complete · unresolved" : "Complete · validation not recorded" : waiting[state];
  const finding = !fit ? "No converged fit recorded." : !diagnosis ? "Parameter identification not recorded."
    : inv.free.length > 0 && inv.free.every(name => diagnosis.identified.includes(name)) ? "All free parameters identified."
    : [diagnosis.identified.length ? diagnosis.identified.join(", ") + " identified" : "No free parameters identified",
      diagnosis.nonIdentified.length ? diagnosis.nonIdentified.join(", ") + " unresolved" : ""].filter(Boolean).join("; ") + ".";
  const evidence = checked
    ? `Held-out χ²/N ${Number.isFinite(validation.chi2N) ? validation.chi2N.toFixed(2) : "not recorded"} · ${passed ? "passed" : "failed"} threshold ${Number.isFinite(validation.threshold) ? validation.threshold.toFixed(2) : "not recorded"}${!current ? ` (Fit #${validation.fit})` : ""}`
    : "Held-out validation not recorded.";
  const checkIds = !checked ? [] : validation.state === "summary" ? validation.measurements : [validation.measurement];
  const checkData = checkIds.map(id => inv.measurements.find(m => m.id === id));
  const samples = checkData.length && checkData.every(m => m != null)
    ? checkData.reduce((n, m) => n + m!.output.filter(Number.isFinite).length, 0) : 0;
  const checkCount = samples ? `${samples.toLocaleString("en-US")} ` : "";
  const check = !checked ? "Prediction check not yet recorded."
    : !current ? "Prediction check belongs to an earlier model."
    : passed ? `Prediction check passed on ${checkCount}measurements excluded from fitting.`
    : `Prediction check failed on ${checkCount}measurements excluded from fitting.`;
  const config = project.configs.find(c => c.version === inv.configVersion);
  const parameters = fit ? inv.free.flatMap(name => {
    const value = fit.params[name];
    if (!Number.isFinite(value)) return [];
    const unit = config?.params.find(p => p.name === name)?.unit ?? "";
    const unresolved = diagnosis?.nonIdentified.includes(name);
    return [{ label: name, value: unresolved ? "Unresolved" : `${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })} ${unit}`.trim() }];
  }) : [];
  const outputs: InvestigationSummary["outputs"] = [];
  if (fit) outputs.push({ label: `Parameters · Fit #${fit.n}`, id: ids.fit(inv, fit) });
  for (const measurement of inv.measurements) outputs.push({ label: measurement.id, id: ids.measurement(inv, measurement.id) });
  for (const proposal of inv.proposals) outputs.push({ label: "Proposal · " + proposal.experiment, id: ids.proposal(inv, proposal) });
  if (checked) outputs.push({ label: "Validation result", id: ids.validate(inv) });
  const title = investigationLabel(project, inv), ordinal = `Investigation ${project.investigations.indexOf(inv) + 1}`;
  return { id: inv.id, title, caption: title === ordinal ? "" : ordinal, status,
    tone: complete && current && passed ? "ok" : complete || state === "awaiting-approval" ? "warn" : "muted",
    finding, evidence, check, parameters, outputs };
}
