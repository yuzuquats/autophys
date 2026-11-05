import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mainMarkup } from "./main.ts";
import type { InvestigationBody, MainModel } from "./view-model.ts";
const body: InvestigationBody = { kind: "investigation", pageId: "inv", selectionId: "inv", target: "summary",
  jumps: [{ label: "Summary", target: "summary" }], summary: { id: "summary", heading: "Summary", blocks: [] }, outcome: [],
  rounds: [{ id: "round", title: "Round 1", caption: "Fit #1", open: true,
    data: { id: "data", heading: "Data", blocks: [], rows: [{ id: "measurement", label: "free_response@1", meta: "train · 10 samples", open: false, panels: [] }] },
    fit: { id: "fit", heading: "Fit #1", blocks: [] }, parameters: { id: "params", heading: "Parameters", blocks: [] },
    identifiability: { id: "identification", heading: "Identifiability", blocks: [] }, landscape: null, proposals: [], extras: [] }] };
const model: MainModel = { crumb: [{label:"Investigation"}], meta:"", actions:[], credit:"must not appear on investigation pages", body };
Deno.test("investigation markup: one Data card with inline disclosure; no Export or bottom provenance", () => {
  const html = mainMarkup(model, 900);
  assertEquals((html.match(/<h3>Data<\/h3>/g) ?? []).length, 1);
  assertStringIncludes(html, '<details class="ap-measurement" id="measurement" data-ap-disclosure>');
  assert(!html.includes("ap-credit") && !html.includes("must not appear"));
  assert(!html.includes("Export") && !html.includes("View measurement"));
  assertStringIncludes(html, 'aria-label="Jump to investigation section"');
});
Deno.test("investigation markup: Parameters and Identifiability stack beside Fit above 760px", () => {
  const wide = mainMarkup(model, 900), narrow = mainMarkup(model, 750);
  assertStringIncludes(wide, 'class="ap-fit-layout ap-wide"');
  assertStringIncludes(wide, '<div class="ap-fit-aside"><section id="params"');
  assert(wide.indexOf('id="params"') < wide.indexOf('id="identification"'));
  assertStringIncludes(narrow, 'class="ap-fit-layout"');
  assert(!narrow.includes('class="ap-fit-layout ap-wide"'));
});

Deno.test("investigation markup: missing supplemental targets render their explanation", () => {
  const copy = structuredClone(body), round = copy.rounds[0];
  round.extras = [{ id: "frequency-missing", heading: "Frequency", blocks: [{ kind: "missing", title: "Not recorded yet", description: "No frequency data recorded for this fit." }], panels: [] }];
  const html = mainMarkup({ ...model, body: copy }, 824);
  assertStringIncludes(html, 'id="frequency-missing"');
  assertStringIncludes(html, "No frequency data recorded for this fit.");
});
