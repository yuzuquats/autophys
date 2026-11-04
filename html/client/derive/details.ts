/** Details: one panel per node type, with the proposal's decision row. */
import { simulatorLabel, specOf } from "../config.ts";
import type { Fit, Investigation, Measurement, Project, ProjectConfig, Proposal, SensitivityResult } from "../domain.ts";
import { awaiting, type Decision, delivered, edited, expectedMeasurement, stateOf } from "../proposal.ts";
import type { Action, DetailsModel, Fact, Section, TableRow } from "../../ui/view-model.ts";
import { shortHash, int, pct, plural, sig } from "./fmt.ts";
import { configurationSections } from "./configuration.ts";
import { pairingExpiry } from "./pairing.ts";
import { rankingBars } from "./main.ts";
import { displayedFields, outlookAt } from "./outlook.ts";
import {
  configFor, investigationLabel, defaultSelection, draftKey, experimentsUsed, ids, latestConfig, latestFit, parseSel, plusMinus, projectOf, proposalLabel, rankOf, type State, statusText, unitOf,
} from "./shared.ts";


/** A non-identifiable direction as the parameters that move together: "overall scale (m, c, k)". */
export function directionText(s: SensitivityResult, i: number): string {
  const v = s.vectors[i], top = Math.max(...v.map(Math.abs)) || 1, e = v.map((x) => x / top);
  const sign = Math.sign(e.find((x) => Math.abs(x) > 0.5) ?? 1);
  const used = s.names.map((k, j) => [k, sign * e[j]] as const).filter(([, x]) => Math.abs(x) > 0.1);
  if (used.length > 1 && used.every(([, x]) => Math.abs(x - 1) < 0.15)) return `overall scale (${used.map(([k]) => k).join(", ")})`;
  return used.map(([k, x]) => `${k}^${sig(x, 2)}`).join(" · ");
}

/** Whether the source records this decision event (the daemon has no withdraw or restore). */
const allows = (s: State, e: Decision["event"]) => !s.events || s.events.includes(e);

function whereItStands(c: ProjectConfig, fit: Fit | null): Section {
  if (!fit) return { heading: "Where it stands", blocks: [{ kind: "text", text: "No converged fit yet", tone: "muted" }] };
  if (!fit.sensitivity && fit.identification) {
    const id = fit.identification;
    return { heading: "Where it stands", blocks: [{ kind: "facts", rows: [
      ...id.identified.map((k) => ({ label: k, value: `${sig(fit.params[k], 3)} ${unitOf(c, k)}`.trim(), tag: { text: "identified", tone: "ok" as const } })),
      ...id.nonIdentified.map((k) => ({ label: k, value: "", tag: { text: "not identified", tone: "warn" as const } })),
    ] }, { kind: "missing", title: "Not recorded yet", description: "Parameter uncertainties have not been recorded by the SDK." }] };
  }
  if (!fit.sensitivity) return { heading: "Where it stands", blocks: [{ kind: "text", text: `No sensitivity recorded at Fit #${fit.n}`, tone: "muted" }] };
  const s = fit.sensitivity;
  const rows: Fact[] = [
    ...s.combos.map((x) => ({ label: x.name, value: `${sig(x.value, 3)} ${pct(x.logStd)}` })),
    ...s.identified.map((k) => ({ label: k, value: `${sig(fit.params[k], 3)} ${plusMinus(c, k, s.marginal[k])}` })),
    ...s.nonIdentified.map((k) => ({ label: k, value: "", tag: { text: "not identified", tone: "warn" as const } })),
  ];
  return { heading: "Where it stands", blocks: [{ kind: "facts", rows }] };
}

