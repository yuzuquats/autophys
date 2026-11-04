/// <reference lib="deno.ns" />
/** Domain → view model: tree nodes and trails per state, view-hint leaves, ridge greying, panels, outlook. */
Deno.test("derive: Fit residual strip shares time axis and uses only matching downsampled samples", async () => {
  const { fitPanels, residualPanels } = await import("./charts.ts");
  const { sigmaOf } = await import("../config.ts");
  const project = structuredClone(ws.projects[0]), inv = project.investigations[0], fit = inv.fits[0], m = inv.measurements[0];
  const config = project.configs.find((c) => c.version === inv.configVersion)!;
  const ctx = { config, inv }, sigma = sigmaOf(config);
  fit.curves[m.id] = { t: [m.t[0], m.t[4]], fit: [m.output[0] - sigma, m.output[4] + 2 * sigma], initial: [0, 0] };
  const panel = fitPanels(ctx, fit)[0], strip = panel.charts.at(-1)!;
  assert(strip.kind === "xy");
  assertEquals(strip.height, 80);
  assertEquals(strip.layers[0], { kind: "hband", from: -1, to: 1, tone: "muted" });
  const output = panel.charts.find((c) => c.kind === "xy" && c.layers.some((l) => l.kind === "line" && l.tone === "fit"))!;
  assert(output.kind === "xy");
  assertEquals(strip.x, output.x);
  const line = output.layers.find((l) => l.kind === "line" && l.tone === "fit")!;
  assert(line.kind === "line");
  assertEquals(line.points.map((p) => p[0]), [m.t[0], m.t[4]]);
  const dots = strip.layers.at(-1)!;
  assert(dots.kind === "dots");
  assertEquals(dots.points.length, 2);
  assertAlmostEquals(dots.points[0][1], 1);
  assertAlmostEquals(dots.points[1][1], -2);
  assertEquals(residualPanels(ctx, fit).length, 1);
  fit.curves = {};
  assert(fitPanels(ctx, fit)[0].charts.some((c) => c.kind === "missing"));
  assertEquals(residualPanels(ctx, fit), []);
});

Deno.test("derive: Ground truth is conditional and formats payload ratios, tolerance and within", async () => {
  const { investigationNode } = await import("./tree.ts");
  const { groundTruthNode, truthPanels } = await import("./truth.ts");
  const project = structuredClone(ws.projects[0]), inv = project.investigations[1];
  assert(inv.reveal);
  inv.reveal.tolerance = .2;
  inv.reveal.quantities[0].within = false;
  inv.reveal.quantities[0].ratio = 1.37;
  inv.reveal.quantities[0].sigma_ratio = .06;
  assertEquals(groundTruthNode(inv), { id: inv.id + "/truth", label: "Ground truth", icon: "validate", selectable: true, children: null });
  const state = { ...s0, ws: { ...ws, projects: [project] }, projectId: project.id, selected: { [project.id]: inv.id + "/truth" } };
  assertEquals(parseSel(project, inv.id + "/truth")?.kind, "truth");
  const model = mainModel(state);
  assert(model.body.kind === "panels");
  assertStringIncludes(model.body.panels[0].title!, "2 of 3 within ±20%");
  assertStringIncludes(model.credit, "truth was hidden from the agent");
  const chart = truthPanels(inv.reveal)[0].charts[0];
  assert(chart.kind === "xy");
  assertEquals(chart.layers[0], { kind: "vband", from: .8, to: 1.2, tone: "muted" });
  assert(chart.layers.some((l) => l.kind === "dots" && l.points[0][0] === 1.37));
  const whisker = chart.layers[2];
  assert(whisker.kind === "line");
  assertAlmostEquals(whisker.points[0][0], 1.31);
  assertAlmostEquals(whisker.points[1][0], 1.43);
  delete inv.reveal;
  assertEquals(groundTruthNode(inv), null);
  assert(!investigationNode(project, inv).children!.some((n) => n.label === "Ground truth"));
  assertEquals(parseSel(project, inv.id + "/truth"), null);
});

Deno.test("derive: held-out curves populate Validation without re-scoring its summary", () => {
  const project = structuredClone(ws.projects[0]), inv = project.investigations[1], fit = inv.fits.at(-1)!;
  const test = inv.measurements.find((m) => m.split === "test")!;
  fit.curves[test.id] = { t: [test.t[0], test.t[4]], fit: [.1, .2], initial: [0, 0] };
  inv.validation = { state: "summary", passed: true, chi2N: 1.23, threshold: 2, measurements: [test.id] };
  const state = { ...s0, ws: { ...ws, projects: [project] }, projectId: project.id, selected: { [project.id]: inv.id + "/validate" } };
  const model = mainModel(state);
  assert(model.body.kind === "panels");
  assertStringIncludes(model.meta, "1.23");
  const chart = model.body.panels[0].charts.at(-1)!;
  assert(chart.kind === "xy");
  const line = chart.layers.find((l) => l.kind === "line")!;
  assert(line.kind === "line");
  assertEquals(line.points, [[test.t[0], .1], [test.t[4], .2]]);
});

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { initialSelection } from "../controller.ts";
import { fixtures, replay } from "../fixtures/source.ts";
import type { TreeNode } from "../../ui/view-model.ts";
import { detailsModel } from "./details.ts";
import { derive, connectionFailure, interpolate, outlookAt, parseSel, viewsOf } from "./index.ts";
import { mainModel, rankingBars } from "./main.ts";
import { draftKey } from "./shared.ts";
import { sidebarModel } from "./tree.ts";

