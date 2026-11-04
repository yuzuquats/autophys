import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { beginSetup, setupBody, setupRequest } from "./project-setup.ts";
import { fixtures } from "../fixtures/source.ts";
import { Controller, initialSelection, reduce } from "../controller.ts";
import { sidebarModel } from "./tree.ts";
import type { Project } from "../domain.ts";

const snap = await fixtures([]).load();
const empty = { ...snap, workspace: { ...snap.workspace, projects: [] } };
const env = { user: "operator", now: () => "12:34" };

Deno.test("project setup: a browser draft validates without pairing and explains simulated execution", () => {
  const session = beginSetup(empty);
  const body = setupBody(session, empty, "origin");
  assertEquals(body.steps.length, 3);
  assertEquals(body.steps[0].current, true);
  assertStringIncludes(body.description, "No SDK");
  assertEquals(setupRequest(session).model, "thermal_rc");
  session.draft.duration = "";
  let message = "";
  try { setupRequest(session); } catch (e) { message = String(e); }
  assertStringIncludes(message, "duration");
  session.draft.duration = "600";
  session.draft.c = "1e999";
  try { setupRequest(session); } catch (e) { message = String(e); }
  assertStringIncludes(message, "C:");
});

Deno.test("workspace tree: project roots, devices, short approval trails and missing configuration", () => {
  const ws = { ...snap.workspace, projects: [...snap.workspace.projects, { id: "unset", name: "oscillator", configs: [], investigations: [] }] };
  const side = sidebarModel({ ...initialSelection(ws), ws, pairings: [{ code: "code", device: "d", client: "c", expires: "2030-01-01" }] });
  assertEquals(side.switcher.kind, "none");
  assertEquals(side.nodes.map((n) => n.id), ws.projects.map((p) => `project:${p.id}`));
  assertEquals(side.pinned.icon, "device");
  assertEquals(side.pinned.trail?.tone, "danger");
  assertEquals(sidebarModel({ ...initialSelection(ws), ws, pairings: [] }).pinned.trail, undefined);
  assertEquals(side.pinned.trail?.badge, "1");
  assertEquals(side.nodes[0].children![0].label, "Configuration");
  const inv = side.nodes[0].children![1];
  assertStringIncludes(inv.label, "Investigation 1");
  assertEquals(inv.trail, { badge: "Approve", tone: "warn" });
  assertEquals(side.nodes[0].trail, { text: "2", tone: "muted" });
  assertEquals(side.nodes.at(-1)!.children![0].trail?.badge, "not set");
  assertStringIncludes(side.nodes.at(-1)!.children![1].label, "wb.investigate");
});

Deno.test("workspace tree: selecting and collapsing another project resolves its owner", () => {
  const sel = initialSelection(snap.workspace), target = snap.workspace.projects[2];
  const id = target.investigations[0].id;
  const next = reduce(sel, snap, { kind: "select", id }, env).selection;
  assertEquals(next.projectId, target.id);
  assertEquals(next.selected[target.id], id);
  assert(next.expanded[target.id].includes(`project:${target.id}`));
  const closed = reduce(sel, snap, { kind: "toggle", id: `project:${target.id}`, open: false }, env).selection;
  assert(!closed.expanded[target.id].includes(`project:${target.id}`));
  assertEquals(closed.expanded[sel.projectId], sel.expanded[sel.projectId]);
});