function paramsTable(c: ProjectConfig, fit: Fit): TableRow[] {
  const s = fit.sensitivity;
  const rows: TableRow[] = c.params.map((p) => {
    const value = { text: sig(fit.params[p.name], 3), end: true };
    const name = { text: p.name, unit: p.unit };
    if (!fit.free.includes(p.name)) return { cells: [name, value, { text: "", tag: { text: "fixed", tone: "muted" as const }, end: true }] };
    if (!s) return { cells: [name, value, { text: "", end: true }] };
    if (s.nonIdentified.includes(p.name)) return { dim: true, cells: [name, value, { text: "", tag: { text: "ridge", tone: "warn" as const }, end: true }] };
    return { cells: [name, value, { text: "", tag: { text: plusMinus(c, p.name, s.marginal[p.name]), tone: "ok" as const }, end: true }] };
  });
  for (const x of s?.combos ?? []) rows.push({ cells: [{ text: x.name }, { text: sig(x.value, 3), end: true }, { text: "", tag: { text: pct(x.logStd), tone: "ok" }, end: true }] });
  return rows;
}

export function detailsModel(s: State): DetailsModel {
  const selected = selectedDetails(s);
  const m: DetailsModel = { ...selected, sections: selected.sections.map((section) => {
    const blocks = section.blocks.filter((b) => !(b.kind === "facts" || b.kind === "table" || b.kind === "bars" || b.kind === "meters") || b.rows.length > 0);
    return { ...section, blocks: blocks.length ? blocks : [{ kind: "missing", title: "Not recorded yet", description: "No values have been recorded for this section. They will appear when recorded by the SDK." }] };
  }) };
  // A refused write (a 409 from the daemon, say) stays visible above the panel until the next pick.
  return s.notice ? { ...m, sections: [{ heading: "Not saved", blocks: [{ kind: "text", text: s.notice, tone: "danger" }] }, ...m.sections] } : m;
}

function selectedDetails(s: State): DetailsModel {
  const project = projectOf(s);
  const sel = parseSel(project, s.selected[project.id] ?? "") ?? parseSel(project, defaultSelection(project))!;
  switch (sel.kind) {
    case "config": return configDetails(s, project);
    case "investigation": return investigationDetails(project, sel.inv);
    case "measurement": return measurementDetails(project, sel.inv, sel.m);
    case "awaiting": return awaitingDetails(project, sel.inv, sel.proposal, sel.id);
    case "fit": return fitDetails(project, sel.inv, sel.fit);
    case "sensitivity": return sensitivityDetails(project, sel.inv, sel.fit);
    case "proposal": return proposalDetails(s, project, sel.inv, sel.proposal);
    case "truth": return { icon: "validate", title: "Ground truth", status: { text: "Revealed after outcome" },
      sections: [{ heading: "Source", blocks: [{ kind: "text", text: "Synthetic: truth was hidden from the agent until the outcome." },
        { kind: "facts", rows: [{ label: "Source", value: sel.inv.reveal!.source }, { label: "Fit", value: `#${sel.inv.reveal!.fit_id}` }] }] }] };
    case "validate": return validateDetails(project, sel.inv);
  }
}

/** O-3: devices waiting to pair, each approvable here (or with `autophys pair approve` on the host). */
export function devices(s: Pick<State, "pairings">): { section: Section; actions: Action[] } | null {
  if (!s.pairings) return null;
  if (!s.pairings.length) return { section: { heading: "Devices", blocks: [{ kind: "text", text: "No pending connection requests. Connect the Python SDK to your daemon URL to request access, then approve its code here or with autophys pair.", tone: "muted" }] }, actions: [] };
  return {
    section: { heading: "Devices waiting to pair", blocks: s.pairings.map((p) => ({
      kind: "pairing", device: p.device, code: p.code, client: p.client || "Client not reported", expiry: pairingExpiry(p.expires),
      decision: [{ name: `pair-approve:${p.code}`, label: "Approve device", variant: "primary" }, { name: `pair-deny:${p.code}`, label: "Deny" }],
    })) }, actions: [],
  };
}

