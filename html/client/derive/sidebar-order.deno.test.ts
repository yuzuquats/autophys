import { assertEquals } from "jsr:@std/assert@1";
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
  assertEquals(previous.children!.map(n => n.label), ["Data", "Fit #1", "Sensitivity", "Sine 0.44 Hz", "Validate"]);
});
