/// <reference lib="deno.ns" />
/**
 * Rendering only: a given view model produces the expected markup, and the components report
 * the raw intent of what was clicked or typed. No domain logic exists here to test.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { chartMarkup, scale } from "./charts.ts";
import { AutophysDetails, detailsMarkup } from "./details.ts";
import { intentOf } from "./intent.ts";
import { AutophysMain, mainMarkup } from "./main.ts";
import { listNodes, sectionMarkup, switcherMarkup, trailMarkup } from "./sidebar-markup.ts";
import type { DetailsModel, MainModel, SidebarModel, TreeNode, XYChart } from "./view-model.ts";

const count = (s: string, needle: string) => s.split(needle).length - 1;

const xy: XYChart = {
  kind: "xy", height: 150,
  x: { min: 0, max: 10, ticks: [{ value: 0, label: "0" }, { value: 10, label: "10 s" }] },
  y: { min: -1, max: 1, ticks: [{ value: -1, label: "-1" }, { value: 0, label: "0" }, { value: 1, label: "1" }] },
  layers: [
    { kind: "dots", points: [[0, 1], [5, 0], [10, -1], [NaN, 0]], tone: "measured" },
    { kind: "line", points: [[0, 1], [5, 0], [10, -1]], tone: "initial", dashed: true },
    { kind: "line", points: [[0, 1], [5, NaN], [10, -1]], tone: "fit" },
    { kind: "hline", y: 0, tone: "muted" },
  ],
  label: "x · m", legend: [{ label: "measured", mark: "dot", tone: "measured" }, { label: "fit", mark: "line", tone: "fit" }],
};

Deno.test("charts: an xy chart maps data to pixels and draws exactly the layers it is given", () => {
  const svg = chartMarkup(xy, 400, "t");
  assertEquals(count(svg, "<circle"), 3 + 1, "three finite dots plus the legend dot; the NaN point is skipped");
  assertStringIncludes(svg, `class="ap-line ap-s-initial ap-dashed"`);
  // the fit line breaks at its NaN: two separate move-tos
  const fit = svg.match(/class="ap-line ap-s-fit" d="([^"]*)"/)![1];
  assertEquals(count(fit, "M"), 2);
  assertStringIncludes(svg, `clip-path="url(#ap-clip-t)"`);
  assertStringIncludes(svg, ">10 s<");
  // the first dot sits on the plot's left edge, the last on its right edge
  assertStringIncludes(svg, `cx="44.0"`);
  assertStringIncludes(svg, `cx="388.0"`);
  const hidden = chartMarkup({ ...xy, xTicks: false }, 400, "u");
  assert(!hidden.includes(">10 s<"), "xTicks: false hides the x labels");
});

Deno.test("charts: log axes, heatmaps, bars and ranges", () => {
  const s = scale({ min: 1, max: 100, ticks: [], log: true }, 0, 200);
  assertEquals([s(1), s(10), s(100)], [0, 100, 200]);
  const heat = chartMarkup({
    kind: "heatmap", height: 200, cols: 2, rows: 2, values: [0, 0.25, 0.5, 2],
    x: { min: 0, max: 1, ticks: [] }, y: { min: 0, max: 1, ticks: [] }, trail: { points: [[0.1, 0.1], [0.5, 0.5]], label: "Fit #1" },
  }, 300, "h");
  assertEquals(count(heat, "fill-opacity="), 4);
  assertStringIncludes(heat, `fill-opacity="1.000"`, "opacities are clamped to 1");
  assertStringIncludes(heat, `ap-trail-dot last`);
  assertStringIncludes(heat, ">Fit #1<");
  const bars = chartMarkup({ kind: "bars", rows: [{ label: "Sine 0.44 Hz", fraction: 1, value: "651" }, { label: "Step", fraction: 0.39, value: "251", tone: "warn" }] }, 300, "b");
  assertStringIncludes(bars, `width:100.0%`);
  assertStringIncludes(bars, `ap-bar-fill ap-t-warn" style="width:39.0%`);
  const ranges = chartMarkup({ kind: "ranges", rows: [{ label: "m", unit: "kg", lo: "0.5", hi: "4", at: 0.25, tag: { text: "free" } }] }, 300, "r");
  assertStringIncludes(ranges, `left:25.0%`);
  assertStringIncludes(ranges, `>free<`);
});

const tree: TreeNode[] = [{
  id: "a", label: "bench A", icon: "investigation", selectable: true, trail: { badge: "1" },
  children: [{ id: "a/fit-1", label: "Fit #1", icon: "fit", selectable: true, trail: { text: "χ² 1.02", tone: "ok" }, children: [] },
    { id: "a/v", label: "Validate", icon: "validate", selectable: true, dim: true, trail: { text: "needs data" }, children: null }],
}, { id: "b", label: "cell A", icon: "investigation", selectable: true, trail: { spinner: true, text: "12/40", tone: "run" }, children: null }];

Deno.test("sidebar: tree nodes carry the given labels, glyphs, dim and trails, built through the factories", () => {
  const made: unknown[] = [];
  const nodes = listNodes(tree, {
    lead: (svg, dim) => { made.push(["lead", dim]); return svg; },
    trail: (html, tone) => { made.push(["trail", html, tone]); return html; },
  });
  assertEquals(nodes.map((n) => n.id), ["a", "b"]);
  assertEquals(nodes[0].children!.map((n) => [n.id, n.children === null]), [["a/fit-1", false], ["a/v", true]]);
  assertEquals(made, [], "nothing is built until the tree draws a row");
  nodes[0].children![1].$lead();
  nodes[0].children![0].$trail!();
  nodes[1].$trail!();
  assertEquals(made[0], ["lead", true]);
  assertEquals(made[1], ["trail", "<span>χ² 1.02</span>", "ok"]);
  assertEquals((made[2] as string[])[2], "run");
  assertStringIncludes((made[2] as string[])[1], "ap-spin");
  assertEquals(trailMarkup({ badge: "1" }), `<span class="ap-badge">1</span>`);
  assertEquals(listNodes([{ ...tree[1], trail: {} }], { lead: () => 0, trail: () => 0 })[0].$trail, null, "an empty trail draws nothing");
});

const sidebar: SidebarModel = {
  switcher: { kind: "select", label: "Project", value: "p2", options: [{ value: "p1", label: "Bench oscillators" }, { value: "p2", label: "Cell <pulse> tests" }] },
  pinned: { id: "cfg", label: "Configuration", icon: "config", selectable: true, children: null },
  section: { label: "Investigations", count: "2", add: { name: "new", label: "New investigation", disabled: true } },
  nodes: tree, treeLabel: "Investigations", selectedId: "a", expandedIds: ["a"],
};

Deno.test("sidebar: the switcher and section head", () => {
  const sw = switcherMarkup(sidebar);
  assertStringIncludes(sw, `Cell &lt;pulse&gt; tests`);
  assertStringIncludes(sw, `data-ap-switcher`);
  const head = sectionMarkup(sidebar);
  assertStringIncludes(head, `Investigations<span class="ap-count">2</span>`);
  assertStringIncludes(head, `data-ap="action" data-ap-name="new"`);
  assertStringIncludes(head, " disabled");
});

const main: MainModel = {
  crumb: [{ label: "bench A", id: "a" }, { label: "Fit #1", id: "a/fit-1" }, { label: "Landscape" }],
  meta: "38 evals · χ²/N 1.02", actions: [{ name: "export", label: "Export", variant: "ghost" }],
  body: { kind: "panels", columns: 2, panels: [{ title: "free_response@1", charts: [xy, xy] }, { charts: [xy] }] },
  credit: "oscillator v0.1 · free_response@1 · seed 42",
};

Deno.test("main: crumb links, meta, buttons, panels in columns and one credit line", () => {
  const html = mainMarkup(main, 824, { toolbar: "viewer-toolbar", button: "workbench-button" });
  assertStringIncludes(html, `class="viewer-toolbar ap-toolbar"`);
  assertStringIncludes(html, `data-ap="select" data-ap-id="a/fit-1">Fit #1</button>`);
  assertStringIncludes(html, `<b>Landscape</b>`);
  assertStringIncludes(html, `class="workbench-button ap-btn ap-btn-ghost" data-ap="action" data-ap-name="export"`);
  assertEquals(count(html, `<section class="ap-panel">`), 2);
  assertEquals(count(html, `<svg`), 3);
  assertStringIncludes(html, `width="394"`, "two columns of (824 - 24 - 12) / 2 px");
  assertEquals(count(html, `class="ap-credit"`), 1);
  const empty = mainMarkup({ ...main, body: { kind: "empty", text: "Needs data" } }, 600);
  assertStringIncludes(empty, `ap-viewer ap-empty"><p>Needs data</p>`);
});

const proposal: DetailsModel = {
  icon: "proposal", title: "Sine force", cardName: true, status: { text: "Awaiting approval" },
  sections: [
    { heading: "Experiment", blocks: [{ kind: "fields", fields: [{ name: "amplitude", label: "Amplitude", value: "2.0", unit: "N" }, { name: "rate", label: "Rate", value: "9999", unit: "Hz", invalid: "10 to 1000" }] }] },
    { heading: "Expected", blocks: [{ kind: "facts", rows: [{ label: "m", value: "unbounded → ±0.2%" }, { label: "Amplitude", value: "1.5 N", note: "(was 2.0)", tag: { text: "edited", tone: "warn" } }] }] },
    { heading: "Parameters", blocks: [{ kind: "table", rows: [{ dim: true, cells: [{ text: "m", unit: "kg" }, { text: "2.31", end: true }, { text: "", tag: { text: "ridge", tone: "warn" }, end: true }] }] }] },
    { heading: "Budget", blocks: [{ kind: "meters", rows: [{ label: "Agent steps", value: "7 / 20", fraction: 0.35 }] }] },
    { heading: "Hypothesis", blocks: [{ kind: "text", text: "Mass is not identifiable.", link: { label: "Proposal →", id: "a/prop/p1" } }] },
  ],
  decision: [{ name: "approve", label: "Approve", variant: "primary" }, { name: "reject", label: "Reject" }],
};

const classes = { name: "detail-name", status: "review-status", decision: "decision-actions", button: "workbench-button", primary: "primary" };

Deno.test("details: header, sections and a decision row of exactly two direct buttons", () => {
  const html = detailsMarkup(proposal, classes);
  assertStringIncludes(html, `<h3 class="detail-name ap-dname" data-card-name>`);
  assertStringIncludes(html, `class="review-status ap-status" id="ap-status" role="status">Awaiting approval</p>`);
  const row = html.match(/<div class="decision-actions ap-decision">(.*?)<\/div>/)![1];
  assertEquals(count(row, "<button"), 2);
  assert(/^<button[^>]*>Approve<\/button><button[^>]*>Reject<\/button>$/.test(row), "only the two buttons, as direct children");
  assertStringIncludes(row, `class="workbench-button primary ap-btn ap-btn-primary"`);
  assertStringIncludes(html, `id="ap-field-amplitude" data-ap="field" data-ap-name="amplitude" value="2.0"`);
  assertStringIncludes(html, `ap-field ap-invalid`);
  assertStringIncludes(html, `<small class="ap-field-error">10 to 1000</small>`);
  assertStringIncludes(html, `<span class="ap-note">(was 2.0)</span> <span class="ap-tag ap-t-warn">edited</span>`);
  assertStringIncludes(html, `<tr class="ap-dim">`);
  assertStringIncludes(html, `style="width:35.0%"`);
  assertStringIncludes(html, `data-ap="select" data-ap-id="a/prop/p1">Proposal →</button>`);
  const one = detailsMarkup({ ...proposal, decision: undefined, actions: [{ name: "withdraw", label: "Withdraw approval" }] }, classes);
  assert(!one.includes("decision-actions"), "no decision row unless one is given");
  assertStringIncludes(one, `<div class="ap-actions ap-one">`);
});

Deno.test("intents: clicks, typing, commits and the switcher, read from the element", () => {
  const el = (attrs: Record<string, string>, extra: { value?: string; disabled?: boolean } = {}) => ({ getAttribute: (n: string) => attrs[n] ?? null, ...extra });
  assertEquals(intentOf(el({ "data-ap": "select", "data-ap-id": "a/fit-1" }), "click"), { kind: "select", id: "a/fit-1" });
  assertEquals(intentOf(el({ "data-ap": "action", "data-ap-name": "approve" }), "click"), { kind: "action", name: "approve" });
  assertEquals(intentOf(el({ "data-ap": "action", "data-ap-name": "approve" }, { disabled: true }), "click"), null);
  assertEquals(intentOf(el({ "data-ap": "field", "data-ap-name": "amplitude" }, { value: "1.5x" }), "input"), { kind: "field", name: "amplitude", raw: "1.5x", commit: false });
  assertEquals(intentOf(el({ "data-ap": "field", "data-ap-name": "amplitude" }, { value: "1.5" }), "change"), { kind: "field", name: "amplitude", raw: "1.5", commit: true });
  assertEquals(intentOf(el({ "data-ap": "switch" }, { value: "p2" }), "change"), { kind: "switch", value: "p2" });
  assertEquals(intentOf(el({ "data-ap": "field", "data-ap-name": "amplitude" }), "click"), null);
  assertEquals(intentOf(el({}), "click"), null);
});

/** A host stand-in: records listeners and markup, so a component can be driven without a DOM. */
function fakeHost() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const host = {
    innerHTML: "", clientWidth: 640,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    contains: () => true,
    getRootNode: () => ({ activeElement: null }),
    querySelector: () => null,
  };
  const fire = (type: string, target: unknown) => listeners.get(type)?.forEach((fn) => fn({ target }));
  return { host, fire };
}

