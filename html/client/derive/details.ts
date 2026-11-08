/** Details: one panel per node type, with the proposal's decision row. */
import { simulatorLabel, specOf } from "../config.ts";
import type { Fit, Investigation, Project, ProjectConfig, Proposal, SensitivityResult } from "../domain.ts";
import { type Decision, delivered, edited, expectedMeasurement, stateOf } from "../proposal.ts";
import type { Action, DetailsModel, ExperimentHeader, Fact, Section, TableRow } from "../../ui/view-model.ts";
import { shortHash, int, pct, plural, sig } from "./fmt.ts";
import { configurationSections } from "./configuration.ts";
import { pairingExpiry } from "./pairing.ts";
import { displayedFields, outlookAt } from "./outlook.ts";
import {
  certaintyOf, configFor, investigationLabel, defaultSelection, draftKey, experimentsUsed, ids, latestConfig, latestFit, parseSel, plusMinus, projectOf, type State, statusText, unitOf, decisionProposal,
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
    const id = fit.identification, std = (k: string) => { const x = certaintyOf(fit, k); return x.kind === "identified" ? x.std : null; };
    const value = (k: string) => `${sig(fit.params[k], 3)} ${unitOf(c, k)}`.trim();
    return { heading: "Where it stands", blocks: [{ kind: "facts", rows: [
      ...id.identified.map((k) => { const s = std(k); return s == null
        ? { label: k, value: value(k), tag: { text: "identified", tone: "ok" as const } }
        : { label: k, value: `${sig(fit.params[k], 3)} ${plusMinus(c, k, s)}` }; }),
      ...id.nonIdentified.map((k) => ({ label: k, value: "", tag: { text: "not identified", tone: "warn" as const } })),
    ] }, ...(id.identified.every((k) => std(k) != null) ? [] : [{ kind: "missing" as const, title: "Not recorded yet", description: "Parameter uncertainties have not been recorded by the SDK." }])] };
  }
  if (!fit.sensitivity) return { heading: "Where it stands", blocks: [{ kind: "text", tone: "muted", text: fit.identificationSkipped
    ? `Identifiability not checked at Fit #${fit.n}: ${fit.identificationSkipped}`
    : `No sensitivity recorded at Fit #${fit.n}` }] };
  const s = fit.sensitivity;
  const rows: Fact[] = [
    ...s.combos.map((x) => ({ label: x.name, value: `${sig(x.value, 3)} ${pct(x.logStd)}` })),
    ...s.identified.map((k) => ({ label: k, value: `${sig(fit.params[k], 3)} ${plusMinus(c, k, s.marginal[k])}` })),
    ...s.nonIdentified.map((k) => ({ label: k, value: "", tag: { text: "not identified", tone: "warn" as const } })),
  ];
  return { heading: "Where it stands", blocks: [{ kind: "facts", rows }] };
}

export function paramsTable(c: ProjectConfig, fit: Fit): TableRow[] {
  const s = fit.sensitivity;
  const rows: TableRow[] = c.params.map((p) => {
    const value = { text: sig(fit.params[p.name], 3), end: true };
    const name = { text: p.name, unit: p.unit };
    const k = certaintyOf(fit, p.name);
    if (k.kind === "fixed") return { cells: [name, value, { text: "", tag: { text: "fixed", tone: "muted" as const }, end: true }] };
    if (k.kind === "unknown") return { cells: [name, value, { text: "", end: true }] };
    if (k.kind === "unchecked") return { cells: [name, value, { text: "", tag: { text: "not checked", tone: "muted" as const }, end: true }] };
    if (k.kind === "ridge") return { dim: true, cells: [name, value, { text: "", tag: { text: "ridge", tone: "warn" as const }, end: true }] };
    return { cells: [name, value, { text: "", tag: { text: k.std == null ? "identified" : plusMinus(c, p.name, k.std), tone: "ok" as const }, end: true }] };
  });
  for (const x of s?.combos ?? []) rows.push({ cells: [{ text: x.name }, { text: sig(x.value, 3), end: true }, { text: "", tag: { text: pct(x.logStd), tone: "ok" }, end: true }] });
  return rows;
}

/** Identifiability per free parameter from the recorded identification summary: verdict and ± when known. */
export function identificationTable(c: ProjectConfig, fit: Fit): TableRow[] {
  return fit.free.map((name) => {
    const k = certaintyOf(fit, name), label = { text: name, unit: unitOf(c, name) };
    if (k.kind === "ridge") return { dim: true, cells: [label, { text: "", tag: { text: "not identified", tone: "warn" as const } }, { text: "", end: true }] };
    if (k.kind === "identified") return { cells: [label, { text: "", tag: { text: "identified", tone: "ok" as const } }, { text: k.std == null ? "± not recorded" : plusMinus(c, name, k.std), end: true }] };
    return { cells: [label, { text: "", tag: { text: "not recorded", tone: "muted" as const } }, { text: "", end: true }] };
  });
}

