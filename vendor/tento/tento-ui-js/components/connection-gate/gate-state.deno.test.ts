import { assertEquals } from "jsr:@std/assert";

import { ConnectionGate } from "./gate-state.ts";

function model(patch: Partial<ConnectionGate.Model>): ConnectionGate.Model {
  return { ...ConnectionGate.UNLOADED, loaded: true, ...patch };
}

Deno.test("nothing is offered before the server has answered", () => {
  assertEquals(ConnectionGate.controls(ConnectionGate.UNLOADED), {
    fields: false,
    test: false,
    save: false,
    enable: false,
    disable: false,
    refresh: false,
  });
  assertEquals(ConnectionGate.enableReason(ConnectionGate.UNLOADED), "loading");
});

Deno.test("nothing is offered while a request is in flight", () => {
  const busy = model({ busy: true, configured: true, enabled: true });
  assertEquals(ConnectionGate.controls(busy), {
    fields: false,
    test: false,
    save: false,
    enable: false,
    disable: false,
    refresh: false,
  });
});

Deno.test("an unconfigured panel can be edited and tested, not enabled", () => {
  const fresh = model({});
  const controls = ConnectionGate.controls(fresh);
  assertEquals(controls.fields, true);
  assertEquals(controls.test, true);
  assertEquals(controls.refresh, true);
  assertEquals(controls.save, false, "nothing has changed yet");
  assertEquals(controls.enable, false);
  assertEquals(ConnectionGate.enableReason(fresh), "unconfigured");
  assertEquals(controls.disable, false);
  assertEquals(ConnectionGate.disableReason(fresh), "already-stopped");
});

Deno.test("unsaved edits withhold enable and offer save", () => {
  const dirty = model({ configured: true, dirty: true });
  const controls = ConnectionGate.controls(dirty);
  assertEquals(controls.save, true);
  assertEquals(
    controls.enable,
    false,
    "enable verifies what the server holds, not what is typed",
  );
  assertEquals(ConnectionGate.enableReason(dirty), "unsaved");
});

Deno.test("saved and stopped is the one state where enable is offered", () => {
  const saved = model({ configured: true });
  const controls = ConnectionGate.controls(saved);
  assertEquals(controls.enable, true);
  assertEquals(ConnectionGate.enableReason(saved), null);
  assertEquals(controls.save, false);
});

Deno.test("a running gate is frozen except for stopping it", () => {
  const running = model({ configured: true, enabled: true, active: true });
  assertEquals(ConnectionGate.controls(running), {
    fields: false,
    test: true,
    save: false,
    enable: false,
    disable: true,
    refresh: true,
  });
  assertEquals(ConnectionGate.enableReason(running), "running");
});

Deno.test("enabled-but-stopped still offers the stop, so the intent can be cleared", () => {
  const wanted = model({ configured: true, enabled: true, active: false });
  assertEquals(ConnectionGate.controls(wanted).disable, true);
  assertEquals(ConnectionGate.disableReason(wanted), null);
});

Deno.test("a host override freezes the form but not the kill switch", () => {
  const overridden = model({
    editable: false,
    configured: true,
    enabled: true,
    active: true,
  });
  const controls = ConnectionGate.controls(overridden);
  assertEquals(controls.fields, false);
  assertEquals(controls.save, false);
  assertEquals(controls.test, false);
  assertEquals(controls.refresh, false);
  assertEquals(
    controls.disable,
    true,
    "the operator can still stop what the flag started",
  );
  assertEquals(ConnectionGate.enableReason(overridden), "read-only");
});
