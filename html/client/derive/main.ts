/** The main column: crumb, meta, the viewer's panels and one credit line. */
import type { Investigation, Measurement, Project, ProjectConfig, Proposal } from "../domain.ts";
import type { BarRow, ChartPanel, InvestigationBody, InvestigationCard, MainModel, RangesChart, Section, TableRow, TraceRow } from "../../ui/view-model.ts";
import {
  configPanels, edgePanels, envelopePanels, fitPanels, frequencyPanels, landscapeChart, measurementPanels, sensitivityPanels,
  validationPanels,
} from "./charts.ts";
import { truthPanels } from "./truth.ts";
import { identificationTable, paramsTable } from "./details.ts";
import { anchor, investigationRounds, investigationTarget, measurementAnchor, roundAnchor } from "./rounds.ts";
import { stateOf } from "../proposal.ts";
import { configurationSections, experimentSections, knownSection } from "./configuration.ts";
import { simulatorLabel, specOf } from "../config.ts";
import { engineering, int, shortHash, sig, pct } from "./fmt.ts";
import { displayedFields, outlookAt } from "./outlook.ts";
import { configFor, investigationLabel, defaultSelection, ids, experimentsUsed, latestConfig, latestFit, parseSel, projectOf, proposalLabel, rankOf, type State, type Sel, statusText, plusMinus, certaintyOf } from "./shared.ts";



/** Acquisition facts belong to the recorded measurement, not catalog defaults. */
function acquisitionPanel(c: ProjectConfig, inv: Investigation, m: Measurement): ChartPanel {
  const spec = specOf(c, m.experiment), missing = m.output.filter(y => !Number.isFinite(y)).length;
  const settings = [...new Set([...spec.settings.map(x => x.name), ...Object.keys(m.settings)])].map(name => {
    const setting = spec.settings.find(x => x.name === name), value = m.settings[name];
    return { label: setting?.label ?? name, value: value == null ? "not recorded" : (sig(value, 3) + " " + (setting?.unit ?? "")).trim() };
  });
  const usedBy = inv.fits.filter(f => f.measurements.includes(m.id)).map(f => ({ label: "Fit #" + f.n, id: ids.fit(inv, f) }));
  const v = inv.validation;
  if ((v.state === "passed" || v.state === "failed") ? v.measurement === m.id : v.state === "summary" && v.measurements.includes(m.id))
    usedBy.push({ label: "Validate", id: ids.validate(inv) });
  return { title: "Acquisition", charts: [], blocks: [
    { kind: "facts", rows: [
      { label: "Experiment", value: spec.label + " · " + m.experiment }, ...settings,
      { label: "Source", value: m.source || "not recorded" }, { label: "Uploaded", value: m.uploadedAt || "not recorded", title: m.uploadedAtUtc },
      { label: "Missing samples", value: String(missing), tone: missing ? "warn" : undefined },
      { label: m.sigmaSource === "declared" ? "Noise σ (declared)" : "Noise σ (est.)",
        value: Number.isFinite(m.sigmaEstimate) ? (sig(m.sigmaEstimate, 3) + " " + spec.output.unit).trim() : "not recorded" },
      { label: "Input series", value: m.inputRecorded === false ? "not recorded" : spec.input ? spec.input.name + " · " + spec.input.unit : "none" },
      { label: "Output column", value: spec.output.name + " · " + spec.output.unit },
    ] },
    usedBy.length ? { kind: "links", links: usedBy } : { kind: "text", text: "Not used by a fit or validation yet", tone: "muted" },
  ] };
}

/** The ranking bars, the proposal's own row at its current (possibly edited) fields. */
export function rankingBars(s: State, inv: Investigation, p: Proposal): BarRow[] {
  const own = outlookAt(p, displayedFields(s, inv, p));
  const rows = p.ranking.map((r) => (r.proposal ? { ...r, label: proposalLabel({ ...p, fields: displayedFields(s, inv, p) }), score: own?.score ?? r.score } : r))
    .sort((a, b) => b.score - a.score);
  const top = rows[0]?.score || 1;
  return rows.map((r) => ({ label: r.label, fraction: r.score / top, value: r.score < 1e-3 * top ? "≈ 0" : int(r.score), tone: r.proposal ? "default" : "muted" }));
}