export function configDetails(s: State, project: Project): DetailsModel {
  const c = latestConfig(project), dev = devices(s);
  return {
    actions: dev?.actions.length ? dev.actions : undefined,
    icon: "config", title: "Configuration", status: { text: `v${c.version} · ${shortHash(c.hash)} · declared in code` },
    sections: [
      ...configurationSections(c),
      { heading: "Used by", blocks: [{ kind: "links", links: project.investigations.map((inv) => ({ label: `${investigationLabel(project, inv)} · v${inv.configVersion}${inv.configVersion === c.version ? "" : " (older)"}`, id: ids.inv(inv) })) }] },
      ...(dev ? [dev.section] : []),
    ],
  };
}

function investigationDetails(project: Project, inv: Investigation): DetailsModel {
  const c = configFor(project, inv), st = statusText(inv);
  const used = experimentsUsed(inv);
  return {
    icon: "investigation", title: investigationLabel(project, inv), status: st,
    sections: [
      { heading: "Budget", blocks: [{ kind: "meters", rows: [
        { label: "Agent steps", value: `${inv.budget.steps} / ${c.budgets.maxSteps}`, fraction: inv.budget.steps / c.budgets.maxSteps, tone: stateOf(inv) === "running" ? "run" : undefined },
        { label: "Simulations", value: `${int(inv.budget.simulations)} / ${int(c.budgets.maxSimulations)}`, fraction: inv.budget.simulations / c.budgets.maxSimulations },
        { label: "Experiments", value: `${used} / ${c.budgets.maxExperiments}`, fraction: used / c.budgets.maxExperiments },
      ] }] },
      whereItStands(c, latestFit(inv)),
      { heading: "Run", blocks: [{ kind: "facts", rows: [
        { label: "Investigation ID", value: inv.id }, { label: "Simulator", value: simulatorLabel(c) }, { label: "Source hash", value: c.simulator.sourceHash.slice(0, 6) || "–" },
        { label: "Config", value: `v${c.version} · ${c.hash.slice(0, 8)}` }, { label: "Free", value: inv.free.join(", ") },
        { label: "Policy", value: c.policy.label }, { label: "Seed", value: Number.isFinite(inv.seed) ? String(inv.seed) : "not recorded" },
      ] }] },
    ],
    actions: [{ name: "report", label: "Report" }, { name: "export-investigation", label: "Export" }],
  };
}

function measurementDetails(project: Project, inv: Investigation, m: Measurement): DetailsModel {
  const c = configFor(project, inv), spec = specOf(c, m.experiment);
  const settings: Fact[] = spec.settings.map((x) => ({ label: x.label, value: `${sig(m.settings[x.name] ?? x.default, 3)} ${x.unit}`.trim() }));
  if (m.inputRecorded === false) settings.push({ label: "Input series", value: "not recorded" });
  else if (!spec.input) settings.push({ label: "Force", value: "none" });
  const usedBy = inv.fits.filter((f) => f.measurements.includes(m.id)).map((f) => ({ label: `Fit #${f.n}`, id: ids.fit(inv, f) }));
  const fit = latestFit(inv);
  if (fit?.sensitivity && fit.measurements.includes(m.id)) usedBy.push({ label: "Sensitivity", id: ids.sens(inv) });
  const v = inv.validation;
  if ((v.state === "passed" || v.state === "failed") ? v.measurement === m.id : v.state === "summary" && v.measurements.includes(m.id)) usedBy.push({ label: "Validate", id: ids.validate(inv) });
  const missing = m.output.filter((y) => !Number.isFinite(y)).length;
  return {
    icon: "measurement", title: m.id, status: { text: `${m.split === "test" ? "Held out · " : ""}Uploaded ${m.uploadedAt} · ${m.source}` },
    sections: [
      { heading: "Experiment", blocks: [{ kind: "facts", rows: [{ label: "Type", value: spec.label }, ...settings] }] },
      { heading: "Samples", blocks: [{ kind: "facts", rows: [{ label: "Count", value: int(m.output.length) }, { label: "Rate", value: `${sig(m.rate, 3)} Hz` },
        { label: "Missing", value: String(missing), tone: missing ? "warn" : undefined }, { label: m.sigmaSource === "declared" ? "Noise σ (declared)" : "Noise σ (est.)", value: `${sig(m.sigmaEstimate, 3)} ${spec.output.unit}` }] }] },
      { heading: "Columns", blocks: [{ kind: "facts", rows: [{ label: "t", value: "time · s" }, ...(spec.input ? [{ label: spec.input.name, value: `input · ${spec.input.unit}` }] : []),
        { label: spec.output.name, value: `output · ${spec.output.unit}` }] }] },
      { heading: "Used by", blocks: usedBy.length ? [{ kind: "links", links: usedBy }] : [{ kind: "text", text: "Not used yet", tone: "muted" }] },
    ],
  };
}

