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
Deno.test("setup controller: browser creates a project, starts its daemon run, and cancellation restores selection", async () => {
  const mem = memory(fixture);
  let creates = 0, starts = 0;
  const source: Source = { ...mem.source, projects: {
    create: (draft) => { creates++; assertEquals(draft.name, "Browser project"); return Promise.resolve({ project_id: "new", config_version: "v" }); },
    start: (id, version) => { starts++; assertEquals([id, version], ["new", "v"]); return Promise.resolve({ id: "inv-new" }); },
  } };
  const store = new Store(source), ctl = new Controller(store, env);
  await store.start();
  ctl.handle({ kind: "select", id: "heater-1/validate" });
  const previous = ctl.view().sidebar.selectedId;
  ctl.handle({ kind: "action", name: "new-project" });
  ctl.handle({ kind: "action", name: "cancel-project" });
  assertEquals(ctl.view().sidebar.selectedId, previous);
  ctl.handle({ kind: "action", name: "new-project" });
  ctl.handle({ kind: "field", name: "setup:name", raw: "Browser project", commit: false });
  ctl.handle({ kind: "action", name: "setup-next" });
  ctl.handle({ kind: "action", name: "setup-create" });
  ctl.handle({ kind: "action", name: "setup-create" });
  await tick();
  assertEquals(creates, 1);
  const body = ctl.view().main.body; assert(body.kind === "project-setup");
  assertEquals(body.steps[2].current, true);
  ctl.handle({ kind: "action", name: "setup-start" });
  await tick();
  assertEquals(starts, 1);
  assertEquals(ctl.selection!.selected.new, "inv-new");
  assertEquals(ctl.view().sidebar.creatingProject, false);
  store.close();
});

Deno.test("setup controller: invalid, offline and refused writes preserve the draft and are retryable", async () => {
  let refuse = true, creates = 0;
  const mem = memory(fixture);
  const source: Source = { ...mem.source, projects: {
    create: () => { creates++; return refuse ? Promise.reject(new Error("name already exists")) : Promise.resolve({ project_id: "new", config_version: "v" }); },
    start: () => Promise.resolve({ id: "run" }),
  } };
  const store = new Store(source), ctl = new Controller(store, env);
  await store.start(); ctl.handle({ kind: "action", name: "new-project" });
  ctl.handle({ kind: "action", name: "setup-next" });
  store.error = "offline";
  ctl.handle({ kind: "action", name: "setup-create" });
  assertEquals(creates, 0);
  store.error = null;
  ctl.handle({ kind: "field", name: "setup:c", raw: "", commit: false });
  ctl.handle({ kind: "action", name: "setup-create" });
  assertEquals(creates, 0);
  ctl.handle({ kind: "field", name: "setup:c", raw: "400", commit: false });
  ctl.handle({ kind: "action", name: "setup-create" }); await tick();
  let body = ctl.view().main.body; assert(body.kind === "project-setup");
  assertStringIncludes(body.notice!, "name already exists");
  assertEquals(body.steps[1].fields[0].value, "400");
  refuse = false;
  ctl.handle({ kind: "action", name: "setup-create" }); await tick();
  body = ctl.view().main.body; assert(body.kind === "project-setup");
  assertEquals(body.steps[2].current, true);
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
