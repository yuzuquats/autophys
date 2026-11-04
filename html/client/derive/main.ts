/** The main column: crumb, meta, the viewer's panels and one credit line. */
import type { Investigation, Project, ProjectConfig, Proposal } from "../domain.ts";
import type { Action, BarRow, MainModel, RangesChart, Section, TableRow, TraceRow } from "../../ui/view-model.ts";
import {
  configPanels, edgePanels, envelopePanels, fitPanels, frequencyPanels, landscapeChart, measurementPanels, residualPanels, sensitivityPanels,
  validationPanels, VIEW_LABEL,
} from "./charts.ts";
import { truthPanels } from "./truth.ts";
import { configurationSections, experimentSections, knownSection } from "./configuration.ts";
import { simulatorLabel } from "../config.ts";
import { engineering, int, shortHash, sig } from "./fmt.ts";
import { displayedFields, outlookAt } from "./outlook.ts";
import { configFor, investigationLabel, defaultSelection, experimentsUsed, ids, latestConfig, latestFit, parseSel, projectOf, proposalLabel, rankOf, type State, statusText } from "./shared.ts";


const EXPORT: Action = { name: "export", label: "Export", variant: "ghost" };

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
function candidatesSection(s: State, c: ProjectConfig, inv: Investigation, p: Proposal): Section {
  const shown = displayedFields(s, inv, p), own = outlookAt(p, shown), label = proposalLabel({ ...p, fields: shown });
  const rows = p.ranking.map((r) => (r.proposal ? { ...r, score: own?.score ?? r.score } : r)).sort((a, b) => b.score - a.score);
  if (!rows.length) return { heading: "Candidates", caption: `Ranked at Fit #${p.atFit}`, blocks: [{ kind: "missing", title: "Not recorded yet", description: "No experiment ranking has been recorded by the SDK." }] };
  const top = rows[0].score || 1, values = Object.fromEntries(shown.map((f) => [f.name, f.value]));
  const name = (r: typeof rows[number]) => r.proposal ? label : c.catalog.find((e) => e.id === r.label)?.label ?? r.label;
  const settings = rows.map((r) => settingsText(c, r.proposal ? p.experiment : r.label, r.proposal ? { ...p.fixedSettings, ...values } : undefined));
  const withSettings = settings.some(Boolean);
  const table: TableRow[] = [
    { dim: true, cells: [{ text: "Experiment" }, ...(withSettings ? [{ text: "Settings" }] : []), { text: "Score", end: true }] },
    ...rows.map((r, i) => ({ strong: r.proposal, cells: [{ text: name(r) }, ...(withSettings ? [{ text: settings[i] }] : []), { text: r.score < 1e-3 * top ? "≈ 0" : int(r.score), end: true }] })),
  ];
  const lead = rows[0].proposal ? "the agent proposes the top one" : `the agent proposes ${label}`;
  return { heading: "Candidates", caption: `${rows.length} ranked at Fit #${p.atFit} by the weakest-direction score · ${lead}`, blocks: [{ kind: "table", rows: table }] };
}

const actionTitle = (action: string) => (action.charAt(0).toUpperCase() + action.slice(1)).replace(/_/g, " ");

