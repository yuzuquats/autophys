import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { Snapshot, Source } from "./api.ts";
import { Controller } from "./controller.ts";
import { fixtures } from "./fixtures/source.ts";
import { Store } from "./store.ts";

const fixture = await fixtures([]).load();
const env = { user: "operator", now: () => "12:34", daemonOrigin: "https://daemon.example" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function memory(initial: Snapshot) {
  let snapshot = initial, failure = false, stops = 0;
  const cursors: (number | string)[] = [];
  const source: Source = {
    name: "daemon", load: () => failure ? Promise.reject(new Error("offline")) : Promise.resolve(snapshot),
    stream: (cursor) => { cursors.push(cursor); return () => { stops++; }; },
    post: () => Promise.reject(new Error("unexpected post")),
  };
  return { source, cursors, get stops() { return stops; }, set(next: Snapshot) { snapshot = next; }, fail(value: boolean) { failure = value; } };
}
const pending = { code: "ABCD1234", device: "lab-pc", client: "autophys-cli", expires: "2030-01-01T00:00:00Z" };
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
function paired(initial: Snapshot) {
  const mem = memory(initial), decided: [string, boolean][] = [];
  let pairings: typeof pending[] = [], refuse = false;
  const source: Source = { ...mem.source, pairings: {
    list: () => Promise.resolve(pairings),
    decide: (code, approve) => { decided.push([code, approve]); if (refuse) return Promise.reject(new Error("pairing expired")); pairings = []; return Promise.resolve(); },
  } };
  return { mem, source, decided, request(next: typeof pending[]) { pairings = next; }, refuse(value: boolean) { refuse = value; } };
}
const setupOf = (ctl: Controller) => { const body = ctl.view().main.body; assert(body.kind === "project-setup"); return body; };
const current = (ctl: Controller) => setupOf(ctl).steps.findIndex((s) => s.current) + 1;

Deno.test("setup controller: the SDK stepper approves its device in place and opens the first investigation", async () => {
  const dev = paired(fixture), store = new Store(dev.source), ctl = new Controller(store, env);
  let picks = 0;
  ctl.shell = { download: () => {}, picked: () => { picks++; } };
  await store.start();
  ctl.handle({ kind: "action", name: "new-project" });
  assertEquals(current(ctl), 1);
  assertEquals(ctl.view().main.actions.map((a) => a.name), ["cancel-project"]);
  assertEquals(ctl.view().sidebar.creatingProject, true);
  ctl.handle({ kind: "action", name: "setup-lang:rust" });
  ctl.handle({ kind: "action", name: "setup-lang:fortran" });
  assertStringIncludes(setupOf(ctl).steps[0].command!.text, "--lang rust");
  ctl.handle({ kind: "action", name: "setup-next" });
  assertEquals(current(ctl), 2);
  assertEquals(setupOf(ctl).steps[1].command!.text, "autophys connect https://daemon.example --name my-device");
  assertEquals(setupOf(ctl).steps[1].waiting, "Waiting for a device…");
  dev.request([pending]); await store.refreshPairings();
  assertEquals(setupOf(ctl).steps[1].blocks.map((b) => b.kind), ["pairing"]);
  ctl.handle({ kind: "action", name: "pair-approve:ABCD1234" }); await settle();
  assertEquals(dev.decided, [["ABCD1234", true]]);
  assertEquals(current(ctl), 3);
  assertStringIncludes(setupOf(ctl).steps[1].description, "lab-pc is connected");
  // The host's polling re-reads the workspace while New project is open; the program has run.
  const [first, ...rest] = fixture.workspace.projects;
  const inv = { ...first.investigations[0], id: "sdk-run-1" };
  dev.mem.set({ ...fixture, workspace: { ...fixture.workspace, projects: [...rest, first, { id: "fresh", name: "my-project", configs: first.configs, investigations: [inv] }] } });
  const before = picks;
  await ctl.refresh();
  assertEquals(ctl.view().main.body.kind === "project-setup", false);
  assertEquals(ctl.view().sidebar.creatingProject, false);
  assertEquals(ctl.selection!.projectId, "fresh");
  assertEquals(ctl.selection!.selected.fresh, "sdk-run-1");
  assertEquals(ctl.view().sidebar.selectedId, "sdk-run-1");
  assertEquals(picks, before + 1);
  // Without New project open, polling does not re-read a healthy workspace.
  const loads = dev.mem.cursors.length;
  await ctl.refresh();
  assertEquals(dev.mem.cursors.length, loads);
  store.close();
});

Deno.test("setup controller: denial, refusal and offline keep the device step; Back and Cancel restore", async () => {
  const dev = paired(fixture), store = new Store(dev.source), ctl = new Controller(store, env);
  await store.start();
  ctl.handle({ kind: "select", id: "heater-1/validate" });
  const previous = ctl.view().sidebar.selectedId;
  ctl.handle({ kind: "action", name: "new-project" });
  ctl.handle({ kind: "action", name: "cancel-project" });
  assertEquals(ctl.view().sidebar.selectedId, previous);
  ctl.handle({ kind: "action", name: "new-project" });
  ctl.handle({ kind: "action", name: "setup-back" });
  assertEquals(current(ctl), 1, "Back does nothing on the first step");
  ctl.handle({ kind: "action", name: "setup-next" });
  dev.request([pending]); await store.refreshPairings();
  ctl.handle({ kind: "action", name: "pair-deny:ABCD1234" }); await settle();
  assertEquals(current(ctl), 2, "a denied device leaves the stepper waiting");
  assertEquals(setupOf(ctl).steps[1].waiting, "Waiting for a device…");
  dev.request([pending]); await store.refreshPairings(); dev.refuse(true);
  ctl.handle({ kind: "action", name: "pair-approve:ABCD1234" }); await settle();
  assertEquals(current(ctl), 2);
  assertStringIncludes(setupOf(ctl).notice!, "pairing expired");
  dev.refuse(false);
  store.error = "offline";
  const card = setupOf(ctl).steps[1].blocks[0];
  assert(card.kind === "pairing" && card.decision.every((a) => a.disabled), "approvals pause while disconnected");
  ctl.handle({ kind: "action", name: "pair-approve:ABCD1234" }); await settle();
  assertEquals(dev.decided.length, 2, "no decision is sent while disconnected");
  store.error = null;
  ctl.handle({ kind: "action", name: "setup-back" });
  assertEquals(current(ctl), 1);
  ctl.handle({ kind: "select", id: "heater-1/validate" });
  assertEquals(ctl.view().main.body.kind === "project-setup", false, "picking a record closes New project");
  store.close();
});

Deno.test("setup controller: read-only accounts cannot advance or decide devices from the stepper", async () => {
  const dev = paired(fixture), store = new Store(dev.source);
  const capabilities = { read: true, createProject: false, startInvestigation: false, approveProposal: false, manageDevices: false };
  const ctl = new Controller(store, { ...env, capabilities });
  await store.start();
  ctl.handle({ kind: "action", name: "new-project" });
  assertEquals(ctl.view().main.body.kind === "project-setup", false);
  const writer = new Controller(store, { ...env, capabilities: { ...capabilities, createProject: true } });
  writer.handle({ kind: "action", name: "new-project" });
  writer.handle({ kind: "action", name: "setup-next" });
  dev.request([pending]); await store.refreshPairings();
  const card = setupOf(writer).steps[1].blocks[0];
  assert(card.kind === "pairing" && card.decision.every((a) => a.disabled && a.title));
  writer.handle({ kind: "action", name: "pair-approve:ABCD1234" }); await settle();
  assertEquals(dev.decided, []);
  store.close();
});

Deno.test("workspace refresh: resumes the snapshot cursor, retains records on failure, recovers, and never reopens after close", async () => {
  const initial = { ...fixture, gseq: "prj-a:4" }, mem = memory(initial), store = new Store(mem.source);
  await store.start();
  mem.fail(true); await store.refreshWorkspace();
  assertEquals(store.snapshot(), initial);
  assertEquals(mem.cursors, ["prj-a:4", "prj-a:4"]);
  assertStringIncludes(store.error!, "offline");
  mem.fail(false); mem.set({ ...initial, gseq: "prj-a:6,prj-b:1" }); await store.refreshWorkspace();
  assertEquals(mem.cursors.at(-1), "prj-a:6,prj-b:1");
  assertEquals(store.error, null);
  store.close(); const streams = mem.cursors.length;
  await store.refreshWorkspace(); assertEquals(mem.cursors.length, streams);
});

Deno.test("workspace refresh: concurrent pairing approval cannot resurrect the old pending list", async () => {
  const pending = { code: "code", device: "device", client: "sdk", expires: "2030-01-01" };
  let resolve!: (snap: Snapshot) => void, loads = 0;
  let pairings = [pending];
  const source: Source = {
    name: "daemon", load: () => ++loads === 1 ? Promise.resolve({ ...fixture, pairings }) : new Promise(r => { resolve = r; }),
    stream: () => () => {}, post: () => Promise.reject(new Error("unexpected post")),
    pairings: { list: () => Promise.resolve(pairings), decide: () => { pairings = []; return Promise.resolve(); } },
  };
  const store = new Store(source);
  await store.start();
  const refresh = store.refreshWorkspace();
  assertEquals(store.refreshWorkspace(), refresh);
  await store.decidePairing("code", true);
  resolve({ ...fixture, pairings: [pending] });
  await refresh;
  assertEquals(loads, 2);
  assertEquals(store.snapshot()!.pairings, []);
  store.close();
});

Deno.test("workspace refresh: closing during a pending read neither publishes nor reopens a stream", async () => {
  let resolve!: (snap: Snapshot) => void, loads = 0, streams = 0, notifications = 0;
  const source: Source = {
    name: "daemon", load: () => ++loads === 1 ? Promise.resolve(fixture) : new Promise(r => { resolve = r; }),
    stream: () => { streams++; return () => {}; }, post: () => Promise.reject(new Error("unexpected post")),
  };
  const store = new Store(source);
  await store.start();
  const refresh = store.refreshWorkspace();
  store.subscribe(() => { notifications++; });
  store.close();
  assertEquals(store.snapshot(), null, "closing drops the previous account's data");
  assertEquals(notifications, 1, "closing publishes the cleared state once");
  resolve({ ...fixture, gseq: "closed:42" });
  await refresh;
  assertEquals(store.snapshot(), null, "the late read cannot restore private data");
  assertEquals(streams, 1);
  assertEquals(notifications, 1, "the late read cannot publish");
});
