import { assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { FixedChildLayoutManager, type FixedChildLayoutNode } from "./fixed-child-layout-manager.ts";
import { rowIdentity } from "./row-identity.ts";

function node(id: string, start: number, row: string, owner: string): FixedChildLayoutNode {
  return {
    id,
    range: { start, end: start + 1 },
    data: {
      $content: { getAttribute: (name: string) => name === "row-id" ? row : name === "data-fixed-owner" ? owner : null },
      rowId: null,
      owner: null,
      inset: null,
    },
  };
}

Deno.test("fixed-child manager removing FIRST-added same-start child preserves mounted siblings", () => {
  for (const removed of ["a", "b"]) {
    const manager = new FixedChildLayoutManager();
    const entries = [node("a", 1, "row", "owner"), node("b", 1, "row", "owner"), node("c", 1, "row", "owner")];
    for (const entry of entries) manager.add(entry);
    manager.remove(removed);
    const survivors = entries.filter((entry) => entry.id !== removed);
    assertEquals(manager.findAll(), survivors);
    assertEquals(manager.findInRange({ start: 1, end: 2 }), survivors);
    assertEquals([...manager.getIdsForRowOwner(rowIdentity("row"), "owner")], survivors.map((entry) => entry.id));
    for (const entry of survivors) assertStrictEquals(manager.get(entry.id), entry);
  }
});

Deno.test("fixed-child manager deletion removes the exact row and owner membership at shared starts", () => {
  const manager = new FixedChildLayoutManager();
  const entries = [node("a", 1, "row-a", "first"), node("b", 1, "row-b", "second"), node("c", 1, "row-a", "second")];
  for (const entry of entries) manager.add(entry);
  manager.remove("a");
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row-a"), "first")], []);
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row-b"), "second")], ["b"]);
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row-a"), "second")], ["c"]);
  manager.remove("b");
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row-b"), "second")], []);
  assertEquals([...manager.getIdsForOwner("second")], ["c"]);
  assertStrictEquals(manager.get("c"), entries[2]);
});

Deno.test("fixed-child manager replacing an id transfers ownership and inset updates to its exact node", () => {
  const manager = new FixedChildLayoutManager();
  manager.add(node("a", 1, "old-row", "old-owner"));
  const replacement = node("a", 1, "new-row", "new-owner");
  const sibling = node("b", 1, "new-row", "new-owner");
  manager.add(replacement); manager.add(sibling);
  assertEquals([...manager.getIdsForOwner("old-owner")], []);
  assertStrictEquals(manager.updateInset("b", { top: 42 }), sibling);
  assertEquals(replacement.data.inset, null);
  assertEquals(sibling.data.inset, { top: 42 });
  manager.clear();
  assertEquals(manager.findAll(), []);
  assertEquals([...manager.getIdsForOwner("new-owner")], []);
});

Deno.test("fixed-child manager middle deletion cannot redirect later removal to another owner", () => {
  const manager = new FixedChildLayoutManager();
  const entries = [node("middle", 2, "middle-row", "middle-owner"), node("left", 1, "left-row", "left-owner"), node("right", 3, "right-row", "right-owner"), node("right-sibling", 3, "sibling-row", "sibling-owner")];
  for (const entry of entries) manager.add(entry);
  const remaining = new Set(entries.map((entry) => entry.id));
  for (const id of ["middle", "right", "left", "right-sibling"]) {
    manager.remove(id); remaining.delete(id);
    for (const entry of entries) {
      const expected = remaining.has(entry.id) ? [entry.id] : [];
      assertEquals([...manager.getIdsForRowOwner(entry.data.rowId ?? rowIdentity(""), entry.data.owner ?? "")], expected);
      assertEquals([...manager.getIdsForOwner(entry.data.owner ?? "")], expected);
    }
    assertEquals(manager.findAll().map((entry) => entry.id), [...remaining]);
  }
});

Deno.test("fixed-child manager excludes the next column at the query trailing edge", () => {
  const manager = new FixedChildLayoutManager();
  const next = node("next", 2, "row", "owner");
  manager.add(next);
  assertEquals(manager.findInRange({ start: 1, end: 2 }), []);
  assertEquals(manager.findInRange({ start: 2, end: 3 }), [next]);
});

Deno.test("fixed-child manager empty owner membership has symmetric add remove and transfer", () => {
  const manager = new FixedChildLayoutManager();
  manager.add(node("a", 1, "row", ""));
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row"), "")], ["a"]);
  manager.updateRowOwner("a", rowIdentity("row"), "", rowIdentity("next"), "");
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("row"), "")], []);
  assertEquals([...manager.getIdsForRowOwner(rowIdentity("next"), "")], ["a"]);
  const moved = manager.get("a");
  if (moved) moved.data.rowId = rowIdentity("next");
  manager.remove("a");
  assertEquals([...manager.getIdsForOwner("")], []);
});