/** The agent's steps that led to the proposal: one line each, the proposing step with its evidence and expectation. */
function reasoningSection(c: ProjectConfig, p: Proposal): Section {
  const trace = p.trace ?? [];
  if (!trace.length) {
    return { heading: "Reasoning", caption: "The agent's steps were not recorded for this proposal", blocks: p.hypothesis
      ? [{ kind: "text", text: p.hypothesis }]
      : [{ kind: "missing", title: "Not recorded yet", description: "Neither a hypothesis nor the agent's steps were recorded for this proposal." }] };
  }
  const steps: TraceRow[] = trace.map((t, i) => {
    const current = i === trace.length - 1;
    return { title: actionTitle(t.action), meta: `step ${t.n}${current ? " · this proposal" : ""}`, text: t.error || t.hypothesis || undefined,
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
  const invCrumb = (inv: Investigation) => ({ label: investigationLabel(project, inv), id: ids.inv(inv) });
  switch (sel.kind) {
    case "config": {
      const c = latestConfig(project);
      return { crumb: [{ label: project.name }, { label: "Configuration" }], meta: `v${c.version} · ${shortHash(c.hash)}`, actions: [EXPORT],
        body: { kind: "configuration", parameters: configPanels(c)[0].charts[0] as RangesChart, experiments: experimentSections(c), sections: [knownSection(c), ...configurationSections(c).filter((section) => ["Noise", "Run limits"].includes(section.heading))].filter((s) => s !== null) }, creditLabel: `${simulatorLabel(c)} · source ${shortHash(c.simulator.sourceHash) || "unrecorded"} · config ${shortHash(c.hash)}`, credit: `${simulatorLabel(c)} · source ${c.simulator.sourceHash || "–"} · config ${c.hash}` };
    }
    case "investigation": {
      const c = configFor(project, sel.inv), fit = latestFit(sel.inv);
      const panels = fit ? fitPanels({ config: c, inv: sel.inv }, fit) : sel.inv.measurements.flatMap((m) => measurementPanels(c, m));
      return { crumb: [{ label: investigationLabel(project, sel.inv) }], meta: fit ? `Fit #${fit.n} · χ²/N ${fit.chi2N.toFixed(2)}` : statusText(sel.inv).text, actions: [EXPORT],
        body: panels.length ? { kind: "panels", panels } : { kind: "missing", title: "Not recorded yet", description: "No measurements or fits have arrived. Run the investigation from the SDK; records appear live here." }, credit: credit(c, sel.inv, fit?.measurements ?? sel.inv.measurements.map((m) => m.id), fit ? ` · fit #${fit.n}` : "") };
    }
    case "measurement": {
      const c = configFor(project, sel.inv), m = sel.m;
      return { crumb: [invCrumb(sel.inv), { label: "Measurements" }, { label: m.id }], meta: `${int(m.output.length)} samples · ${sig(m.rate, 3)} Hz`, actions: [EXPORT],
        body: { kind: "panels", panels: measurementPanels(c, m) }, credit: credit(c, sel.inv, [m.id]) };
    }
    case "awaiting": {
      const c = configFor(project, sel.inv);
      return { crumb: [invCrumb(sel.inv), { label: "Measurements" }, { label: sel.id }], meta: "awaiting data", actions: [EXPORT],
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
      return { crumb, meta, actions: [EXPORT], body, credit: credit(c, sel.inv, fit.measurements, ` · fit #${fit.n}`) };
    }
    case "sensitivity": {
      const c = configFor(project, sel.inv), id = sel.fit.identification;
      if (!sel.fit.sensitivity && id) {
        return { crumb: [invCrumb(sel.inv), { label: "Sensitivity" }], meta: `${id.identified.length} of ${id.identified.length + id.nonIdentified.length} identified · at Fit #${sel.fit.n}`, actions: [EXPORT],
          body: { kind: "missing", title: "Not recorded yet", description: `Identified: ${id.identified.join(", ") || "none"}. Not identified: ${id.nonIdentified.join(", ") || "none"}. Singular values and directions are not recorded.` },
          credit: credit(c, sel.inv, sel.fit.measurements, ` · fit #${sel.fit.n}`) };
      }
      return { crumb: [invCrumb(sel.inv), { label: "Sensitivity" }], meta: `rank ${rankOf(sel.fit.sensitivity!)} of ${sel.fit.sensitivity!.names.length} · at Fit #${sel.fit.n}`, actions: [EXPORT],
        body: { kind: "panels", panels: sensitivityPanels(sel.fit) }, credit: credit(c, sel.inv, sel.fit.measurements, ` · fit #${sel.fit.n}`) };
    }
    case "proposal": {
      const c = configFor(project, sel.inv), p = sel.proposal;
      return { crumb: [invCrumb(sel.inv), { label: proposalLabel({ ...p, fields: displayedFields(s, sel.inv, p) }) }], meta: `${p.status} · ${experimentsUsed(sel.inv) + (p.status === "proposed" ? 1 : 0)} / ${c.budgets.maxExperiments} experiments`, actions: [EXPORT],
        body: { kind: "decision", cards: [candidatesSection(s, c, sel.inv, p), reasoningSection(c, p)] }, credit: "" };
    }
    case "truth": return { crumb: [invCrumb(sel.inv), { label: "Ground truth" }], meta: "Revealed after outcome", actions: [EXPORT],
      body: { kind: "panels", panels: truthPanels(sel.inv.reveal!) }, credit: "Synthetic: truth was hidden from the agent until the outcome." };
    case "validate": {
      const c = configFor(project, sel.inv), v = sel.inv.validation;
      if (v.state === "needs-data") return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: "needs data", actions: [EXPORT], body: { kind: "missing", title: "Not recorded yet", description: sel.inv.measurements.some((m) => m.split === "test") ? "Held-out measurements are present; no validation check recorded yet" : "Needs a held-out measurement" }, credit: credit(c, sel.inv, []) };
      if (v.state === "summary") {
        const fit = latestFit(sel.inv);
        const predicted = fit && v.measurements.filter((id) => fit.curves[id]);
        if (fit && predicted?.length) return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} · ${v.passed ? "passed" : "failed"}`, actions: [EXPORT],
          body: { kind: "panels", panels: predicted.flatMap((id) => validationPanels({ config: c, inv: sel.inv }, fit, id, fit.curves[id].fit, fit.curves[id].t)) }, credit: credit(c, sel.inv, predicted, ` · fit #${fit.n}`) };
        return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} · ${v.passed ? "passed" : "failed"}`, actions: [EXPORT],
          body: { kind: "missing", title: "Not recorded yet", description: `Held-out check ${v.passed ? "passed" : "failed"}: χ²/N ${v.chi2N.toFixed(2)} (≤ ${sig(v.threshold, 3)})${v.measurements.length ? ` on ${v.measurements.join(", ")}` : ""}. The predicted series is not recorded.` },
          credit: credit(c, sel.inv, v.measurements) };
      }
      const fit = sel.inv.fits.find((f) => f.n === v.fit)!;
      return { crumb: [invCrumb(sel.inv), { label: "Validate" }], meta: `χ²/N ${v.chi2N.toFixed(2)} on ${v.measurement}`, actions: [EXPORT],
        body: { kind: "panels", panels: validationPanels({ config: c, inv: sel.inv }, fit, v.measurement, v.predicted) }, credit: credit(c, sel.inv, [v.measurement], ` · fit #${fit.n}`) };
    }
  }
}
