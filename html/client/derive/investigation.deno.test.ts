import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { initialSelection, reduce, reportText } from "../controller.ts";
import { fixtures, replay } from "../fixtures/source.ts";
import { detailsModel } from "./details.ts";
import { mainModel } from "./main.ts";
import { investigationRounds } from "./rounds.ts";
import { parseSel, plusMinus } from "./shared.ts";
import { stateOf } from "../proposal.ts";

const src = fixtures(), snap = await src.load(), ws = replay(snap.workspace, src.log);
const initial = { ...initialSelection(ws), ws };
function state(projectId: string, id: string) {
  return { ...initial, projectId, selected: { ...initial.selected, [projectId]: id } };
}
function page(projectId: string, id: string) {
  const body = mainModel(state(projectId, id)).body;
  assert(body.kind === "investigation");
  return body;
}

Deno.test("investigation rounds: one fit ends in its proposal, two fits keep their decisions", () => {
  const [a,b] = ws.projects[0].investigations;
  const one = investigationRounds(a), two = investigationRounds(b);
  assertEquals(one.map(r => [r.fit?.n, r.proposals.map(p => p.id)]), [[1, ["p1"]]]);
  assertEquals(two.map(r => [r.fit?.n, r.proposals.map(p => p.id)]), [[1, ["p1"]], [2, []]]);
  assert(two[1].measurements.some(m => m.split === "test"), "held-out data is kept in the newest Data card");
  const noFit = investigationRounds({ ...a, fits: [], proposals: [], measurements: [] });
  assertEquals(noFit.length, 1);
  assertEquals(noFit[0].fit, null);
});

Deno.test("investigation states: running round opens first; validated outcome leads and older round folds", () => {
  const running = page("cell-pulse-tests", "cell-a"), validated = page("bench-oscillators", "bench-b");
  assertEquals(running.rounds.map(r => [r.title, r.open]), [["Round 2", true], ["Round 1", false]]);
  assertEquals(validated.outcome.map(c => c.heading), ["Validate", "Ground truth"]);
  assertEquals(validated.rounds.map(r => [r.title, r.open]), [["Round 2", true], ["Round 1", false]]);
  assertStringIncludes(JSON.stringify(validated.summary), "Validated");
  assertStringIncludes(JSON.stringify(validated.summary), "Held-out χ²/N");
  assertStringIncludes(JSON.stringify(validated.summary), "±");
  const details = detailsModel(state("bench-oscillators", "bench-b"));
  assert(details.sections.some(s => s.heading === "Result"));
  assert(details.sections.some(s => s.heading === "Budget used"));
  assertStringIncludes(JSON.stringify(details), "held out");
  assertEquals(details.actions?.map(a => a.name), ["report"]);
  assert(details.footnote?.includes("config v1"));
});

Deno.test("legacy ids: cards, residual alias, supplemental views and older rounds retain targets", () => {
  for (const [id, expected] of [
    ["bench-b/fit-1", "round-1-fit"], ["bench-b/fit-1/fit", "round-1-fit"],
    ["bench-b/fit-1/residuals", "round-1-fit"], ["bench-b/fit-1/landscape", "round-1-landscape"],
    ["bench-b/fit-1/envelope", "round-1-envelope"], ["bench-b/fit-2/frequency", "round-2-frequency"],
    ["bench-b/sens", "round-2-identifiability"], ["bench-b/prop/p1", "round-1-proposal-p1"],
    ["bench-b/validate", "validate"], ["bench-b/truth", "truth"], ["bench-b/data", "round-2-data"],
    ["bench-b/data/free_response@1", "round-1-measurement-free_response%401"],
  ]) {
    assert(parseSel(ws.projects[0], id), id);
    const body = page("bench-oscillators", id);
    assert(body.target.endsWith(expected), id + " → " + body.target);
    const older = body.rounds.find(r => r.title === "Round 1")!;
    if (expected.startsWith("round-1-")) assert(older.open, "target opens its older round: " + id);
    if (expected.includes("measurement")) assert(older.data.rows?.find(r => r.label === "free_response@1")?.open);
  }
});

Deno.test("round data: one card, collapsed in-place rows, no invented round counters", () => {
  const body = page("bench-oscillators", "bench-a");
  assertEquals(body.rounds.length, 1);
  assertEquals(body.rounds[0].data.heading, "Data");
  assertEquals(body.rounds[0].data.rows?.map(r => [r.label, r.open]), [["free_response@1", false]]);
  const text = JSON.stringify(body.rounds.map(r => r.caption));
  assert(!text.includes("10:41") && !text.includes("11:06"), "mock times never become records");
  assert(!text.includes("412 /") && !text.includes("1,380 /"), "mock simulation counts are omitted");
  assertEquals(mainModel(state("bench-oscillators", "bench-a")).credit, "");
  assertEquals(mainModel(state("bench-oscillators", "bench-a")).creditLabel, undefined);
});

