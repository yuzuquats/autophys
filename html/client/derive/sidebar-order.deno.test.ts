import { assert, assertEquals } from "jsr:@std/assert@1";
import { mainModel } from "./main.ts";
import { sidebarModel } from "./tree.ts";
import { initialSelection } from "../controller.ts";
import { fixtures } from "../fixtures/source.ts";

Deno.test("sidebar: project counts and newest-first investigations preserve step trails", async () => {
  const { workspace: ws } = await fixtures([]).load();
  const project = ws.projects[0];
  project.investigations[0].updated = "2026-11-03T10:00:00Z";
  project.investigations[1].updated = "2026-11-04T10:00:00Z";
  const model = sidebarModel({ ...initialSelection(ws), ws });
  assertEquals(model.section, { label: "Projects", count: String(ws.projects.length) });
  assertEquals(model.nodes[0].trail, { text: "2", tone: "muted" });
  const [configuration, newest, previous] = model.nodes[0].children!;
  assertEquals(configuration.label, "Configuration");
  assertEquals(configuration.trail, { text: "v2" });
  assertEquals([newest.id, previous.id], [project.investigations[1].id, project.investigations[0].id]);
  assertEquals(previous.trail, { badge: "Approve", tone: "warn" });
  assertEquals(previous.children!.map(n => n.label), ["Data", "Fit #1", "Sine 0.44 Hz"]);
});

Deno.test("sidebar: scientific records retain identity while diagnostics stay in the page", async () => {
  const { workspace: ws } = await fixtures([]).load();
  for (const project of ws.projects) {
    const model = sidebarModel({ ...initialSelection(ws), ws, projectId: project.id });
    const root = model.nodes.find(n => n.id === `project:${project.id}`)!;
    for (const inv of project.investigations) {
      const nodes = root.children!.find(n => n.id === inv.id)!.children!;
      assertEquals(nodes.map(n => n.id), [inv.id + "/data", ...inv.fits.map(f => `${inv.id}/fit-${f.n}`), ...inv.proposals.map(p => `${inv.id}/prop/${p.id}`)]);
      for (const fit of inv.fits) assertEquals(nodes.find(n => n.id === `${inv.id}/fit-${fit.n}`)!.children, null);
      for (const m of inv.measurements) assert(nodes[0].children!.some(n => n.id === `${inv.id}/data/${m.id}`));
    }
  }
});

Deno.test("sidebar: legacy diagnostic selections highlight a real record and retain the main target", async () => {
  const { workspace: ws } = await fixtures([]).load();
  for (const [id, selected, target] of [
    ["bench-b/fit-1/landscape", "bench-b/fit-1", "round-1-landscape"],
    ["bench-b/fit-1/residuals", "bench-b/fit-1", "round-1-fit"],
    ["bench-b/sens", "bench-b/fit-2", "round-2-identifiability"],
    ["bench-b/validate", "bench-b", "validate"],
    ["bench-b/truth", "bench-b", "truth"],
    ["bench-b/prop/p1", "bench-b/prop/p1", "round-1-proposal-p1"],
  ]) {
    const state = { ...initialSelection(ws), ws, projectId: "bench-oscillators", selected: { "bench-oscillators": id } };
    assertEquals(sidebarModel(state).selectedId, selected);
    const body = mainModel(state).body;
    assert(body.kind === "investigation");
    assert(body.target.endsWith(target));
  }
});
