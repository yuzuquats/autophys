import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { initialSelection, reduce } from "../controller.ts";
import { fixtures, replay } from "../fixtures/source.ts";
import { detailsModel } from "./details.ts";
import { mainModel } from "./main.ts";
import { investigationRounds } from "./rounds.ts";
import { parseSel } from "./shared.ts";

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
  const text = JSON.stringify(body);
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
    const removed = reduce(s, { ...snap, workspace: ws }, { kind: "action", name: "export-investigation" }, { user: "test", now: () => "" });
    assertEquals(removed.effects, []);
    const approved = reduce(s, { ...snap, workspace: ws }, { kind: "action", name: "approve" }, { user: "test", now: () => "" });
    assertEquals(approved.effects[0]?.kind, "post", id);
  }
});