const src = fixtures(), snap = await src.load();
const ws = replay(snap.workspace, src.log);
const s0 = { ...initialSelection(ws), ws };
const at = (projectId: string, id: string) => ({ ...s0, projectId, selected: { ...s0.selected, [projectId]: id } });
const find = (nodes: TreeNode[], id: string): TreeNode | undefined => {
  for (const n of nodes) { if (n.id === id) return n; const hit = n.children && find(n.children, id); if (hit) return hit; }
};

Deno.test("derive: view hints decide the leaves under each fit", () => {
  const leaves = (pid: string, iid: string, n: number) => {
    const p = ws.projects.find((x) => x.id === pid)!, inv = p.investigations.find((i) => i.id === iid)!;
    return viewsOf(p.configs.find((c) => c.version === inv.configVersion)!, inv, inv.fits.find((f) => f.n === n)!);
  };
  assertEquals(leaves("bench-oscillators", "bench-a", 1), ["fit", "residuals", "landscape", "envelope"]);
  assertEquals(leaves("bench-oscillators", "bench-b", 2), ["fit", "residuals", "landscape", "envelope", "frequency"]);
  assertEquals(leaves("cell-pulse-tests", "cell-a", 1), ["fit", "residuals", "landscape", "zoom:edges"]);
  assertEquals(leaves("lab-heaters", "heater-1", 2), ["fit", "residuals", "landscape"]);
});

Deno.test("derive: investigation trails: badge, spinner, ± and the rows under bench A", () => {
  const side = sidebarModel(s0);
  assertEquals(side.switcher.options.map((o) => o.label), ["Bench oscillators", "Cell pulse tests", "Lab heaters"]);
  assertEquals(side.pinned, { id: "config:bench-oscillators", label: "Configuration", icon: "config", selectable: true, children: null, trail: { text: "v2" } });
  const a = side.nodes[0];
  assertEquals(a.trail, { badge: "1" });
  assertEquals(a.children!.map((c) => c.label), ["Measurements", "Fit #1", "Sensitivity", "Sine 0.44 Hz", "Validate"]);
  assertEquals(find(side.nodes, "bench-a/data/free_response@1")!.trail, { text: "1,000" });
  assertEquals(find(side.nodes, "bench-a/fit-1")!.trail!.tone, "ok");
  assertEquals(find(side.nodes, "bench-a/fit-1")!.children!.map((c) => c.id), ["bench-a/fit-1/fit", "bench-a/fit-1/residuals", "bench-a/fit-1/landscape", "bench-a/fit-1/envelope"]);
  assertEquals(find(side.nodes, "bench-a/sens")!.trail, { text: "rank 2/3", tone: "warn" });
  assertEquals(find(side.nodes, "bench-a/prop/p1")!.trail, { text: "proposed" });
  assertEquals(find(side.nodes, "bench-b/prop/p1")!.trail, { text: "data in", tone: "ok" }, "the replayed approval");
  const v = find(side.nodes, "bench-a/validate")!;
  assertEquals([v.dim, v.trail], [true, { text: "needs data" }]);
  assert(side.nodes[1].trail!.text!.startsWith("±") && side.nodes[1].trail!.tone === "ok");
  const cell = sidebarModel({ ...s0, projectId: "cell-pulse-tests" }).nodes[0];
  assertEquals(cell.trail, { spinner: true, text: "12/40", tone: "run" });
  const running = find([cell], "cell-a/fit-2")!;
  assertEquals([running.trail!.spinner, running.trail!.tone, running.children], [true, "run", null]);
});

Deno.test("derive: a fit on a ridge greys its raw parameters and tags the combinations it pins", () => {
  const table = detailsModel(at("bench-oscillators", "bench-a/fit-1")).sections[0].blocks[0];
  assert(table.kind === "table");
  assertEquals(table.rows.map((r) => [r.cells[0].text, !!r.dim, r.cells[2].tag?.text.startsWith("±") ? "±" : r.cells[2].tag?.text]), [
    ["m", true, "ridge"], ["c", true, "ridge"], ["k", true, "ridge"], ["k/m", false, "±"], ["c/m", false, "±"],
  ]);
  const quality = detailsModel(at("lab-heaters", "heater-1/fit-1")).sections[1].blocks[0];
  assert(quality.kind === "facts");
  assertEquals(quality.rows.find((r) => r.label === "Residuals"), { label: "Residuals", value: "structured", tone: "warn" });
});