function awaitingDetails(project: Project, inv: Investigation, p: Proposal, id: string): DetailsModel {
  const c = configFor(project, inv);
  return {
    icon: "measurement", title: id, status: { text: `Awaiting data · approved ${p.decidedAt}`, tone: "muted" },
    sections: [
      { heading: "Experiment", blocks: [{ kind: "facts", rows: [{ label: "Type", value: specOf(c, p.experiment).label }, ...p.fields.map((f) => ({ label: f.label, value: `${sig(f.value, 3)} ${f.unit}` }))] }] },
      { heading: "Waiting for data", blocks: [{ kind: "facts", rows: [{ label: "SDK", value: `${p.dataFrom} · polling` }, { label: "Expects", value: `${id}.csv` }] }] },
      { heading: "Requested by", blocks: [{ kind: "links", links: [{ label: proposalLabel(p), id: ids.proposal(inv, p) }] }] },
    ],
  };
}

function fitDetails(project: Project, inv: Investigation, fit: Fit): DetailsModel {
  const c = configFor(project, inv), running = fit.state === "running";
  const structured = Object.entries(fit.lag1).filter(([, r]) => Math.abs(r) > 0.3).map(([id]) => id);
  return {
    icon: "fit", title: `Fit #${fit.n}`,
    status: fit.state === "failed" ? { text: `Not converged · ${fit.evals} evals`, tone: "warn" } : running ? { text: `Running · ${fit.evals} evals`, tone: "run" } : { text: `Converged · ${fit.evals} evals · ${plural(fit.starts, "start")}${fit.variant ? ` · ${fit.variant}` : ""}` },
    sections: [
      { heading: "Parameters", blocks: [{ kind: "table", rows: paramsTable(c, fit) }] },
      { heading: "Quality", blocks: [{ kind: "facts", rows: [
        { label: "χ²/N", value: fit.chi2N.toFixed(2), tone: fit.chi2N > 2 ? "warn" : undefined },
        { label: "Residuals", value: running ? "–" : !Object.keys(fit.lag1).length ? "not recorded" : structured.length ? "structured" : "white", tone: structured.length ? "warn" : undefined },
        { label: "Loss", value: fit.loss === "linear" ? "least squares" : "soft L1" },
        { label: "Starts", value: fit.basins == null ? String(fit.starts) : `${fit.starts} → ${plural(fit.basins, "basin")}` },
        { label: "Data", value: fit.measurements.join(", ") },
      ] }] },
    ],
  };
}

