import { assert, assertEquals } from "jsr:@std/assert";

import { GraphLayout } from "./graph-layout.ts";

const E = (from: string, to: string): GraphLayout.EdgeIn => ({ from, to });

Deno.test("linear chain ranks left to right, one grid column per rank", () => {
  const out = GraphLayout.layout(["a", "b", "c"], [E("a", "b"), E("b", "c")], "LR", null);
  const [a, b, c] = [out.cells.get("a")!, out.cells.get("b")!, out.cells.get("c")!];
  assertEquals(a.col, 0);
  assertEquals(b.col, 1);
  assertEquals(c.col, 2);
  assertEquals(a.row, b.row);
  assertEquals(out.cols, 3);
});

Deno.test("diamond: branches share a column, merge returns to one node", () => {
  const out = GraphLayout.layout(
    ["s", "l", "r", "t"],
    [E("s", "l"), E("s", "r"), E("l", "t"), E("r", "t")],
    "LR", null
  );
  assertEquals(out.cells.get("l")!.col, out.cells.get("r")!.col);
  assert(out.cells.get("l")!.row !== out.cells.get("r")!.row);
  assert(out.cells.get("t")!.col > out.cells.get("l")!.col);
});

Deno.test("long edge reserves one via cell per skipped rank", () => {
  const out = GraphLayout.layout(
    ["a", "b", "c"],
    [E("a", "b"), E("b", "c"), E("a", "c")],
    "LR", null
  );
  const long = out.edges.find((e) => e.from === "a" && e.to === "c")!;
  assertEquals(long.via.length, 1);
  assertEquals(long.via[0].col, out.cells.get("b")!.col);
  assert(long.via[0].row !== out.cells.get("b")!.row);
});

Deno.test("cycles are broken, all nodes placed, edge orientation preserved", () => {
  const out = GraphLayout.layout(
    ["a", "b", "c"],
    [E("a", "b"), E("b", "c"), E("c", "a")],
    "LR", null
  );
  assertEquals(out.cells.size, 3);
  const back = out.edges.find((e) => e.from === "c" && e.to === "a");
  assert(back != null); // reported in author orientation despite the flip
});

Deno.test("no two nodes share a grid cell", () => {
  const out = GraphLayout.layout(
    "abcdefgh".split(""),
    [E("a", "b"), E("a", "c"), E("a", "d"), E("b", "e"), E("c", "e"), E("d", "e"), E("f", "e"), E("g", "e"), E("h", "e")],
    "LR", null
  );
  const seen = new Set<string>();
  for (const cell of out.cells.values()) {
    const key = `${cell.col}:${cell.row}`;
    assert(!seen.has(key), `duplicate cell ${key}`);
    seen.add(key);
  }
});

Deno.test("TD transposes axes", () => {
  const out = GraphLayout.layout(["a", "b"], [E("a", "b")], "TD", null);
  const [a, b] = [out.cells.get("a")!, out.cells.get("b")!];
  assert(b.row > a.row);
  assertEquals(a.col, b.col);
});

Deno.test("deterministic across runs", () => {
  const ids = "abcdefghij".split("");
  const edges = [
    E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d"), E("d", "e"),
    E("e", "f"), E("c", "g"), E("g", "h"), E("h", "e"), E("a", "i"),
    E("i", "j"), E("j", "f"),
  ];
  const one = GraphLayout.layout(ids, edges, "LR", null);
  const two = GraphLayout.layout(ids, edges, "LR", null);
  assertEquals(JSON.stringify([...one.cells]), JSON.stringify([...two.cells]));
  assertEquals(JSON.stringify(one.edges), JSON.stringify(two.edges));
});

// The container budget: collision avoidance has to account for the space the
// parent actually offers, not just the graph's own shape.

const FAN = {
  ids: ["s", "a", "b", "c", "d", "t"],
  edges: [E("s", "a"), E("s", "b"), E("s", "c"), E("s", "d"), E("a", "t"), E("b", "t"), E("c", "t"), E("d", "t")],
};

Deno.test("a rank wider than the budget tiles onto extra lines", () => {
  const wide = GraphLayout.layout(FAN.ids, FAN.edges, "TD", null);
  const tiled = GraphLayout.layout(FAN.ids, FAN.edges, "TD", 2);
  assertEquals(wide.cols, 4); // s → a b c d → t
  assertEquals(tiled.cols, 2); // never wider than the budget
  assert(tiled.rows > wide.rows); // the width it lost, it grew downward
});

Deno.test("tiling keeps every cell collision-free and ranks in order", () => {
  const out = GraphLayout.layout(FAN.ids, FAN.edges, "TD", 2);
  const seen = new Set<string>();
  for (const [id, cell] of out.cells) {
    const key = `${cell.col}:${cell.row}`;
    assert(!seen.has(key), `duplicate cell ${key} at ${id}`);
    assert(cell.col < out.cols && cell.row < out.rows, `${id} outside the grid`);
    seen.add(key);
  }
  // Bands stay disjoint: the fanned rank sits strictly between s and t.
  const rowOf = (id: string): number => out.cells.get(id)!.row;
  for (const id of ["a", "b", "c", "d"]) {
    assert(rowOf(id) > rowOf("s") && rowOf(id) < rowOf("t"), `${id} escaped its band`);
  }
});

Deno.test("a budget the diagram already fits inside changes nothing", () => {
  const natural = GraphLayout.layout(FAN.ids, FAN.edges, "TD", null);
  const roomy = GraphLayout.layout(FAN.ids, FAN.edges, "TD", 8);
  assertEquals(JSON.stringify([...roomy.cells]), JSON.stringify([...natural.cells]));
});

Deno.test("a budget of one stacks the whole diagram in a single column", () => {
  const out = GraphLayout.layout(FAN.ids, FAN.edges, "TD", 1);
  assertEquals(out.cols, 1);
  assertEquals(new Set([...out.cells.values()].map((c) => c.row)).size, out.cells.size);
});

Deno.test("LR ignores the budget — its width is rank count, so the renderer flips instead", () => {
  const natural = GraphLayout.layout(FAN.ids, FAN.edges, "LR", null);
  const budgeted = GraphLayout.layout(FAN.ids, FAN.edges, "LR", 1);
  assertEquals(JSON.stringify([...budgeted.cells]), JSON.stringify([...natural.cells]));
});

Deno.test("unknown endpoints and self-loops are dropped, not fatal", () => {
  const out = GraphLayout.layout(["a", "b"], [E("a", "b"), E("a", "a"), E("a", "ghost")], "LR", null);
  assertEquals(out.edges.length, 1);
});