Deno.test("derive: the proposal panel carries the phone-card decision row and the ranking", () => {
  const d = detailsModel(at("bench-oscillators", "bench-a/prop/p1"));
  assertEquals([d.title, d.cardName, d.status.text], ["Sine force", true, "Awaiting approval"]);
  assertEquals(d.decision!.map((a) => a.name), ["approve", "reject"]);
  const fields = d.sections[0].blocks[0];
  assert(fields.kind === "fields");
  assertEquals(fields.fields.map((f) => [f.name, f.value, f.unit]), [["amplitude", "2.00", "N"], ["frequency", "0.440", "Hz"], ["duration", "10.0", "s"], ["rate", "100", "Hz"]]);
  const bars = d.sections[2].blocks[0];
  assert(bars.kind === "bars");
  assertEquals([bars.rows[0].label, bars.rows[0].fraction, bars.rows.at(-1)!.value], ["Sine 0.44 Hz", 1, "≈ 0"]);
});

Deno.test("derive: interpolation returns a grid node's own value exactly, and is multilinear between nodes", () => {
  const p = ws.projects[0].investigations[0].proposals[0], o = p.outlook;
  const [A, F, D] = o.axes.map((a) => a.values);
  for (const [ia, jf, kd] of [[0, 0, 0], [5, F.indexOf(0.44), 2], [A.length - 1, F.length - 1, D.length - 1]]) {
    const idx = (ia * F.length + jf) * D.length + kd;
    assertEquals(interpolate(o, o.score, { amplitude: A[ia], frequency: F[jf], duration: D[kd] }), o.score[idx]);
    assertEquals(interpolate(o, o.after.m, { amplitude: A[ia], frequency: F[jf], duration: D[kd] }), o.after.m[idx]);
  }
  const lo = (1 * F.length + 2) * D.length + 3, hi = (2 * F.length + 2) * D.length + 3;
  assertAlmostEquals(interpolate(o, o.score, { amplitude: (A[1] + A[2]) / 2, frequency: F[2], duration: D[3] })!, (o.score[lo] + o.score[hi]) / 2, 1e-9);
  assertEquals(interpolate(o, o.score, { amplitude: 9, frequency: 0.44, duration: 10 }), null, "off the grid");
});

Deno.test("derive: a smaller edited amplitude scores lower and widens the expected uncertainty", () => {
  const inv = ws.projects[0].investigations[0], p = inv.proposals[0];
  const base = at("bench-oscillators", "bench-a/prop/p1");
  const edited = { ...base, edits: { [draftKey(inv, p, "amplitude")]: 1 } };
  const own = (s: typeof base) => rankingBars(s, inv, p).find((r) => r.label === "Sine 0.44 Hz")!;
  const before = outlookAt(p, p.fields)!, after = outlookAt(p, p.fields.map((f) => (f.name === "amplitude" ? { ...f, value: 1 } : f)))!;
  assert(after.score < before.score && after.after.m! > before.after.m!);
  assert(Number(own(edited).value.replace(/,/g, "")) < Number(own(base).value.replace(/,/g, "")));
  assertEquals(detailsModel(edited).status.text, "Awaiting approval · edited");
});

Deno.test("derive: main views: crumb, panels, credit; derive() before load shows loading", () => {
  const land = mainModel(s0);
  assertEquals(land.crumb, [{ label: "bench A", id: "bench-a" }, { label: "Fit #1", id: "bench-a/fit-1" }, { label: "Landscape" }]);
  assert(land.body.kind === "panels" && land.body.panels[0].charts[0].kind === "heatmap");
  assertStringIncludes(land.credit, "oscillator v0.1 · free_response@1 · seed 42");
  const fit = mainModel(at("bench-oscillators", "bench-b/fit-2/fit"));
  assert(fit.body.kind === "panels");
  assertEquals(fit.body.panels.map((p) => [p.title, p.charts.map((c) => c.kind)]), [["free_response@1", ["xy", "xy", "xy"]], ["sine_044@1", ["xy", "xy", "xy"]]]);
  const edges = mainModel(at("cell-pulse-tests", "cell-a/fit-1/zoom:edges"));
  assert(edges.body.kind === "panels" && edges.body.columns === 2 && edges.body.panels.length === 4);
  const freq = mainModel(at("bench-oscillators", "bench-b/fit-2/frequency"));
  assert(freq.body.kind === "panels" && freq.body.panels[0].charts.length === 2);
  assertEquals(mainModel(at("bench-oscillators", "bench-a/validate")).body, { kind: "missing", title: "Not recorded yet", description: "Needs a held-out measurement" });
  assertEquals(parseSel(ws.projects[0], "bench-a/fit-1/frequency"), null);
  assertEquals(derive(null, s0).main.body.kind, "loading");
  assertEquals(derive({ ...snap, workspace: ws }, s0).sidebar.nodes.length, 2);
});

