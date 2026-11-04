import { awaiting, expectedMeasurement } from "../proposal.ts";
/** The main column: crumb, meta, the viewer's panels and one credit line. */
import type { Investigation, Project, ProjectConfig, Proposal } from "../domain.ts";
import { investigationAnchor, investigationRounds, sectionId, finished, pageProposal } from "./rounds.ts";
import { paramsTable, sensitivityDetails, directionText } from "./details.ts";
import type { InvestigationCard, InvestigationBody, ChartPanel, BarRow, MainModel, RangesChart, Section, TableRow, TraceRow } from "../../ui/view-model.ts";
import {
  configPanels, edgePanels, envelopePanels, fitPanels, frequencyPanels, landscapeChart, measurementPanels, residualPanels, sensitivityPanels,
  validationPanels, VIEW_LABEL,
} from "./charts.ts";
import { truthPanels } from "./truth.ts";
import { configurationSections, experimentSections, knownSection } from "./configuration.ts";
import { simulatorLabel, specOf } from "../config.ts";
import { engineering, int, shortHash, sig, pct } from "./fmt.ts";
import { displayedFields, outlookAt } from "./outlook.ts";
import { configFor, investigationLabel, defaultSelection, experimentsUsed, ids, latestConfig, latestFit, parseSel, projectOf, proposalLabel, rankOf, type State, type Sel, statusText } from "./shared.ts";



