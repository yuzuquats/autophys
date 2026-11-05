/// <reference lib="deno.ns" />
/** The approval round trip through the controller, the store and the fixture Source. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { TreeNode } from "../ui/view-model.ts";
import { Controller, type Env, reduce } from "./controller.ts";
import { fixtures } from "./fixtures/source.ts";
import { Store } from "./store.ts";

const env: Env = { user: "james", now: () => "10:46" };
const settle = () => new Promise((r) => setTimeout(r, 0));
const find = (nodes: TreeNode[], id: string): TreeNode | undefined => {
  for (const n of nodes) { if (n.id === id) return n; const hit = n.children && find(n.children, id); if (hit) return hit; }
};

Deno.test("controller: edit, refused values, approve (posted as edited), withdraw, reject, restore", async () => {
  const src = fixtures();
  // Exercise a writable source using the in-memory transport; actual demo data is read-only.
  const live = { ...src, name: "daemon" as const, load: async () => ({ ...await src.load(), source: "daemon" as const }) };
  const store = new Store(live), ctl = new Controller(store, env);
  let redraws = 0;
  ctl.subscribe(() => redraws++);
  await store.start();
  await settle();
  assertEquals(store.applied.map((r) => r.gseq), [1], "the canned record was replayed");
  ctl.handle({ kind: "select", id: "bench-a" });
  const sel = ctl.selection;
  ctl.handle({ kind: "field", name: "amplitude", raw: "1.", commit: false });
  assert(ctl.selection === sel, "typing does not change the selection");
  ctl.handle({ kind: "field", name: "amplitude", raw: "1.5", commit: true });
  ctl.handle({ kind: "field", name: "rate", raw: "5000", commit: true });
  const fieldOf = (name: string) => (ctl.view().details.sections.find((x) => x.heading === "Experiment")!.blocks[0] as { fields: { name: string; value: string; invalid?: string }[] }).fields.find((f) => f.name === name)!;
  assertEquals([fieldOf("rate").value, fieldOf("rate").invalid], ["5000", "10 to 1000 Hz"]);
  ctl.handle({ kind: "field", name: "rate", raw: "200", commit: true });
  assertEquals(fieldOf("rate").invalid, "fixed at 100 Hz in this outlook", "the outlook has no rate axis");
  assertEquals(ctl.view().details.decision![0].disabled, true);
  ctl.handle({ kind: "action", name: "approve" });
  await settle();
  assertEquals(src.log.length, 1, "approve waits for the refused field");
  ctl.handle({ kind: "field", name: "rate", raw: "100", commit: true });
  ctl.handle({ kind: "action", name: "approve" });
  await settle();
  assertEquals(src.log.at(-1)!.payload, { project: "bench-oscillators", proposal: "p1", event: "edited", by: "james", at: "10:46", fields: { amplitude: 1.5 } });
  let v = ctl.view();
  assertEquals(v.details.status.text, "Approved by james · 10:46 · edited (was 2.00)");
  assertEquals([v.details.decision, v.details.actions!.map((a) => a.label)], [undefined, ["Withdraw approval", "Report"]]);
  const waiting = find(v.sidebar.nodes, "bench-a/data/sine_044@1")!;
  assertEquals([waiting.dim, waiting.trail], [true, { text: "awaiting" }]);
  assertEquals(find(v.sidebar.nodes, "bench-a")!.trail, { text: "waiting", tone: "muted" }, "the badge is gone");
  ctl.handle({ kind: "action", name: "withdraw" });
  await settle();
  assertEquals(find(ctl.view().sidebar.nodes, "bench-a")!.trail, { badge: "Approve", tone: "warn" });
  ctl.handle({ kind: "action", name: "reject" });
  await settle();
  v = ctl.view();
  assertEquals([find(v.sidebar.nodes, "bench-a/prop/p1")!.dim, v.details.actions!.map((a) => a.name)], [true, ["restore", "report"]]);
  ctl.handle({ kind: "action", name: "restore" });
  await settle();
  assertEquals(src.log.map((r) => r.payload.event), ["approved", "edited", "unapproved", "rejected", "restored"]);
  assertEquals(store.applied.length, 5, "each POST's record applied once, though it also streamed back");
  assert(redraws > 5);
  store.close();
});

Deno.test("controller: project switch keeps each project's selection; export and report are downloads", async () => {
  const store = new Store(fixtures()), ctl = new Controller(store, env);
  const files: string[] = [];
  ctl.shell = { download: (name, _type, data) => files.push(`${name}:${data.length > 0}`), picked: () => {} };
  await store.start();
  ctl.handle({ kind: "switch", value: "lab-heaters" });
  assertEquals(ctl.view().sidebar.selectedId, "heater-1");
  ctl.handle({ kind: "select", id: "heater-1/validate" });
  ctl.handle({ kind: "switch", value: "bench-oscillators" });
  ctl.handle({ kind: "switch", value: "lab-heaters" });
  assertEquals(ctl.view().sidebar.selectedId, "heater-1/validate");
  const sel = ctl.selection!;
  assert(reduce(sel, store.snapshot()!, { kind: "switch", value: "nope" }, env).selection === sel);
  ctl.handle({ kind: "action", name: "export" });
  ctl.handle({ kind: "select", id: "heater-1" });
  ctl.handle({ kind: "action", name: "report" });
  assertEquals(files, ["autophys-fixture.json:true", "autophys-heater-1-report.md:true"]);
  const doc = ctl.exportDocument() as { workspace: { projects: { investigations: { measurements: { output: number[] }[] }[] }[] } };
  assert(Number.isNaN(doc.workspace.projects[2].investigations[0].measurements[1].output[101]), "missing sample (null once serialized)");
  store.close();
});
