import { assert, assertEquals } from "jsr:@std/assert";

import { SeqParser } from "./seq-parser.ts";

function parseOk(src: string): SeqParser.Doc {
  const r = SeqParser.parse(src);
  if (!r.ok) throw new Error(`parse failed: line ${r.error.line}: ${r.error.message}`);
  return r.value;
}

Deno.test("parses participants, messages, replies, notes", () => {
  const doc = parseOk(`
    sequenceDiagram
      participant P as Review page
      participant N as Node (8795)
      P->>N: GET /api/stack/mono
      N-->>P: drafts + public
      Note over P,N: relay adds /data/<host> prefix
      P->>P: render two lanes
  `);
  assertEquals(doc.actors.map((a) => a.label), ["Review page", "Node (8795)"]);
  assertEquals(doc.items.length, 4);
  const first = doc.items[0];
  assert(first.kind === "msg");
  if (first.kind === "msg") {
    assertEquals(first.from, "P");
    assertEquals(first.text, "GET /api/stack/mono");
    assertEquals(first.dashed, false);
  }
  const reply = doc.items[1];
  if (reply.kind === "msg") assertEquals(reply.dashed, true);
  const note = doc.items[2];
  assert(note.kind === "note");
  if (note.kind === "note") assertEquals(note.actors, ["P", "N"]);
});

Deno.test("auto-declares actors in first-use order; header optional", () => {
  const doc = parseOk(`
    client->>server: hello
    server->>db: query
  `);
  assertEquals(doc.actors.map((a) => a.id), ["client", "server", "db"]);
});

Deno.test("skips control-flow keywords, keeps their body messages", () => {
  const doc = parseOk(`
    sequenceDiagram
      autonumber
      A->>B: try
      alt failure
        B-->>A: error
      end
      activate B
  `);
  assertEquals(doc.items.length, 2);
});

Deno.test("note left of / right of forms", () => {
  const doc = parseOk(`Note right of A: hi\nA->>B: x`);
  const note = doc.items[0];
  assert(note.kind === "note");
  if (note.kind === "note") assertEquals(note.actors, ["A"]);
});

Deno.test("unparseable line errors with line number", () => {
  const r = SeqParser.parse(`A->>B: ok\nnot a message line`);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.error.line, 2);
});
