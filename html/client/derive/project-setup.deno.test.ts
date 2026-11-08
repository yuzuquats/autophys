import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { beginSetup, connectCommand, createCommand, setupArrival, setupBody } from "./project-setup.ts";
import { fixtures } from "../fixtures/source.ts";
import { Controller, initialSelection, reduce } from "../controller.ts";
import { sidebarModel } from "./tree.ts";
import type { Project } from "../domain.ts";

const snap = await fixtures([]).load();
const env = { user: "operator", now: () => "12:34" };

const pending = { code: "ABCD1234", device: "lab-pc", client: "autophys-cli", expires: "2030-01-01T00:00:00Z" };

Deno.test("project setup: three SDK steps, the language picks both commands' project, and nothing points at a built-in simulator", () => {
  const session = beginSetup(snap);
  let body = setupBody(session, snap, "https://daemon.example");
  assertEquals(body.title, "New project");
  assertEquals(body.description, "Bring your own simulator. It runs on your machine through the SDK, and this workbench shows and approves its investigations.");
  assertEquals(body.steps.map((s) => s.title), ["Create the project", "Connect it to this workbench", "Run your first investigation"]);
  assertEquals(body.steps.map((s) => s.current), [true, false, false]);
  assertEquals(body.steps[0].choice!.options.map((o) => [o.name, o.pressed]), [["setup-lang:python", true], ["setup-lang:rust", false]]);
  assertEquals(body.steps[0].command!.text, "autophys new my-project --lang python\ncd my-project");
  assertEquals(body.steps[0].actions, [{ name: "setup-next", label: "I've done this", variant: "primary" }]);
  assert(!JSON.stringify(body).match(/thermal|No SDK/i));
  session.language = "rust";
  body = setupBody(session, snap, "https://daemon.example");
  assertEquals(body.steps[0].command!.text, createCommand("rust"));
  assertStringIncludes(body.steps[0].command!.text, "--lang rust");
  assertEquals(body.steps[0].choice!.options.map((o) => o.pressed), [false, true]);
  assertEquals(body.steps[1].command, undefined, "only the current step carries its command");
});

Deno.test("project setup: step 2 connects to the page's own origin, waits for a device, then shows its pairing card", () => {
  const session = { ...beginSetup(snap), step: 2 as const };
  let body = setupBody(session, { ...snap, pairings: [] }, "https://daemon.example:8443");
  assertEquals(body.steps[0].done, true);
  assertEquals(body.steps[1].command!.text, "autophys connect https://daemon.example:8443 --name my-device");
  assertEquals(connectCommand(""), "autophys connect URL --name my-device");
  assertEquals(body.steps[1].waiting, "Waiting for a device…");
  assertEquals(body.steps[1].blocks, []);
  assertEquals(body.steps[1].actions.map((a) => a.name), ["setup-back"]);
  body = setupBody(session, { ...snap, pairings: [pending] }, "https://daemon.example:8443");
  assertEquals(body.steps[1].waiting, undefined);
  const card = body.steps[1].blocks[0];
  assert(card.kind === "pairing");
  assertEquals([card.device, card.code, card.decision.map((a) => a.name)], ["lab-pc", "ABCD1234", ["pair-approve:ABCD1234", "pair-deny:ABCD1234"]]);
});

Deno.test("project setup: step 3 waits for an investigation; a new project's first one completes it from any step", () => {
  const session = beginSetup(snap);
  const fresh: Project = { id: "fresh", name: "battery fit", configs: [], investigations: [] };
  const registered = { ...snap, workspace: { ...snap.workspace, projects: [...snap.workspace.projects, fresh] } };
  assertEquals(setupArrival(session, registered), null, "a registered project without an investigation is not yet the arrival");
  session.step = 3;
  assertEquals(setupBody(session, registered, "").steps[2].waiting, "battery fit is registered. Waiting for its first investigation…");
  assertEquals(setupBody(session, snap, "").steps[2].waiting, "Waiting for the first investigation…");
  const inv = { ...snap.workspace.projects[0].investigations[0], id: "fresh-inv" };
  const arrived = { ...snap, workspace: { ...snap.workspace, projects: [...snap.workspace.projects, { ...fresh, investigations: [inv] }] } };
  assertEquals(setupArrival({ ...session, step: 1 }, arrived), { projectId: "fresh", id: "fresh-inv" });
  // A new investigation in a project that already existed counts only once a device is connected.
  const [first, ...rest] = snap.workspace.projects;
  const another = { ...snap, workspace: { ...snap.workspace, projects: [{ ...first, investigations: [inv, ...first.investigations] }, ...rest] } };
  assertEquals(setupArrival({ ...session, step: 2 }, another), null);
  assertEquals(setupArrival(session, another), { projectId: first.id, id: "fresh-inv" });
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