/** A catalog experiment's applied settings at their defaults ("2 N · 440 mHz"); drive settings only when the manifest declared roles. */
function settingsText(c: ProjectConfig, id: string, values?: Record<string, number>): string {
  const spec = c.catalog.find((e) => e.id === id);
  if (!spec) return "";
  const declared = spec.settings.some((s) => s.role), shown = spec.settings.filter((s) => !declared || s.role === "drive");
  return shown.map((s) => engineering(values?.[s.name] ?? s.default, s.unit)).join(" · ");
}

/** Every candidate the agent ranked, the proposal's row at its current (possibly edited) fields and marked. */
export function candidatesSection(s: State, c: ProjectConfig, inv: Investigation, p: Proposal): Section {
  const shown = displayedFields(s, inv, p), own = outlookAt(p, shown), label = proposalLabel({ ...p, fields: shown });
  const rows = p.ranking.map((r) => (r.proposal ? { ...r, score: own?.score ?? r.score, after: own?.after ?? r.after } : r)).sort((a, b) => b.score - a.score);
  if (!rows.length) return { heading: "Candidates", caption: `Ranked at Fit #${p.atFit}`, blocks: [{ kind: "missing", title: "Not recorded yet", description: "No experiment ranking has been recorded by the SDK." }] };
  const top = rows[0].score || 1, values = Object.fromEntries(shown.map((f) => [f.name, f.value]));
  const name = (r: typeof rows[number]) => r.proposal ? label : c.catalog.find((e) => e.id === r.label)?.label ?? r.label;
  const settings = rows.map((r) => settingsText(c, r.proposal ? p.experiment : r.label, r.proposal ? { ...p.fixedSettings, ...values } : undefined));
  const withSettings = settings.some(Boolean);
  const params = p.expected.map((e) => e.param), columns = params.length > 3 ? ["Weakest after"] : params.map((n) => `${n} after`);
  const uncertainty = (r: typeof rows[number]): { text: string; end: boolean }[] => {
    const values = params.map((n) => !r.after || !(n in r.after) ? undefined : r.after[n]);
    const format = (v: number | null | undefined) => v === undefined ? "–" : v == null || !Number.isFinite(v) ? "unbounded" : pct(v);
    return (params.length > 3 ? [values.some((v) => v === undefined) ? undefined : values.some((v) => v == null) ? null : Math.max(...values as number[])] : values).map((v) => ({ text: format(v), end: true }));
  };
  const table: TableRow[] = [
    { dim: true, cells: [{ text: "Experiment" }, ...(withSettings ? [{ text: "Settings" }] : []), { text: "Score", end: true }, ...columns.map((text) => ({ text, end: true }))] },
    ...rows.map((r, i) => ({ strong: r.proposal, cells: [{ text: name(r) }, ...(withSettings ? [{ text: settings[i] }] : []), { text: r.score < 1e-3 * top ? "≈ 0" : int(r.score), end: true }, ...uncertainty(r)] })),
  ];
  const lead = rows[0].proposal ? "the agent proposes the top one" : `the agent proposes ${label}`;
  return { heading: "Candidates", caption: `${rows.length} ranked at Fit #${p.atFit} by the weakest-direction score · ${lead}`, blocks: [{ kind: "table", rows: table }] };
}

const actionTitle = (action: string) => (action.charAt(0).toUpperCase() + action.slice(1)).replace(/_/g, " ");
const listed = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * The experiment in one paragraph: what it applies (drive settings), what it records and for how long
 * (sampling settings), the agent's reason, and what it expects. Built from the manifest's roles and the
 * recorded hypothesis and expectation; nothing product-specific.
 */