Deno.test("Details decision is shared by parent and leaf selections; removed Export has no effect", () => {
  for (const id of ["bench-a", "bench-a/fit-1", "bench-a/sens", "bench-a/prop/p1", "bench-a/data/free_response@1"]) {
    const s = state("bench-oscillators", id), d = detailsModel(s);
    assertEquals(d.decision?.map(a => a.name), ["approve", "reject"], id);
    assert(d.footnote?.includes("config v2"), id);
    assert(!JSON.stringify(d).includes('"Export"'));
    assert(d.actions?.some(a => a.name === "report"));
    const removed = reduce(s, { ...snap, workspace: ws }, { kind: "action", name: "export-investigation" }, { user: "test", now: () => "" });
    assertEquals(removed.effects, []);
    const approved = reduce(s, { ...snap, workspace: ws }, { kind: "action", name: "approve" }, { user: "test", now: () => "" });
    assertEquals(approved.effects[0]?.kind, "post", id);
  }
});

Deno.test("legacy supplemental targets render explicit missing-data destinations", async () => {
  const copy = structuredClone(ws), project = copy.projects[0], inv = project.investigations[0], fit = inv.fits[0];
  fit.frequency = null;
  const config = project.configs.find(c => c.version === inv.configVersion)!;
  for (const spec of config.catalog) spec.viewHints = ["frequency", "zoom:edges"];
  for (const m of inv.measurements) { m.input = []; m.inputRecorded = false; }
  for (const view of ["frequency", "zoom:edges"]) {
    const model = mainModel({ ...state(project.id, inv.id + "/fit-" + fit.n + "/" + view), ws: copy });
    assert(model.body.kind === "investigation");
    const body = model.body;
    const destination = body.rounds.flatMap(r => r.extras).find(c => c.id === body.target);
    assert(destination, view + " has an actual destination");
    assertStringIncludes(JSON.stringify(destination.blocks), "data recorded for this fit.");
  }
});

Deno.test("expanded measurement rows retain acquisition facts without substituting defaults", async () => {
  const copy = structuredClone(ws), project = copy.projects[0], inv = project.investigations[0], m = inv.measurements[0];
  const setting = project.configs.find(c => c.version === inv.configVersion)!.catalog.find(e => e.id === m.experiment)!.settings[0];
  m.settings = { [setting.name]: 7.25 };
  m.source = "operator <upload>"; m.uploadedAt = "2026-11-05T23:00:00Z";
  m.output[0] = NaN; m.sigmaEstimate = 0.123; m.sigmaSource = "declared";
  const model = mainModel({ ...state(project.id, inv.id + "/data/" + m.id), ws: copy });
  assert(model.body.kind === "investigation");
  const row = model.body.rounds.flatMap(r => r.data.rows ?? []).find(r => r.label === m.id)!;
  assert(row.open, "legacy selection expands its measurement");
  const facts = JSON.stringify(row.panels[0]);
  for (const text of ["7.25", "operator <upload>", m.uploadedAt, "Missing samples", "0.123", "Noise σ (declared)", "Fit #1"]) assertStringIncludes(facts, text);
  m.settings = {};
  const missing = mainModel({ ...state(project.id, inv.id), ws: copy });
  assert(missing.body.kind === "investigation");
  assertStringIncludes(JSON.stringify(missing.body.rounds[0].data.rows![0].panels[0]), "not recorded");
});