Deno.test("components: they draw what they are given and forward the raw intent", () => {
  const got: unknown[] = [];
  const { host, fire } = fakeHost();
  const details = new AutophysDetails(host as unknown as HTMLElement, (i) => got.push(i), classes);
  details.render(proposal);
  assertEquals(host.innerHTML, detailsMarkup(proposal, classes));
  const button = { getAttribute: (n: string) => ({ "data-ap": "action", "data-ap-name": "reject" } as Record<string, string>)[n] ?? null };
  fire("click", { closest: () => button });
  fire("change", { getAttribute: (n: string) => ({ "data-ap": "field", "data-ap-name": "rate" } as Record<string, string>)[n] ?? null, value: "200" });
  fire("click", { closest: () => null });
  assertEquals(got, [{ kind: "action", name: "reject" }, { kind: "field", name: "rate", raw: "200", commit: true }]);
  details.destroy();

  const m = fakeHost();
  const seen: unknown[] = [];
  const view = new AutophysMain(m.host as unknown as HTMLElement, (i) => seen.push(i), {});
  m.fire("click", { closest: () => ({ getAttribute: (n: string) => ({ "data-ap": "select", "data-ap-id": "a" } as Record<string, string>)[n] ?? null }) });
  assertEquals(seen, [{ kind: "select", id: "a" }], "clicks forward before any render (rendering needs a document; see mainMarkup tests)");
  view.destroy();
});