function sensitivityDetails(project: Project, inv: Investigation, fit: Fit): DetailsModel {
  if (!fit.sensitivity && fit.identification) {
    const id = fit.identification, n = id.identified.length + id.nonIdentified.length;
    return {
      icon: "sensitivity", title: "Sensitivity", status: { text: `${id.identified.length} of ${n} identified · at Fit #${fit.n}`, tone: id.nonIdentified.length ? "warn" : undefined },
      sections: [{ heading: "Identifiability", blocks: [{ kind: "facts", rows: [
        { label: "Identified", value: id.identified.join(", ") || "none" },
        { label: "Not identified", value: id.nonIdentified.join(", ") || "none", tone: id.nonIdentified.length ? "warn" : undefined },
        { label: "Condition", value: id.condition == null ? "–" : id.condition > 1e6 ? "> 10⁶" : int(id.condition) },
      ] }, { kind: "missing", title: "Not recorded yet", description: "Singular values and directions have not been recorded by the SDK." }] }],
    };
  }
  const s = fit.sensitivity!, top = s.singular[0];
  const proposal = inv.proposals.find((p) => p.atFit === fit.n);
  const free = s.kinds.map((k, i) => (k === "identifiable" ? null : directionText(s, i))).filter((x): x is string => !!x);
  return {
    icon: "sensitivity", title: "Sensitivity", status: { text: `Rank ${rankOf(s)} of ${s.names.length} · at Fit #${fit.n}`, tone: rankOf(s) < s.names.length ? "warn" : undefined },
    sections: [
      { heading: "Singular values", blocks: [{ kind: "bars", rows: s.singular.map((v, i) => ({ label: `σ${"₁₂₃₄₅"[i] ?? i + 1}`, fraction: Math.max(0.01, v / top),
        value: s.kinds[i] === "structural" ? "≈ 0" : int(v), tone: s.kinds[i] === "identifiable" ? undefined : "warn" })) }] },
      { heading: "Directions", blocks: [{ kind: "facts", rows: [
        { label: "Pinned", value: (s.combos.length ? s.combos.map((x) => x.name) : s.identified).join(", ") || "none" },
        { label: "Free", value: free.join("; ") || "none", tone: free.length ? "warn" : undefined },
        { label: "Condition", value: s.condition > 1e6 ? "> 10⁶" : int(s.condition) },
      ] }] },
      { heading: "Hypothesis", blocks: [proposal ? { kind: "text", text: proposal.hypothesis, link: { label: "Proposal →", id: ids.proposal(inv, proposal) } }
        : { kind: "text", text: free.length ? "No experiment proposed yet" : "Every direction is pinned by the data", tone: "muted" }] },
    ],
  };
}


function proposalDetails(s: State, project: Project, inv: Investigation, p: Proposal): DetailsModel {
  const c = configFor(project, inv), changed = edited(p), spec = specOf(c, p.experiment);
  const shown = displayedFields(s, inv, p);
  const drafts = p.fields.map((f) => s.drafts[draftKey(inv, p, f.name)]);
  const look = outlookAt(p, shown);
  const sections: Section[] = [];
  if (p.status === "proposed" && p.outlook.axes.length) {
    sections.push({ heading: "Experiment", blocks: [{ kind: "fields", fields: shown.map((f, i) => ({ name: f.name, label: f.label, unit: f.unit, value: drafts[i]?.raw ?? sig(f.value, 3), invalid: drafts[i]?.message })) }] });
  } else {
    sections.push({ heading: "Experiment", blocks: [{ kind: "facts", rows: p.fields.map((f) => ({ label: f.label, value: `${sig(f.value, 3)} ${f.unit}`, note: f.value !== f.original ? `(was ${sig(f.original, 3)})` : undefined })) }] });
  }
  if (Object.keys(p.fixedSettings).length) sections[0].blocks.push({ kind: "facts", rows: Object.entries(p.fixedSettings).map(([label, value]) => ({ label, value: sig(value, 4) })) });
  if (!p.outlook.axes.length && !Object.keys(p.outlook.after).length) sections.push({ heading: "Outlook", blocks: [{ kind: "missing", title: "Not recorded yet", description: "This proposal has no outlook grid. Settings are read-only because edits cannot be scored; approve or reject the experiment as proposed." }] });
  const unedited = shown.every((f) => f.value === f.original);
  sections.push({ heading: "Expected", blocks: [{ kind: "facts", rows: [
    ...p.expected.map((e) => {
      const after = look ? look.after[e.param] ?? null : e.after;
      return { label: e.param, value: `${e.before === "unknown" ? "not recorded" : "unbounded"} → ${after == null ? "unbounded" : pct(after)}`, tone: after == null ? "warn" as const : undefined,
        tag: unedited || !look ? undefined : { text: "interpolated", tone: "muted" as const } };
    }),
    { label: "Budget after", value: `${experimentsUsed(inv) + (p.status === "proposed" ? 1 : 0)} / ${c.budgets.maxExperiments} experiments` },
  ] }] });
  const ranking = rankingBars(s, inv, p);
  sections.push({ heading: "Ranked against", blocks: [ranking.length ? { kind: "bars", rows: ranking } : { kind: "missing", title: "Not recorded yet", description: "No experiment ranking has been recorded by the SDK." }] });
  if (p.status === "approved") {
    const id = expectedMeasurement(inv, p);
    sections.push(delivered(inv, p)
      ? { heading: "Data", blocks: [{ kind: "facts", rows: [{ label: "Received", value: inv.measurements.filter((m) => m.experiment === p.experiment).map((m) => m.id).join(", ") }] }] }
      : { heading: "Waiting for data", blocks: [{ kind: "facts", rows: [{ label: "SDK", value: `${p.dataFrom} · polling` }, { label: "Expects", value: `${id}.csv` }] }] });
  }
  const status = p.status === "proposed" ? { text: unedited ? "Awaiting approval" : "Awaiting approval · edited" }
    : p.status === "approved" ? { text: `Approved by ${p.decidedBy} · ${p.decidedAt}${changed.length ? ` · edited (was ${changed.map((f) => sig(f.original, 3)).join(", ")})` : ""}`, tone: "ok" as const }
    : { text: `Rejected by ${p.decidedBy} · ${p.decidedAt}`, tone: "muted" as const };
  const invalid = drafts.some(Boolean);
  return {
    icon: "proposal", title: spec.label, cardName: true, status, sections,
    decision: p.status === "proposed" ? [{ name: "approve", label: "Approve", variant: "primary", disabled: invalid, title: invalid ? "Fix the marked field first" : undefined }, { name: "reject", label: "Reject" }] : undefined,
    actions: p.status === "approved" && !delivered(inv, p) && allows(s, "unapproved") ? [{ name: "withdraw", label: "Withdraw approval" }]
      : p.status === "rejected" && allows(s, "restored") ? [{ name: "restore", label: "Restore proposal" }] : undefined,
  };
}