export function experimentSummary(s: State, c: ProjectConfig, inv: Investigation, p: Proposal): string {
  const spec = specOf(c, p.experiment), shown = displayedFields(s, inv, p);
  const values: Record<string, number> = { ...p.fixedSettings, ...Object.fromEntries(shown.map((f) => [f.name, f.value])) };
  const ch = (x: { label: string; unit: string }) => `${x.label}${x.unit ? ` (${x.unit})` : ""}`;
  const declared = spec.settings.some((x) => x.role);
  const drive = spec.settings.filter((x) => (declared ? x.role === "drive" : true) && Number.isFinite(values[x.name] ?? x.default))
    .map((x) => `${x.label.toLowerCase()} ${engineering(values[x.name] ?? x.default, x.unit)}`);
  const sampling = spec.settings.filter((x) => x.role === "sampling");
  const duration = sampling.find((x) => x.unit === "s"), rate = sampling.find((x) => x.unit === "Hz");
  const span = `${duration ? ` for ${engineering(values[duration.name] ?? duration.default, "s")}` : ""}${rate ? ` at ${engineering(values[rate.name] ?? rate.default, "Hz")}` : ""}`;
  const name = proposalLabel({ ...p, fields: shown });
  const what = spec.input
    ? `${name} applies ${ch(spec.input)}${drive.length ? ` (${listed(drive)})` : ""} and records ${ch(spec.output)}${span}.`
    : `${name} records ${ch(spec.output)}${drive.length ? ` (${listed(drive)})` : ""}${span}.`;
  const expected = p.trace?.at(-1)?.expected;
  return [what, p.hypothesis, expected ? `Expected: ${expected}.` : ""].filter(Boolean).join(" ");
}

/** The experiment in prose, first on the page: what it does, why, and what it should settle. */
export function summarySection(s: State, c: ProjectConfig, inv: Investigation, p: Proposal): Section {
  const status = p.status === "proposed" ? "awaiting approval" : p.status;
  return { heading: "Summary", caption: `Proposed at Fit #${p.atFit} · ${status}`, blocks: [{ kind: "text", text: experimentSummary(s, c, inv, p), lead: true }] };
}

/** The agent's steps that led to the proposal on a stepper: one line each, the proposing step with its evidence and expectation. */
export function reasoningSection(c: ProjectConfig, p: Proposal): Section {
  const trace = p.trace ?? [];
  if (!trace.length) {
    return { heading: "Reasoning", caption: "The agent's steps that led here", blocks: [{ kind: "missing", title: "Not recorded yet", description: "The SDK recorded no agent steps for this proposal." }] };
  }
  const steps: TraceRow[] = trace.map((t, i) => {
    const current = i === trace.length - 1;
    return { title: actionTitle(t.action), marker: String(t.n), ...(current ? { meta: "this proposal" } : {}),
      text: t.error || (current ? undefined : t.hypothesis || undefined),
      ...(t.error ? { tone: "danger" as const } : {}), ...(current ? { current, evidence: t.evidence, expected: t.expected || undefined } : {}) };
  });
  return { heading: "Reasoning", caption: `${trace.length} agent step${trace.length === 1 ? "" : "s"} since the last proposal · ${c.policy.label}`, blocks: [{ kind: "trace", steps }] };
}

export function mainModel(s: State): MainModel {
  const model = selectedMain(s);
  if (model.body.kind !== "panels") return model;
  const gap = (description: string) => ({ kind: "missing" as const, title: "Not recorded yet", description });
  if (!model.body.panels.length) return { ...model, body: gap("No chart data has been recorded for this view. Upload the corresponding series from the SDK; new records appear live.") };
  return { ...model, body: { ...model.body, panels: model.body.panels.map((p) => ({ ...p,
    charts: p.charts.length ? p.charts.map((c) => (c.kind === "bars" || c.kind === "ranges") && !c.rows.length
      ? gap("No values have been recorded for this panel. Record them through the SDK to populate this view.") : c)
      : [gap("No data has been recorded for this panel. Upload it through the SDK to populate this view.")],
  })) } };
}

function selectedMain(s: State): MainModel {
  const project = projectOf(s);
  const sel = parseSel(project, s.selected[project.id] ?? "") ?? parseSel(project, defaultSelection(project))!;
  switch (sel.kind) {
    case "document": return { crumb: [{ label: project.name }, { label: "Overview" }], meta: "", actions: [],
      body: { kind: "document", id: ids.overview(project), markdown: project.overview! }, credit: "" };
    case "config": {
      const c = latestConfig(project);
      return { crumb: [{ label: project.name }, { label: "Configuration" }], meta: `v${c.version} · ${shortHash(c.hash)}`, actions: [],
        body: { kind: "configuration", parameters: configPanels(c)[0].charts[0] as RangesChart, experiments: experimentSections(c), sections: [knownSection(c), ...configurationSections(c).filter((section) => ["Noise", "Run limits"].includes(section.heading))].filter((s) => s !== null) }, creditLabel: `${simulatorLabel(c)} · source ${shortHash(c.simulator.sourceHash) || "unrecorded"} · config ${shortHash(c.hash)}`, credit: `${simulatorLabel(c)} · source ${c.simulator.sourceHash || "–"} · config ${c.hash}` };
    }
    default: return investigationPage(s, project, sel);
  }
}

