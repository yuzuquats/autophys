import { assert, assertEquals } from "jsr:@std/assert";

import { FlowParser } from "./flow-parser.ts";

function parseOk(src: string): FlowParser.Graph {
  const r = FlowParser.parse(src);
  if (!r.ok) throw new Error(`parse failed: line ${r.error.line}: ${r.error.message}`);
  return r.value;
}

Deno.test("parses a mermaid-style flowchart with shapes, labels, chains", () => {
  const g = parseOk(`
    flowchart LR
      A[queue set] --> B{parse ok?}
      B -->|yes| C(render SVG)
      B -->|no| D[show code]
      C --> E --> F[done]
  `);
  assertEquals(g.dir, "LR");
  assertEquals(g.nodes.map((n) => n.id), ["A", "B", "C", "D", "E", "F"]);
  assertEquals(g.nodes[0].label, "queue set");
  assertEquals(g.nodes[1].shape, "decision");
  assertEquals(g.nodes[2].shape, "rounded");
  assertEquals(g.nodes[4].label, "E"); // bare id auto-declares
  assertEquals(g.edges.length, 5);
  assertEquals(g.edges[1].label, "yes");
});

Deno.test("no-space arrows, hyphenated ids, semicolons, TD header", () => {
  const g = parseOk(`graph TD; my-node-->other.node; other.node-.->x`);
  assertEquals(g.dir, "TD");
  assertEquals(g.nodes.map((n) => n.id), ["my-node", "other.node", "x"]);
  assertEquals(g.edges[1].dashed, true);
});

Deno.test("status via class statement and ::: shorthand", () => {
  const g = parseOk(`
    flowchart LR
      A --> B:::new
      A --> C
      class A,C changed
      class B ignoredStyleClass
  `);
  assertEquals(g.nodes.find((n) => n.id === "A")?.status, "changed");
  assertEquals(g.nodes.find((n) => n.id === "B")?.status, "new");
  assertEquals(g.nodes.find((n) => n.id === "C")?.status, "changed");
});

Deno.test("skips mermaid styling noise and comments silently", () => {
  const g = parseOk(`
    flowchart LR
      %% a comment
      classDef changed fill:#f96
      style A fill:#bbf
      linkStyle 0 stroke:red
      subgraph pipeline
      A --> B
      end
  `);
  assertEquals(g.nodes.length, 2);
  assertEquals(g.edges.length, 1);
});

Deno.test("header optional; missing header defaults LR", () => {
  const g = parseOk(`A --> B`);
  assertEquals(g.dir, "LR");
});

Deno.test("unparseable line errors with its fence-body line number", () => {
  const r = FlowParser.parse(`flowchart LR\nA --> B\nA --> --> C`);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.error.line, 3);
});

Deno.test("node cap enforced", () => {
  const stmts: string[] = [];
  for (let i = 0; i < 30; i++) stmts.push(`n${i} --> n${i + 1}`);
  const r = FlowParser.parse(stmts.join("\n"));
  assert(!r.ok);
});