function validateDetails(project: Project, inv: Investigation): DetailsModel {
  const v = inv.validation;
  if (v.state === "summary") {
    return { icon: "validate", title: "Validate", status: { text: v.passed ? "Passed" : "Failed", tone: v.passed ? "ok" : "warn" },
      sections: [{ heading: "Held-out check", blocks: [{ kind: "facts", rows: [
        { label: "Measurement", value: v.measurements.join(", ") || "–" },
        { label: "χ²/N", value: `${v.chi2N.toFixed(2)} (≤ ${sig(v.threshold, 3)})`, tone: v.passed ? "ok" : "warn" },
        { label: "Worst parameter", value: "not recorded" },
      ] }] }] };
  }
  if (v.state === "needs-data") {
    return { icon: "validate", title: "Validate", status: { text: "Needs data", tone: "muted" },
      sections: [{ heading: "Held-out check", blocks: [{ kind: "facts", rows: [{ label: "Measurement", value: inv.measurements.some((m) => m.split === "test") ? "check not recorded" : "none yet" }, { label: "Threshold", value: v.recorded === false ? "not recorded" : `χ²/N ≤ 2` }] }] }] };
  }
  const c = configFor(project, inv);
  return {
    icon: "validate", title: "Validate", status: { text: `${v.state === "passed" ? "Passed" : "Failed"} · ${pct(v.worst.relative)}`, tone: v.state === "passed" ? "ok" : "warn" },
    sections: [{ heading: "Held-out check", blocks: [{ kind: "facts", rows: [
      { label: "Measurement", value: v.measurement }, { label: "Fit", value: `Fit #${v.fit}` },
      { label: "χ²/N", value: `${v.chi2N.toFixed(2)} (≤ ${v.threshold})`, tone: v.state === "passed" ? "ok" : "warn" },
      { label: "Worst parameter", value: `${v.worst.param} ${pct(v.worst.relative)} (2σ, ${unitOf(c, v.worst.param)})` },
    ] }] }],
  };
}