export function detailsModel(s: State): DetailsModel {
  const selected = selectedDetails(s);
  const m: DetailsModel = { ...selected, sections: selected.sections.map((section) => {
    const blocks = section.blocks.filter((b) => !(b.kind === "facts" || b.kind === "table" || b.kind === "bars" || b.kind === "meters") || b.rows.length > 0);
    return { ...section, blocks: blocks.length ? blocks : [{ kind: "missing", title: "Not recorded yet", description: "No values have been recorded for this section. They will appear when recorded by the SDK." }] };
  }) };
  // A refused write (a 409 from the daemon, say) stays visible above the panel until the next pick.
  if (s.notice && "experiment" in m) {
    const experiment = (m as ExperimentCardDetails).experiment;
    return { ...m, experiment: { ...experiment, notice: s.notice } } as ExperimentCardDetails;
  }
  return s.notice ? { ...m, sections: [{ heading: "Not saved", blocks: [{ kind: "text", text: s.notice, tone: "danger" }] }, ...m.sections] } : m;
}

function selectedDetails(s: State): DetailsModel {
  const project = projectOf(s);
  const sel = parseSel(project, s.selected[project.id] ?? "") ?? parseSel(project, defaultSelection(project))!;
  if (sel.kind === "config") return configDetails(s, project);
  const proposal = decisionProposal(sel.inv, sel);
  if (!proposal || stateOf(sel.inv) === "running" && sel.kind !== "proposal") return investigationDetails(project, sel.inv);
  const decision = proposalDetails(s, project, sel.inv, proposal);
  const budget = investigationDetails(project, sel.inv).sections.find(x => x.heading === "Budget used")!;
  return { ...decision, sections: [...decision.sections, { ...budget, heading: "So far" }],
    actions: [...(decision.actions ?? []), { name: "report", label: "Report" }] };

}