const gap = (description: string): Section["blocks"][number] => ({ kind: "missing", title: "Not recorded yet", description });
const recordedPanels = (panels: ChartPanel[], description: string): ChartPanel[] =>
  panels.length ? panels : [{ charts: [{ kind: "missing", title: "Not recorded yet", description }] }];

function validationCard(c: ProjectConfig, inv: Investigation): InvestigationCard {
  const v = inv.validation, id = anchor(inv, "validate"), ctx = { config: c, inv };
  if (v.state === "needs-data") return { id, heading: "Validate", caption: "Held-out check",
    blocks: [gap(inv.measurements.some(m => m.split === "test") ? "Held-out measurements are present; no validation check recorded yet" : "Needs a held-out measurement")] };
  const caption = `χ²/N ${sig(v.chi2N, 3)} (≤ ${sig(v.threshold, 3)}) · ${(v.state === "summary" ? v.passed : v.state === "passed") ? "passed" : "failed"}`;
  if (v.state === "summary") {
    const fit = latestFit(inv);
    const panels = fit ? v.measurements.filter(id => fit.curves[id] && inv.measurements.some(m => m.id === id))
      .flatMap(id => validationPanels(ctx, fit, id, fit.curves[id].fit, fit.curves[id].t)) : [];
    return { id, heading: "Validate", caption, blocks: [{ kind: "facts", rows: [
      { label: "Measurement", value: v.measurements.join(", ") || "not recorded" },
      { label: "Worst parameter", value: "not recorded" },
    ] }, ...(panels.length ? [] : [gap("The held-out predicted series is not recorded.")])], panels };
  }
  const fit = inv.fits.find(f => f.n === v.fit);
  return { id, heading: "Validate", caption, blocks: [{ kind: "facts", rows: [
    { label: "Measurement", value: v.measurement }, { label: "Fit", value: "Fit #" + v.fit },
    { label: "Worst parameter", value: v.worst.param + " " + pct(v.worst.relative) + " (2σ relative)" },
  ] }],
    panels: recordedPanels(fit && inv.measurements.some(m => m.id === v.measurement)
      ? validationPanels(ctx, fit, v.measurement, v.predicted) : [], "The validation fit or measurement is not recorded.") };
}

