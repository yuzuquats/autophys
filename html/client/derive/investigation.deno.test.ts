import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fixtures, replay } from "../fixtures/source.ts";
import { initialSelection, reduce } from "../controller.ts";
import { investigationRounds, investigationAnchor } from "./rounds.ts";
import { parseSel } from "./shared.ts";
import { mainModel } from "./main.ts";
import { detailsModel } from "./details.ts";

const source = fixtures(), snapshot = await source.load();
const ws = replay(snapshot.workspace, source.log), project = ws.projects[0];
const state = (id: string) => ({ ...initialSelection(ws), ws, projectId: project.id, selected: { [project.id]: id } });

Deno.test("investigation rounds: one fit through its proposal decision, two rounds and repeated decisions", () => {
  const one = structuredClone(project.investigations[0]);
  assertEquals(investigationRounds(one).map(r => [r.n, r.fits.map(f => f.n), r.proposals.map(p => p.id)]), [[1, [1], ["p1"]]]);
  const two = structuredClone(project.investigations[1]);
  assertEquals(investigationRounds(two).map(r => r.fits.map(f => f.n)), [[1], [2]]);
  one.proposals.push({ ...one.proposals[0], id: "rerank", status: "rejected" });
  assertEquals(investigationRounds(one).map(r => r.proposals.map(p => p.id)), [["p1", "rerank"]]);
  // Multiple optimization runs before a decision belong to the same reasoning interval.
  one.fits.unshift({ ...one.fits[0], n: 0 });
  assertEquals(investigationRounds(one)[0].fits.map(f => f.n), [0, 1]);
});

Deno.test("investigation page: running opens latest round, validated leads with verdict and collapses history", () => {
  const running = mainModel({ ...state("cell-a"), projectId: "cell-pulse-tests", selected: { "cell-pulse-tests": "cell-a" } });
  assert(running.body.kind === "investigation");
  assertEquals(running.body.rounds[0].heading, "Round 1");
  assert(running.body.rounds[0].rows.flat().some(c => c.heading === "Fit #2"));
  assertEquals(running.body.rounds.map(r => r.open), [true]);
  assertEquals(running.body.outcome, []);
  const validated = mainModel(state("bench-b"));
  assert(validated.body.kind === "investigation");
  assertEquals(validated.body.rounds.map(r => [r.heading, r.open]), [["Round 2", true], ["Round 1", false]]);
  assertStringIncludes(JSON.stringify(validated.body.summary), "Validated");
  assertEquals(validated.body.outcome.map(c => c.heading), ["Validate", "Ground truth"]);
  assertEquals(detailsModel(state("bench-b/fit-1")).sections.map(s => s.heading), ["Result", "Budget used", "Data"]);
});

Deno.test("old investigation addresses: each resolves to an actual anchor on the same page", () => {
  const addresses = ["bench-a", "bench-a/data", "bench-a/data/free_response@1", "bench-a/fit-1", "bench-a/fit-1/fit", "bench-a/fit-1/residuals", "bench-a/fit-1/landscape", "bench-a/fit-1/envelope", "bench-a/sens", "bench-a/prop/p1", "bench-a/validate", "bench-b/fit-1", "bench-b/fit-2/frequency", "bench-b/truth", "bench-b/validate"];
  for (const address of addresses) {
    const selection = parseSel(project, address);
    assert(selection && selection.kind !== "config", address);
    const model = mainModel(state(address));
    assert(model.body.kind === "investigation");
    assertEquals(model.body.pageId, selection.inv.id);
    assertEquals(model.body.anchor, investigationAnchor(selection));
    const cards = [model.body.summary, ...model.body.outcome, ...model.body.rounds.flatMap(r => r.rows.flat())];
    assert(cards.some(c => c.id === model.body.anchor || c.aliases?.includes(model.body.anchor)), address);
    if (address.startsWith("bench-a")) assertEquals(detailsModel(state(address)).decision?.map(a => a.name), ["approve", "reject"]);
  }
});

Deno.test("investigation decisions: edits and approval work from investigation, fit and data selections", () => {
  const env = { user: "operator", now: () => "now" };
  const snap = { ...snapshot, workspace: ws, source: "daemon" as const };
  for (const address of ["bench-a", "bench-a/fit-1", "bench-a/data/free_response@1"]) {
    const s = state(address);
    const edit = reduce(s, snap, { kind: "field", name: "amplitude", raw: "1.5", commit: true }, env);
    assertEquals(Object.values(edit.selection.edits), [1.5]);
    const approve = reduce(edit.selection, snap, { kind: "action", name: "approve" }, env);
    assertEquals(approve.effects.length, 1);
    const effect = approve.effects[0];
    assert(effect.kind === "post");
    assertEquals(effect.body, { event: "edited", by: "operator", at: "now", fields: { amplitude: 1.5 } });
  }
});
