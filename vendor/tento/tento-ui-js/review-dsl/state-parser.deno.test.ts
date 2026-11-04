import { assert, assertEquals } from "jsr:@std/assert";

import { StateParser } from "./state-parser.ts";

function parseOk(src: string): StateParser.Machine {
  const r = StateParser.parse(src);
  if (!r.ok) throw new Error(`parse failed: line ${r.error.line}: ${r.error.message}`);
  return r.value;
}

Deno.test("start/end pseudostates, labels, transition statuses", () => {
  const m = parseOk(`
    stateDiagram-v2
      [*] --> Queued
      Queued --> Staged: stage
      Staged --> Drained: drain ::new
      state "In master" as Drained
      Drained --> [*]
      class Queued changed
  `);
  assertEquals(m.states.find((s) => s.pseudo === "start")?.id, StateParser.START);
  assertEquals(m.states.find((s) => s.pseudo === "end")?.id, StateParser.END);
  assertEquals(m.states.find((s) => s.id === "Drained")?.label, "In master");
  assertEquals(m.states.find((s) => s.id === "Queued")?.status, "changed");
  const drain = m.transitions.find((t) => t.to === "Drained");
  assertEquals(drain?.status, "new");
  assertEquals(drain?.label, "drain");
});

Deno.test("skips note blocks, direction, braces", () => {
  const m = parseOk(`
    [*] --> A
    direction LR
    note right of A
      free text that is not a transition
    end note
    state A {
    }
    A --> B
  `);
  assertEquals(m.transitions.length, 2);
});

Deno.test("unparseable line errors with line number", () => {
  const r = StateParser.parse(`[*] --> A\nA => B`);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.error.line, 2);
});