Deno.test("derive: empty, loading, project-only and demo states have explicit kinds and next steps", () => {
  const loading = derive(null, s0);
  assertEquals(loading.sidebar.switcher.kind, "loading");
  assertEquals(loading.main.body.kind, "loading");
  const empty = derive({ ...snap, source: "daemon", workspace: { user: "reviewer", projects: [] }, pairings: [] }, s0);
  assertEquals(empty.sidebar.switcher.kind, "none");
  assertEquals(empty.sidebar.notice?.kind, "no-projects");
  assertEquals(empty.sidebar.section.label, "");
  assertEquals(empty.main.body.kind, "onboarding");
  assertStringIncludes(JSON.stringify(empty.details), "daemon URL");
  const project = { ...ws.projects[0], investigations: [] };
  const one = derive({ ...snap, workspace: { ...ws, projects: [project] } }, initialSelection({ ...ws, projects: [project] }));
  assertEquals(one.sidebar.switcher.kind, "single");
  assertEquals(one.sidebar.notice?.kind, "no-investigations");
  assertEquals(one.main.body.kind, "configuration");
  assertEquals(one.main.source, "demo");
  const failed = connectionFailure(loading, "401 session_expired", false);
  assertEquals(failed.main.body.kind, "unavailable");
  assertEquals(failed.sidebar.switcher.kind, "unavailable");
  assertStringIncludes(failed.main.connectionError!, "401");
});

Deno.test("derive: clipboard acknowledgement is a view-model label", () => {
  const copied = derive({ ...snap, workspace: { ...ws, projects: [] } }, { ...s0, copyStatus: "copied" });
  assert(copied.main.body.kind === "onboarding");
  assertEquals(copied.main.body.copyLabel, "Copied Python");
});

Deno.test("configuration: ranges have SI bounds, labelled scales and initial values", () => {
  const project = structuredClone(ws.projects[0]);
  project.configs = [{ ...project.configs[0], params: [
    { name: "C1", unit: "F", lo: 10, hi: 100_000, initial: 1500, fixed: false, coord: "log" },
    { name: "R0", unit: "ohm", lo: .001, hi: .5, initial: .03, fixed: false, coord: "log" },
  ] }];
  project.investigations = [];
  const workspace = { ...ws, projects: [project] };
  const view = derive({ ...snap, workspace }, initialSelection(workspace));
  const body = view.main.body;
  assert(body.kind === "configuration");
  assertEquals(body.parameters.rows.map((r) => [r.lo, r.hi, r.initial, r.scale]), [
    ["10 F", "100 kF", "Initial 1.5 kF", "log scale"],
    ["1 mΩ", "500 mΩ", "Initial 30 mΩ", "log scale"],
  ]);
  assertEquals(body.sections.map((s) => s.heading), ["Experiments", "Noise", "Budget"]);
  assert(!view.main.creditLabel?.includes("sha256:"));
});

Deno.test("pairing: two devices keep their own decisions and absolute expiry input", () => {
  const pairings = ["FIRST-1234", "NEXT-5678"].map((code, i) => ({ code, device: `Device ${i}`, client: "autophys-python/0.1", expires: "2026-11-04T20:00:00Z" }));
  const view = derive({ ...snap, workspace: { ...ws, projects: [] }, pairings }, s0);
  const cards = view.details.sections.flatMap((s) => s.blocks).filter((b) => b.kind === "pairing");
  assertEquals(cards.map((c) => [c.device, c.code, c.expiry.at, c.decision.map((a) => a.name)]), [
    ["Device 0", "FIRST-1234", pairings[0].expires, ["pair-approve:FIRST-1234", "pair-deny:FIRST-1234"]],
    ["Device 1", "NEXT-5678", pairings[1].expires, ["pair-approve:NEXT-5678", "pair-deny:NEXT-5678"]],
  ]);
  assertEquals(view.details.actions?.length ?? 0, 0);
});

Deno.test("unconfigured project: Details has one section-aligned next step", () => {
  const project = { ...ws.projects[0], configs: [], investigations: [] };
  const workspace = { ...ws, projects: [project] };
  const view = derive({ ...snap, workspace }, initialSelection(workspace));
  assertEquals(view.details.status.text, "Awaiting first investigation");
  assertEquals(view.details.sections[0].heading, "");
  assertEquals(view.details.sections[0].blocks[0].kind, "missing");
  assert(!JSON.stringify(view.details).includes("Not recorded yet"));
});
