import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { connectionFailure, derive } from "./index.ts";
import { initialSelection, Controller } from "../controller.ts";
import { fixtures } from "../fixtures/source.ts";
import { Store } from "../store.ts";

Deno.test("connection: only Main owns the failure; loaded tree, viewer and Details survive", async () => {
  const snapshot = await fixtures([]).load();
  const view = derive(snapshot, initialSelection(snapshot.workspace));
  const failed = connectionFailure(view, "Disconnected", true);
  assertEquals(failed.sidebar, view.sidebar);
  assertEquals(failed.main.body, view.main.body);
  assertEquals(failed.details, view.details);
  assertStringIncludes(failed.main.connectionError!, "stale records");
  assertEquals((JSON.stringify(failed).match(/Disconnected/g) ?? []).length, 1);
  const firstLoad = connectionFailure(derive(null, initialSelection(snapshot.workspace)), "Disconnected", false);
  assertEquals(firstLoad.sidebar.notice, undefined);
  assertEquals(firstLoad.sidebar.switcher.kind, "unavailable");
  assertEquals(firstLoad.main.body.kind, "unavailable");
  assertEquals(firstLoad.details.status.text, "No records loaded");
  assertEquals((JSON.stringify(firstLoad).match(/Disconnected/g) ?? []).length, 1);
});

Deno.test("connection: controller retains Main notice, pauses approvals and clears it on recovery", async () => {
  const source = fixtures([]);
  const live = { ...source, name: "daemon" as const, load: async () => ({ ...await source.load(), source: "daemon" as const }) };
  const store = new Store(live), ctl = new Controller(store, { user: "test", now: () => "10:00" });
  try {
    await store.start();
    ctl.handle({ kind: "select", id: "bench-a/prop/p1" });
    const loaded = ctl.view();
    assert(loaded.details.decision?.length);
    store.error = "Disconnected";
    const failed = ctl.view();
    assertStringIncludes(failed.main.connectionError!, "Disconnected");
    assertEquals(failed.main.body, loaded.main.body);
    assertEquals(failed.sidebar.nodes, loaded.sidebar.nodes);
    assertEquals(failed.details.title, loaded.details.title);
    assert(failed.details.decision!.every(a => a.disabled));
    assert(!("connection" in failed.sidebar));
    store.error = null;
    assertEquals(ctl.view().main.connectionError, undefined);
    assert(ctl.view().details.decision!.every(a => !a.disabled));
  } finally { store.close(); }
});