const credit = (c: ProjectConfig, inv: Investigation, measurements: string[], extra = "") =>
  `${simulatorLabel(c)} · ${measurements.join(" + ") || "no data"} · seed ${Number.isFinite(inv.seed) ? inv.seed : "not recorded"}${extra}`;

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
  const fit = inv.fits.find(f => f.n === p.atFit), sensitivity = fit?.sensitivity;
  const diagnosis = fit ? `Fit #${fit.n} has χ²/N ${sig(fit.chi2N, 3)}. ${sensitivity ? sensitivity.nonIdentified.length ? `The data pins ${sensitivity.combos.map(x => `${x.name} (${pct(x.logStd)})`).join(" and ") || sensitivity.identified.join(", ") || "no individual parameters"}; ${sensitivity.nonIdentified.join(", ")} remain on a ridge. ` : `All ${sensitivity.identified.length} parameters are identified. ` : ""}` : "";
  return { heading: "Summary", caption: `Proposed at Fit #${p.atFit} · ${status}`, blocks: [{ kind: "text", text: diagnosis + experimentSummary(s, c, inv, p), lead: true }] };
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
  const project = projectOf(s), sel = parseSel(project, s.selected[project.id] ?? "") ?? parseSel(project, defaultSelection(project))!;
  const model = sel.kind === "config" ? selectedMain(s) : investigationMain(s, project, sel);
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
  const invCrumb = (inv: Investigation) => ({ label: investigationLabel(project, inv), id: ids.inv(inv) });
  switch (sel.kind) {
    case "config": {
      const c = latestConfig(project);
      return { crumb: [{ label: project.name }, { label: "Configuration" }], meta: `v${c.version} · ${shortHash(c.hash)}`, actions: [],
        body: { kind: "configuration", parameters: configPanels(c)[0].charts[0] as RangesChart, experiments: experimentSections(c), sections: [knownSection(c), ...configurationSections(c).filter((section) => ["Noise", "Run limits"].includes(section.heading))].filter((s) => s !== null) }, creditLabel: `${simulatorLabel(c)} · source ${shortHash(c.simulator.sourceHash) || "unrecorded"} · config ${shortHash(c.hash)}`, credit: `${simulatorLabel(c)} · source ${c.simulator.sourceHash || "–"} · config ${c.hash}` };
    }
    case "investigation": {
      const c = configFor(project, sel.inv), fit = latestFit(sel.inv);
      const panels = fit ? fitPanels({ config: c, inv: sel.inv }, fit) : sel.inv.measurements.flatMap((m) => measurementPanels(c, m));
      return { crumb: [{ label: investigationLabel(project, sel.inv) }], meta: fit ? `Fit #${fit.n} · χ²/N ${fit.chi2N.toFixed(2)}` : statusText(sel.inv).text, actions: [],
        body: panels.length ? { kind: "panels", panels } : { kind: "missing", title: "Not recorded yet", description: "No measurements or fits have arrived. Run the investigation from the SDK; records appear live here." }, credit: credit(c, sel.inv, fit?.measurements ?? sel.inv.measurements.map((m) => m.id), fit ? ` · fit #${fit.n}` : "") };
    }
    case "data": return { crumb: [], meta: "", actions: [], body: { kind: "panels", panels: sel.inv.measurements.flatMap(m => measurementPanels(configFor(project, sel.inv), m)) }, credit: "" };
    case "measurement": {
      const c = configFor(project, sel.inv), m = sel.m;
      return { crumb: [invCrumb(sel.inv), { label: "Measurements" }, { label: m.id }], meta: `${int(m.output.length)} samples · ${sig(m.rate, 3)} Hz`, actions: [],
        body: { kind: "panels", panels: measurementPanels(c, m) }, credit: credit(c, sel.inv, [m.id]) };
    }
    case "awaiting": {
      const c = configFor(project, sel.inv);
      return { crumb: [invCrumb(sel.inv), { label: "Measurements" }, { label: sel.id }], meta: "awaiting data", actions: [],
        body: { kind: "missing", title: "Not recorded yet", description: `Waiting for ${sel.id} from ${sel.proposal.dataFrom}. Attach the requested measurement through the SDK to continue.` }, credit: credit(c, sel.inv, []) };
    }
    case "fit": {
      const c = configFor(project, sel.inv), ctx = { config: c, inv: sel.inv }, fit = sel.fit, view = sel.view ?? "fit";
      const crumb = sel.view ? [invCrumb(sel.inv), { label: `Fit #${fit.n}`, id: ids.fit(sel.inv, fit) }, { label: VIEW_LABEL[view] }] : [invCrumb(sel.inv), { label: `Fit #${fit.n}` }];
      const meta = fit.state === "running" ? `running · ${fit.evals} evals` : view === "landscape" && fit.landscape
        ? `${fit.landscape.xs.length - 1} × ${fit.landscape.ys.length - 1} · ${fit.landscape.held} held` : `${fit.evals} evals · χ²/N ${fit.chi2N.toFixed(2)}`;
      let body: MainModel["body"];
      if (view === "landscape") { const chart = landscapeChart(c, fit); body = chart ? { kind: "panels", panels: [{ charts: [chart] }] } : { kind: "missing", title: "Not recorded yet", description: "No landscape recorded for this fit" }; }
      else if (view === "residuals") {
        const panels = residualPanels(ctx, fit);
        body = panels.length ? { kind: "panels", panels } : { kind: "missing", title: "Not recorded yet", description: "Residuals need the fit's curve, which is not recorded for this fit" };
      }
      else if (view === "envelope") body = { kind: "panels", panels: envelopePanels(ctx, fit) };
      else if (view === "frequency") body = { kind: "panels", panels: frequencyPanels(ctx, fit) };
      else if (view === "zoom:edges") body = { kind: "panels", panels: edgePanels(ctx, fit), columns: 2 };
      else body = { kind: "panels", panels: fitPanels(ctx, fit) };
      return { crumb, meta, actions: [], body, credit: credit(c, sel.inv, fit.measurements, ` · fit #${fit.n}`) };
    }
    case "sensitivity": {
      const c = configFor(project, sel.inv), id = sel.fit.identification;
      if (!sel.fit.sensitivity && id) {
        return { crumb: [invCrumb(sel.inv), { label: "Sensitivity" }], meta: `${id.identified.length} of ${id.identified.length + id.nonIdentified.length} identified · at Fit #${sel.fit.n}`, actions: [],
          body: { kind: "missing", title: "Not recorded yet", description: `Identified: ${id.identified.join(", ") || "none"}. Not identified: ${id.nonIdentified.join(", ") || "none"}. Singular values and directions are not recorded.` },
          credit: credit(c, sel.inv, sel.fit.measurements, ` · fit #${sel.fit.n}`) };
      }
      return { crumb: [invCrumb(sel.inv), { label: "Sensitivity" }], meta: `rank ${rankOf(sel.fit.sensitivity!)} of ${sel.fit.sensitivity!.names.length} · at Fit #${sel.fit.n}`, actions: [],
        body: { kind: "panels", panels: sensitivityPanels(sel.fit) }, credit: credit(c, sel.inv, sel.fit.measurements, ` · fit #${sel.fit.n}`) };
    }
    case "proposal": {
      const c = configFor(project, sel.inv), p = sel.proposal;
      return { crumb: [invCrumb(sel.inv), { label: proposalLabel({ ...p, fields: displayedFields(s, sel.inv, p) }) }], meta: `${p.status} · ${experimentsUsed(sel.inv) + (p.status === "proposed" ? 1 : 0)} / ${c.budgets.maxExperiments} experiments`, actions: [],
        body: { kind: "decision", cards: [summarySection(s, c, sel.inv, p), candidatesSection(s, c, sel.inv, p), reasoningSection(c, p)] }, credit: "" };
    }
    case "truth": return { crumb: [invCrumb(sel.inv), { label: "Ground truth" }], meta: "Revealed after outcome", actions: [],
      body: { kind: "panels", panels: truthPanels(sel.inv.reveal!) }, credit: "Synthetic: truth was hidden from the agent until the outcome." };
    case "validate": {
      const c = configFor(project, sel.inv), v = sel.inv.validation;
      if (v.state === "needs-data") return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: "needs data", actions: [], body: { kind: "missing", title: "Not recorded yet", description: sel.inv.measurements.some((m) => m.split === "test") ? "Held-out measurements are present; no validation check recorded yet" : "Needs a held-out measurement" }, credit: credit(c, sel.inv, []) };
      if (v.state === "summary") {
        const fit = latestFit(sel.inv);
        const predicted = fit && v.measurements.filter((id) => fit.curves[id]);
        if (fit && predicted?.length) return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} · ${v.passed ? "passed" : "failed"}`, actions: [],
          body: { kind: "panels", panels: predicted.flatMap((id) => validationPanels({ config: c, inv: sel.inv }, fit, id, fit.curves[id].fit, fit.curves[id].t)) }, credit: credit(c, sel.inv, predicted, ` · fit #${fit.n}`) };
        return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} · ${v.passed ? "passed" : "failed"}`, actions: [],
          body: { kind: "missing", title: "Not recorded yet", description: `Held-out check ${v.passed ? "passed" : "failed"}: χ²/N ${v.chi2N.toFixed(2)} (≤ ${sig(v.threshold, 3)})${v.measurements.length ? ` on ${v.measurements.join(", ")}` : ""}. The predicted series is not recorded.` },
          credit: credit(c, sel.inv, v.measurements) };
      }
      const fit = sel.inv.fits.find((f) => f.n === v.fit)!;
      return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} on ${v.measurement}`, actions: [],
        body: { kind: "panels", panels: validationPanels({ config: c, inv: sel.inv }, fit, v.measurement, v.predicted) }, credit: credit(c, sel.inv, [v.measurement], ` · fit #${fit.n}`) };
    }
  }
}

