import { assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { FixedChildIndex } from "./fixed-child-index.ts";

function node(id: string, start: number) {
  return { id, range: { start, end: start + 1 } };
}

Deno.test("fixed-child index removing the first-added same-start child keeps its sibling queryable", () => {
  const index = new FixedChildIndex<ReturnType<typeof node>>();
  const a = node("a", 1), b = node("b", 1), c = node("c", 2);
  for (const entry of [a, b, c]) index.set(entry);
  assertStrictEquals(index.get("a"), a);
  assertStrictEquals(index.get("b"), b);
  index.delete("a");
  assertStrictEquals(index.get("b"), b);
  assertEquals(index.inRange({ start: 1, end: 2 }), [b]);
  index.delete("b");
  assertStrictEquals(index.get("c"), c);
});

Deno.test("fixed-child index same-start removal works in both insertion orders and with three siblings", () => {
  for (const removed of ["a", "b"]) {
    const index = new FixedChildIndex<ReturnType<typeof node>>();
    const entries = [node("a", 1), node("b", 1), node("c", 1)];
    for (const entry of entries) index.set(entry);
    index.delete(removed);
    const survivors = entries.filter((entry) => entry.id !== removed);
    assertEquals(index.all(), survivors);
    assertEquals(index.inRange({ start: 1, end: 2 }), survivors);
    for (const entry of survivors) assertStrictEquals(index.get(entry.id), entry);
  }
});

Deno.test("fixed-child index deletion cannot transfer another node into the removed id", () => {
  const index = new FixedChildIndex<ReturnType<typeof node>>();
  const entries = [node("middle", 2), node("left", 1), node("right", 3), node("right-bar", 3)];
  for (const entry of entries) index.set(entry);
  index.delete("middle");
  assertEquals(index.get("middle"), null);
  for (const entry of entries.slice(1)) assertStrictEquals(index.get(entry.id), entry);
  index.delete("right");
  assertStrictEquals(index.get("right-bar"), entries[3]);
});

Deno.test("fixed-child index queries current mapper geometry with exclusive ends", () => {
  const index = new FixedChildIndex<ReturnType<typeof node>>();
  const a = node("a", 1); index.set(a);
  a.range = { start: 8, end: 11 };
  assertEquals(index.inRange({ start: 1, end: 2 }), []);
  assertEquals(index.inRange({ start: 7, end: 8 }), []);
  assertEquals(index.inRange({ start: 11, end: 12 }), []);
  assertEquals(index.inRange({ start: 9, end: 10 }), [a]);
});

Deno.test("fixed-child index rolling replacements retain survivors and bound cardinality", () => {
  const index = new FixedChildIndex<ReturnType<typeof node>>();
  for (let i = 0; i < 24; i++) index.set(node(String(i), Math.floor(i / 2)));
  for (let i = 0; i < 200; i++) {
    const survivor = index.get(String(i + 1));
    index.delete(String(i));
    index.set(node(String(i + 24), Math.floor((i + 24) / 2)));
    assertStrictEquals(index.get(String(i + 1)), survivor);
    assertEquals(index.all().length, 24);
    assertEquals(new Set(index.all().map((entry) => entry.id)).size, 24);
  }
  index.clear(); assertEquals(index.all(), []);
});