/** O-3: devices waiting to pair, each approvable here (or with `autophys pair approve` on the host). */
export function devices(s: Pick<State, "pairings">): { section: Section; actions: Action[] } | null {
  if (!s.pairings) return null;
  if (!s.pairings.length) return { section: { heading: "Devices", blocks: [{ kind: "text", text: "No pending connection requests. Run autophys connect with your daemon URL on a device to request access, then approve its code here or with autophys pair approve.", tone: "muted" }] }, actions: [] };
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

function investigationDetails(project: Project, inv: Investigation): ExperimentCardDetails {
  const c = configFor(project, inv), state = stateOf(inv), fit = latestFit(inv);
  const st = state === "running" && !inv.progress ? { text: `Running · ${inv.host}`, tone: "run" as const } : statusText(inv);
  const used = experimentsUsed(inv);
  return {
    icon: "investigation", title: investigationLabel(project, inv), cardName: true, status: st,
    experiment: {
      key: JSON.stringify([project.id, inv.id]),
      caption: `${project.name} · ${investigationLabel(project, inv)}`,
      header: {
        project: project.name,
        investigation: { label: investigationLabel(project, inv), id: ids.inv(inv) },
        sourceFit: fit ? { label: `Fit #${fit.n}`, id: ids.fit(inv, fit) } : { label: "Not recorded" },
        state,
      },
    },
    sections: [
      ...(state === "running" ? [{ heading: "Progress", blocks: [{ kind: "facts" as const, rows: [
        { label: "Agent steps", value: inv.progress ? `${inv.progress.done} / ${inv.progress.total}` : "Not recorded" },
        { label: "Host", value: inv.host },
      ] }] }] : []),
      ...validationDetails(inv),
      { heading: "Budget used", blocks: [{ kind: "meters", rows: [
        { label: "Agent steps", value: `${inv.budget.steps} / ${c.budgets.maxSteps}`, fraction: inv.budget.steps / c.budgets.maxSteps, tone: stateOf(inv) === "running" ? "run" : undefined },
        { label: "Simulations", value: `${int(inv.budget.simulations)} / ${int(c.budgets.maxSimulations)}`, fraction: inv.budget.simulations / c.budgets.maxSimulations },
        { label: "Experiments", value: `${used} / ${c.budgets.maxExperiments}`, fraction: used / c.budgets.maxExperiments },
      ] }] },
      ...(latestFit(inv) ? [{ heading: "Result", blocks: [{ kind: "table" as const, rows: paramsTable(c, latestFit(inv)!) }] }] : [whereItStands(c, null)]),
      { heading: "Data", blocks: [{ kind: "links", links: inv.measurements.map(m => ({
        label: `${m.id} · ${m.split === "train" ? "train" : "held out"}`, id: ids.measurement(inv, m.id),
      })) }] },
      { heading: "Run", blocks: [{ kind: "facts", rows: [
        { label: "Investigation ID", value: inv.id }, { label: "Simulator", value: simulatorLabel(c) }, { label: "Source hash", value: shortHash(c.simulator.sourceHash) || "–" },
        { label: "Config", value: `v${c.version} · ${shortHash(c.hash)}` }, { label: "Free", value: inv.free.join(", ") },
        { label: "Policy", value: c.policy.label }, { label: "Seed", value: Number.isFinite(inv.seed) ? String(inv.seed) : "not recorded" },
      ] }] },
    ],
    actions: [{ name: "report", label: "Report" }],
    footnote: provenance(c, inv),
  };
}

/** Validation retains its recorded scope and evidence in the shared lifecycle card. */
function validationDetails(inv: Investigation): Section[] {
  const v = inv.validation;
  if (v.state === "needs-data") return inv.state === "validated" || inv.state === "inconclusive"
    ? [{ heading: "Validation", blocks: [{ kind: "missing", title: "No validation check recorded", description: "The investigation state has no recorded held-out check to inspect." }] }] : [];
  const passed = v.state === "summary" ? v.passed : v.state === "passed";
  return [{ heading: "Validation", caption: "Recorded held-out check; this result applies to the listed data.", blocks: [{ kind: "facts", rows: [
    { label: "Check", value: passed ? "Passed" : "Failed", tone: passed ? "ok" : "warn" },
    { label: "χ²/N", value: sig(v.chi2N, 3) },
    { label: "Acceptance threshold", value: `≤ ${sig(v.threshold, 3)}` },
    { label: "Measurement", value: v.state === "summary" ? v.measurements.join(", ") || "Not recorded" : v.measurement },
    ...(v.state === "summary" ? [{ label: "Worst parameter", value: "Not recorded" }] : [
      { label: "Fit", value: `Fit #${v.fit}` },
      { label: "Worst parameter", value: `${v.worst.param} ${pct(v.worst.relative)} (2σ relative)` },
    ]),
  ] }] }];
}

/** Local structural extension: client derivation does not import a UI renderer. */
type ExperimentCardDetails = DetailsModel & { experiment: { key: string; caption: string; header?: ExperimentHeader; notice?: string } };

function proposalDetails(s: State, project: Project, inv: Investigation, p: Proposal): ExperimentCardDetails {
  const c = configFor(project, inv), changed = edited(p), spec = specOf(c, p.experiment);
  const shown = displayedFields(s, inv, p);
  const drafts = p.fields.map((f) => s.drafts[draftKey(inv, p, f.name)]);
  const look = outlookAt(p, shown);
  const invalid = p.status === "proposed" && drafts.some(Boolean);
  const unedited = shown.every((f) => f.value === f.original);
  const sections: Section[] = [];
  {
    const blocks: Section["blocks"] = [];
    if (!p.preview.t.length) blocks.push({ kind: "text", tone: "muted", text: "No preview recorded: the SDK did not upload this experiment's drive or predicted response." });
    else {
    const ch = (x: { label: string; unit: string }) => `${x.label}${x.unit ? ` (${x.unit})` : ""}`;
    if (p.preview.input && spec.input) blocks.push({ kind: "wave", t: p.preview.t, y: p.preview.input, label: `${ch(spec.input)} as proposed`, caption: `Input · ${ch(spec.input)}` });
    blocks.push({ kind: "wave", t: p.preview.t, y: p.preview.predicted, label: `${ch(spec.output)} predicted at Fit #${p.atFit}`, caption: `Predicted · ${ch(spec.output)} at Fit #${p.atFit}` });
    }
    sections.push({ heading: "Preview", caption: invalid || !unedited ? "Recorded at the proposed settings; previews do not update with edits." : undefined, blocks });
  }
  const at = sections.length;
  if (p.status === "proposed" && p.outlook.axes.length) {
    sections.push({ heading: "Experiment", blocks: [{ kind: "fields", fields: shown.map((f, i) => ({ name: f.name, label: f.label, unit: f.unit, value: drafts[i]?.raw ?? sig(f.value, 3), invalid: drafts[i]?.message })) }] });
  } else {
    sections.push({ heading: "Experiment", blocks: [{ kind: "facts", rows: p.fields.map((f) => ({ label: f.label, value: `${sig(f.value, 3)} ${f.unit}`, note: f.value !== f.original ? `(was ${sig(f.original, 3)})` : undefined })) }] });
  }
  if (Object.keys(p.fixedSettings).length) sections[at].blocks.push({ kind: "facts", rows: Object.entries(p.fixedSettings).map(([name, value]) => {
    const setting = spec.settings.find((x) => x.name === name) ?? c.catalog.flatMap((e) => e.settings).find((x) => x.name === name);
    return { label: setting?.label ?? name, value: `${sig(value, 4)} ${setting?.unit ?? ""}`.trim() };
  }) });
  if (!p.outlook.axes.length && !Object.keys(p.outlook.after).length) sections.push({ heading: "Outlook", blocks: [{ kind: "missing", title: "Not recorded yet", description: "This proposal has no outlook grid. Settings are read-only because edits cannot be scored; approve or reject the experiment as proposed." }] });
  sections.push({ heading: "Expected", caption: invalid
    ? "Draft settings have not been evaluated. Fix the marked fields to use the recorded outlook."
    : "Predicted uncertainty (1σ), conditional on the recorded model and settings.", blocks: [{ kind: "facts", rows: [
    ...p.expected.map((e) => {
      if (invalid) return { label: e.param, value: "Not evaluated for draft settings", tone: "muted" as const };
      const after = look ? look.after[e.param] ?? null : e.after;
      return { label: e.param, value: `${e.before === "unknown" ? "not recorded" : "unbounded"} → ${after == null ? "unbounded" : pct(after)}`, tone: after == null ? "warn" as const : undefined,
        tag: unedited || !look ? undefined : { text: "interpolated", tone: "muted" as const } };
    }),
    { label: "Budget after", value: `${experimentsUsed(inv) + (p.status === "proposed" ? 1 : 0)} / ${c.budgets.maxExperiments} experiments` },
  ] }] });
  if (p.status === "approved") {
    const id = expectedMeasurement(inv, p);
    sections.push(delivered(inv, p)
      ? { heading: "Data", blocks: [{ kind: "facts", rows: [{ label: "Received", value: inv.measurements.filter((m) => m.experiment === p.experiment).map((m) => m.id).join(", ") }] }] }
      : { heading: "Waiting for data", blocks: [{ kind: "facts", rows: [{ label: "SDK", value: `${p.dataFrom} · polling` }, { label: "Expects", value: `${id}.csv` }] }] });
  }
  const sourceFit = inv.fits.find(f => f.n === p.atFit);
  const status = p.status === "proposed" ? { text: invalid ? "Awaiting approval · invalid settings" : unedited ? "Awaiting approval" : "Awaiting approval · edited" }
    : p.status === "approved" ? { text: `Approved by ${p.decidedBy} · ${p.decidedAt}${changed.length ? ` · edited (was ${changed.map((f) => sig(f.original, 3)).join(", ")})` : ""}`, tone: "ok" as const, title: p.decidedAtUtc ?? undefined }
    : { text: `Rejected by ${p.decidedBy} · ${p.decidedAt}`, tone: "muted" as const, title: p.decidedAtUtc ?? undefined };
  return {
    icon: "proposal", title: spec.label, cardName: true, status, sections,
    experiment: {
      key: JSON.stringify([project.id, s.selected[project.id] ?? defaultSelection(project), inv.id, p.id]),
      caption: `${investigationLabel(project, inv)} · ${p.id} · ranked at Fit #${p.atFit}`,
      header: {
        investigation: { label: investigationLabel(project, inv), id: ids.inv(inv) },
        proposal: `Proposal ${p.id}`,
        sourceFit: { label: `Fit #${p.atFit}`, ...(sourceFit ? { id: ids.fit(inv, sourceFit) } : {}) },
        state: p.status === "proposed" ? "pending" : p.status,
      },
    },
    footnote: `${provenance(c, inv)} · ranked at Fit #${p.atFit}`,
    decision: p.status === "proposed" ? [{ name: "approve", label: "Approve", variant: "primary", disabled: invalid, title: invalid ? "Fix the marked field first" : undefined }, { name: "reject", label: "Reject" }] : undefined,
    actions: p.status === "approved" && !delivered(inv, p) && allows(s, "unapproved") ? [{ name: "withdraw", label: "Withdraw approval" }]
      : p.status === "rejected" && allows(s, "restored") ? [{ name: "restore", label: "Restore proposal" }] : undefined,
  };
}

function provenance(c: ProjectConfig, inv: Investigation): string {
  return `${simulatorLabel(c)} · seed ${Number.isFinite(inv.seed) ? inv.seed : "not recorded"} · config v${c.version} · ${shortHash(c.hash)} · source ${shortHash(c.simulator.sourceHash) || "unrecorded"}`;
}