Deno.test("investigation cards preserve recorded fit assumptions, condition and validation error", () => {
  const copy = structuredClone(ws), project = copy.projects[0], inv = project.investigations[1], fit = inv.fits.at(-1)!;
  fit.variant = "sensor bias fitted"; fit.loss = "soft_l1";
  assert(fit.sensitivity);
  fit.sensitivity.condition = 321;
  assert(inv.validation.state === "passed" || inv.validation.state === "failed");
  inv.validation.worst = { param: "m", relative: .0123 };
  let model = mainModel({ ...state(project.id, inv.id), ws: copy });
  assert(model.body.kind === "investigation");
  let round = model.body.rounds.find(r => r.fit?.heading === "Fit #" + fit.n)!;
  assertStringIncludes(JSON.stringify(round.fit), "sensor bias fitted");
  assertStringIncludes(JSON.stringify(round.fit), "soft L1");
  assertStringIncludes(JSON.stringify(round.identifiability), "321");
  const validation = JSON.stringify(model.body.outcome.find(c => c.heading === "Validate"));
  assertStringIncludes(validation, "m ±1.2% (2σ relative)");
  assertStringIncludes(validation, inv.validation.measurement);
  fit.variant = "no sensor bias"; fit.loss = "linear"; fit.sensitivity = null;
  fit.identification = { identified: ["m"], nonIdentified: ["c", "k"], condition: 456 };
  model = mainModel({ ...state(project.id, inv.id), ws: copy });
  assert(model.body.kind === "investigation");
  round = model.body.rounds.find(r => r.fit?.heading === "Fit #" + fit.n)!;
  assertStringIncludes(JSON.stringify(round.fit), "no sensor bias");
  assertStringIncludes(JSON.stringify(round.fit), "least squares");
  assertStringIncludes(JSON.stringify(round.identifiability), "456");
  fit.identification.condition = null;
  inv.validation = { state: "summary", measurements: ["heldout@1"], chi2N: 1, threshold: 2, passed: true };
  model = mainModel({ ...state(project.id, inv.id), ws: copy });
  assert(model.body.kind === "investigation");
  assertStringIncludes(JSON.stringify(model.body.outcome), "heldout@1");
  assertStringIncludes(JSON.stringify(model.body.outcome), "not recorded");
});

Deno.test("finished summary states the recorded identification, and ± once the SDK records it", () => {
  const copy = structuredClone(ws), done = (i: (typeof ws.projects)[0]["investigations"][0]) => ["validated", "inconclusive"].includes(stateOf(i)) && i.fits.length > 0;
  const project = copy.projects.find(p => p.investigations.some(done))!, inv = project.investigations.find(done)!;
  const fit = inv.fits.at(-1)!, [a, b] = fit.free, c = project.configs.find(x => x.version === inv.configVersion)!;
  const text = () => JSON.stringify(mainModel({ ...state(project.id, inv.id), ws: copy }).body);
  fit.sensitivity = null;
  fit.identification = { identified: [a], nonIdentified: [b], condition: 3 };
  let t = text();
  assert(!t.includes("not recorded or unbounded"), "an identified parameter is never called unbounded");
  assertStringIncludes(t, "(identified; uncertainty not recorded)");
  assertStringIncludes(t, "(not identified)");
  fit.identification.marginal = { [a]: 0.0084 };
  t = text();
  assertStringIncludes(t, plusMinus(c, a, 0.0084));
  assert(!t.includes("(identified; uncertainty not recorded)"));
  assertStringIncludes(t, "(not identified)");
});

Deno.test("identifiability card and report list each parameter's recorded identification and ±", () => {
  const copy = structuredClone(ws), done = (i: (typeof ws.projects)[0]["investigations"][0]) => ["validated", "inconclusive"].includes(stateOf(i)) && i.fits.length > 0;
  const project = copy.projects.find(p => p.investigations.some(done))!, inv = project.investigations.find(done)!;
  const fit = inv.fits.at(-1)!, [a, b] = fit.free, c = project.configs.find(x => x.version === inv.configVersion)!;
  fit.sensitivity = null;
  fit.identification = { identified: [a], nonIdentified: [b], condition: 2.98, marginal: { [a]: 0.007 } };
  const body = JSON.stringify(mainModel({ ...state(project.id, inv.id), ws: copy }).body);
  const card = body.match(/"heading":"Identifiability".*?"heading":"Landscape"/)?.[0] ?? "";
  assertStringIncludes(card, `1 of ${fit.free.length} identified`);
  assertStringIncludes(card, plusMinus(c, a, 0.007));
  assertStringIncludes(card, "not identified");
  assert(!card.includes("Identified: "), "per-parameter rows replace the one-line list");
  const report = reportText({ source: "fixture", gseq: 7 } as Parameters<typeof reportText>[0], project, inv);
  assertStringIncludes(report, `Fit #${fit.n}:`);
  assertStringIncludes(report, `${plusMinus(c, a, 0.007)} (identified)`);
  assertStringIncludes(report, `- ${b}: not identified`);
  assertStringIncludes(report, "Condition 2.98");
  delete fit.identification.marginal;
  assertStringIncludes(reportText({ source: "fixture", gseq: 7 } as Parameters<typeof reportText>[0], project, inv), "(identified; uncertainty not recorded)");
});