/** One investigation page. Old leaf selections change the target, never the page. */
export function investigationPage(s: State, project: Project, sel: Exclude<Sel, {kind:"config" | "document"}>): MainModel {
  const inv = sel.inv, c = configFor(project, inv), rounds = investigationRounds(inv);
  const target = investigationTarget(inv, sel, rounds), fit = latestFit(inv), latest = rounds.at(-1)!;
  const finished = ["validated", "inconclusive"].includes(stateOf(inv));
  const proposal = [...inv.proposals].reverse().find(p => p.status === "proposed") ?? inv.proposals.at(-1);
  const number = (v: number) => Number.isFinite(v) ? sig(v, 3) : "not recorded";
  const diagnosis = fit ? [
    `Fit #${fit.n} has χ²/N ${number(fit.chi2N)}.`,
    fit.sensitivity?.combos.length ? `The data pins ${fit.sensitivity.combos.map(x => `${x.name} (${pct(x.logStd)})`).join(" and ")}.` : "",
    fit.sensitivity?.nonIdentified.length ? `${fit.sensitivity.nonIdentified.join(", ")} remain on a ridge.` : "",
    fit.identification ? `Identified: ${fit.identification.identified.join(", ") || "none"}; not identified: ${fit.identification.nonIdentified.join(", ") || "none"}.` : "",
  ].filter(Boolean).join(" ") : "No converged fit recorded yet.";
  let summary: InvestigationCard = proposal && !finished
    ? { ...summarySection(s, c, inv, proposal), id: anchor(inv, "summary") }
    : { id: anchor(inv, "summary"), heading: "Summary", caption: statusText(inv).text, captionTitle: statusText(inv).title, blocks: [] };
  if (!finished) {
    if (summary.blocks[0]?.kind === "text") summary.blocks[0].text = diagnosis + " " + summary.blocks[0].text;
    else summary.blocks.push({ kind: "text", lead: true, text: diagnosis + " " + statusText(inv).text });
  } else {
    const v = inv.validation, verdict = inv.state === "validated" ? "Validated" : "Inconclusive";
    const check = v.state === "needs-data" ? "No held-out check recorded."
      : `Held-out χ²/N ${number(v.chi2N)} (≤ ${number(v.threshold)}) on ${v.state === "summary" ? v.measurements.join(", ") || "unrecorded data" : v.measurement}.`;
    const params = fit ? c.params.map(p => {
      const k = certaintyOf(fit, p.name);
      const note = k.kind === "fixed" ? " (fixed)"
        : k.kind === "ridge" ? " (not identified)"
        : k.kind === "unchecked" ? " (not checked)"
        : k.kind === "unknown" ? " (uncertainty not recorded)"
        : k.std != null ? " " + plusMinus(c, p.name, k.std) : " (identified; uncertainty not recorded)";
      return `${p.name} ${number(fit.params[p.name])} ${p.unit}${note}`.trim();
    }).join("; ") : "No converged fit recorded.";
    summary = { ...summary, caption: `${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${experimentsUsed(inv)} / ${c.budgets.maxExperiments} experiments`,
      blocks: [{ kind: "text", text: verdict, lead: true, tone: inv.state === "validated" ? "ok" : "warn" },
        { kind: "text", text: check + " " + params + (fit?.identificationSkipped && !fit.identification && !fit.sensitivity
          ? `. Identifiability was not checked at Fit #${fit.n}: ${fit.identificationSkipped}.` : ""), lead: true }] };
  }
  const outcome: InvestigationCard[] = finished || inv.validation.state !== "needs-data" || inv.reveal || sel.kind === "validate" || sel.kind === "truth"
    ? [validationCard(c, inv), ...(inv.reveal ? [{ id: anchor(inv, "truth"), heading: "Ground truth", caption: "Revealed after the outcome",
      blocks: [{ kind: "text" as const, text: "Synthetic: truth was hidden from the agent until the outcome." }], panels: truthPanels(inv.reveal) }] : [])] : [];
  const pageRounds = [...rounds].reverse().map(r => {
    const f = r.fit, id = roundAnchor(inv, r), ctx = { config: c, inv };
    const title = `Round ${r.n}`, proposals = r.proposals.map(p => {
      const candidates = candidatesSection(s, c, inv, p), reasoning = reasoningSection(c, p);
      return { id: roundAnchor(inv, r, `proposal-${encodeURIComponent(p.id)}`), heading: `Proposal · ${proposalLabel(p)}`,
        caption: `${p.status}${p.decidedBy ? " by " + p.decidedBy : ""} · ${candidates.caption}`,
        blocks: [...candidates.blocks, { kind: "text" as const, text: `Reasoning · ${reasoning.caption}` }, ...reasoning.blocks] };
    });
    const data: InvestigationCard = { id: roundAnchor(inv, r, "data"), heading: "Data", caption: "Measurements for this round · expand a row to inspect its samples",
      blocks: r.measurements.length ? [] : [gap("No measurements recorded for this round.")],
      rows: r.measurements.map(m => ({ id: measurementAnchor(inv, r, m.id), label: m.id,
        meta: `${m.split === "train" ? "train" : "held out"} · ${int(m.output.length)} samples · ${number(m.rate)} Hz`,
        open: target === measurementAnchor(inv, r, m.id), panels: [acquisitionPanel(c, inv, m), ...measurementPanels(c, m)] })) };
    const at = f ? `At Fit #${f.n}` : "";
    const parameters: InvestigationCard | null = f ? { id: roundAnchor(inv, r, "parameters"), heading: "Parameters", caption: at,
      blocks: [{ kind: "table", rows: paramsTable(c, f) }] } : null;
    const condition = f?.sensitivity?.condition ?? f?.identification?.condition;
    const identifiability: InvestigationCard | null = f ? { id: roundAnchor(inv, r, "identifiability"), heading: "Identifiability",
      caption: f.sensitivity ? `Rank ${rankOf(f.sensitivity)} of ${f.sensitivity.names.length} · ${at}`
        : f.identification ? `${f.free.filter(n => f.identification!.identified.includes(n)).length} of ${f.free.length} identified · ${at}` : at,
      blocks: f.sensitivity ? [] : f.identification
        ? [{ kind: "table", rows: identificationTable(c, f) }, { kind: "text", tone: "muted", text: "Singular values and directions are not recorded for this fit." }]
        : f.identificationSkipped
          ? [{ kind: "missing", title: "Not checked", description: `Identifiability was not checked for this fit: ${f.identificationSkipped}.` }]
          : [gap("No singular values or directions recorded for this fit.")],
      panels: [
        { charts: [], blocks: [{ kind: "facts", rows: [{ label: "Condition", value:
          condition == null ? "not recorded"
            : condition > 1e6 ? "> 10⁶"
            : sig(condition, 3) }] }] },
        ...(f.sensitivity ? sensitivityPanels(f) : []),
      ] } : null;
    const chart = f && landscapeChart(c, f);
    const landscape: InvestigationCard | null = f ? { id: roundAnchor(inv, r, "landscape"), heading: "Landscape", caption: at,
      blocks: chart ? [] : [gap("No landscape recorded for this fit.")], panels: chart ? [{ charts: [{ ...chart, height: 220 }] }] : [] } : null;
    const extras: InvestigationCard[] = f ? [
      ["envelope", "Envelope", envelopePanels(ctx, f)], ["frequency", "Frequency", frequencyPanels(ctx, f)], ["zoom:edges", "Edges", edgePanels(ctx, f)],
    ].filter(([part, , panels]) => (panels as ChartPanel[]).length || target === roundAnchor(inv, r, part as string)).map(([part, heading, panels]) => ({
      id: roundAnchor(inv, r, part as string), heading: heading as string, caption: at,
      blocks: (panels as ChartPanel[]).length ? [] : [gap("No " + (heading as string).toLowerCase() + " data recorded for this fit.")],
      panels: panels as ChartPanel[],
    })) : [];
    const quality = f ? `Fit #${f.n} · χ²/N ${number(f.chi2N)}` : "Waiting for a fit";
    const decision = r.proposals.map(p => `${proposalLabel(p)} ${p.status}${p.decidedBy ? " by " + p.decidedBy : ""}`).join(" · ");
    return { id, title, caption: [quality, decision || (finished && r === latest ? "outcome recorded" : f?.state)].filter(Boolean).join(" → "),
      open: r === latest || target === id || target.startsWith(id + "-"), data,
      fit: f ? { id: roundAnchor(inv, r, "fit"), heading: `Fit #${f.n}`,
        caption: `${f.state} · χ²/N ${number(f.chi2N)} · ${int(f.evals)} evals · ${f.starts} starts${f.basins == null ? "" : " → " + f.basins + " basins"}`,
        blocks: [{ kind: "facts" as const, rows: [
          ...(f.variant ? [{ label: "Variant", value: f.variant }] : []),
          { label: "Loss", value: f.loss === "linear" ? "least squares" : "soft L1" },
          { label: "Data", value: f.measurements.join(", ") || "not recorded" },
        ] }, ...Object.entries(f.lag1).map(([id, rho]) => ({ kind: "text" as const,
          text: `${id}: ${Math.abs(rho) > .3 ? "structured" : "white"} residuals (ρ₁ ${number(rho)})` }))],
        panels: recordedPanels(fitPanels(ctx, f), "No fitted data recorded.") } : null,
      parameters, identifiability, landscape, proposals, extras };
  });
  const jumps: InvestigationBody["jumps"] = [
    { label: "Summary", target: summary.id },
    ...outcome.map(c => ({ label: c.heading, target: c.id })),
    ...pageRounds.map(r => ({ label: r.title, target: r.id })),
  ];
  return { crumb: [{ label: project.name }, { label: investigationLabel(project, inv) }],
    meta: `${statusText(inv).text} · ${experimentsUsed(inv)} / ${c.budgets.maxExperiments} experiments`, metaTitle: statusText(inv).title, actions: [], credit: "",
    body: { kind: "investigation", pageId: inv.id, selectionId: s.selected[project.id] ?? inv.id, target, jumps, summary, outcome, rounds: pageRounds } };
}