/** Compose the established section/panel builders; no fitting or simulator work happens here. */
function investigationMain(s: State, project: Project, sel: Exclude<Sel, { kind: "config" }>): MainModel {
  const inv = sel.inv, c = configFor(project, inv), fit = latestFit(inv), done = finished(inv);
  const rounds = investigationRounds(inv), id = (name: string) => sectionId(inv, name);
  const gap = (description: string) => ({ kind: "missing" as const, title: "Not recorded yet", description });
  const card = (name: string, heading: string, panels: ChartPanel[] = [], blocks: Section["blocks"] = [], caption = ""): InvestigationCard =>
    ({ id: id(name), heading, caption, panels, blocks: panels.length || blocks.length ? blocks : [gap(`No ${heading.toLowerCase()} data has been recorded.`)] });
  const pending = pageProposal(inv), v = inv.validation;
  let summary: InvestigationCard;
  if (!done && pending) summary = { ...summarySection(s, c, inv, pending), id: id("summary") };
  else {
    const check = v.state === "needs-data" ? "No held-out check recorded." : `Held-out check ${v.state === "passed" || v.state === "summary" && v.passed ? "passed" : "failed"}: χ²/N ${sig(v.chi2N, 3)} (≤ ${sig(v.threshold, 3)}).`;
    summary = card("summary", "Summary", [], [
      { kind: "text", lead: true, text: done ? (inv.state === "validated" ? "Validated" : "Inconclusive") : "Investigation in progress", tone: done ? statusText(inv).tone : undefined },
      { kind: "text", text: check },
      ...(fit ? [{ kind: "table" as const, rows: paramsTable(c, fit) }] : []),
    ], `${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${experimentsUsed(inv)} / ${c.budgets.maxExperiments} experiments`);
  }
  const validation = selectedMain({ ...s, selected: { ...s.selected, [project.id]: ids.validate(inv) } }).body;
  const outcome = [card("validate", "Validate", validation.kind === "panels" ? validation.panels : [],
    validation.kind === "missing" ? [validation] : [], v.state === "needs-data" ? "Awaiting held-out check" : `χ²/N ${sig(v.chi2N, 3)} · threshold ${sig(v.threshold, 3)}`),
    ...(inv.reveal ? [card("truth", "Ground truth", truthPanels(inv.reveal), [], "Revealed after outcome · estimate ÷ truth ±1σ")] : [])];
  const anchor = investigationAnchor(sel);
  const viewRounds: InvestigationBody["rounds"] = [...rounds].reverse().map((r, index) => {
    const rows: InvestigationCard[][] = [];
    const data = inv.measurements.filter(m => r.fits.some(f => f.measurements.includes(m.id)) || index === 0 && !inv.fits.some(f => f.measurements.includes(m.id)));
    rows.push([card(`data-round-${r.n}`, "Data", [], data.length ? data.map(m => ({ kind: "text" as const, text: `${m.id} · ${m.split === "test" ? "held out" : "train"} · ${int(m.output.length)} samples`, link: { label: "View measurement", id: ids.measurement(inv, m.id) } })) : [{ kind: "text", text: "No measurements recorded for this round.", tone: "muted" }])]);
    // A measurement has one canonical card (the newest round that uses it), so old addresses are unambiguous.
    for (const m of data.filter(m => !rounds.slice(r.n).some(next => next.fits.some(f => f.measurements.includes(m.id))))) rows.push([{ ...card(`data-${m.id}`, m.id, measurementPanels(c, m), [], m.split === "test" ? "Held out" : "Training measurement"), collapsed: true }]);
    for (const f of r.fits) {
      const ctx = { config: c, inv }, sens = f.sensitivity, residuals = residualPanels(ctx, f);
      const fitCard = card(`fit-${f.n}`, `Fit #${f.n}`, fitPanels(ctx, f), [], `${f.state} · χ²/N ${sig(f.chi2N, 3)} · ${int(f.evals)} evals`);
      // Fit panels already include the normalized residual strip. Retain the old residual address as an alias.
      fitCard.aliases = [id(`fit-${f.n}-residuals`)];
      const quality = Object.entries(f.lag1).map(([measurement, lag]) => `${measurement}: ${Math.abs(lag) > .3 ? "structured" : "white"} residuals (ρ₁ ${sig(lag, 2)})`).join(" · ");
      if (quality) fitCard.blocks.push({ kind: "text", text: quality });
      if (!residuals.length) fitCard.blocks.push(gap("Residuals need the fit curve, which is not recorded for this fit."));
      rows.push([fitCard, card(`parameters-${f.n}`, "Parameters", [], [{ kind: "table", rows: paramsTable(c, f) }], `At Fit #${f.n}`)]);
      const identification = sens ? sensitivityPanels(f) : [];
      const evidence = sens?.vectors.length ? [{ kind: "text" as const, text: `Weakest direction: ${directionText(sens, sens.vectors.length - 1)}` }] : f.identification ? sensitivityDetails(project, inv, f).sections.flatMap(section => section.blocks) : [gap("Singular values and directions are not recorded.")];
      const landscape = landscapeChart(c, f);
      rows.push([card(`identifiability-${f.n}`, "Identifiability", identification, evidence, sens ? `Rank ${rankOf(sens)} of ${sens.names.length} · at Fit #${f.n}` : `At Fit #${f.n}`), card(`fit-${f.n}-landscape`, "Landscape", landscape ? [{ charts: [landscape] }] : [], [], landscape?.label ?? `At Fit #${f.n}`)]);
      // Retain experiment-specific views on this same page and their existing addresses.
      for (const [view, label, panels] of [["envelope", "Envelope", envelopePanels(ctx, f)], ["frequency", "Frequency", frequencyPanels(ctx, f)], ["zoom:edges", "Edges", edgePanels(ctx, f)]] as const) if (panels.length) rows.push([card(`fit-${f.n}-${view}`, label, panels)]);
    }
    for (const p of r.proposals) {
      const candidates = candidatesSection(s, c, inv, p), reasoning = reasoningSection(c, p);
      rows.push([card(`proposal-${p.id}`, `Proposal · ${proposalLabel(p)}`, [], [
        ...candidates.blocks, { kind: "text", text: `${reasoning.heading} · ${reasoning.caption}` }, ...reasoning.blocks,
      ], `${p.status}${p.decidedBy ? ` by ${p.decidedBy}` : ""} · ${candidates.caption}`)]);

    }
    if (index === 0) for (const p of awaiting(inv)) {
      const mid = expectedMeasurement(inv, p);
      rows.push([card(`data-${mid}`, "Awaiting data", [], [{ kind: "text", text: `Waiting for ${mid} from ${p.dataFrom}. Attach the measurement through the SDK to continue.` }])]);
    }
    const last = r.fits.at(-1), proposal = r.proposals.at(-1);
    return { id: id(`round-${r.n}`), heading: `Round ${r.n}`, caption: [last && `Fit #${last.n} · χ²/N ${sig(last.chi2N, 3)}`, proposal && `${proposalLabel(proposal)} ${proposal.status}`].filter(Boolean).join(" → "), open: index === 0, rows };
  });
  const jumps = [{ label: "Summary", anchor: id("summary") }, ...(done ? [{ label: "Outcome", anchor: id("outcome") }] : []),
    ...viewRounds.flatMap(r => [{ label: r.heading, anchor: r.id }, ...(!done ? r.rows.flat().filter(c => /^Fit #|^Identifiability$|^Proposal/.test(c.heading)).map(c => ({ label: c.heading.startsWith("Proposal") ? "Proposal" : c.heading, anchor: c.id })) : [])])];
  return { crumb: [{ label: project.name }, { label: investigationLabel(project, inv) }], meta: statusText(inv).text, actions: [],
    body: { kind: "investigation", pageId: inv.id, selectionId: s.selected[project.id] ?? inv.id, anchor, jumps, summary, outcome: done ? outcome : outcome.filter(c => c.id === anchor), rounds: viewRounds },
    credit: credit(c, inv, inv.measurements.map(m => m.id)), creditLabel: `${simulatorLabel(c)} · config v${c.version} · ${shortHash(c.hash)}` };
}
