import { assertEquals } from "jsr:@std/assert";
import { ProjectGroups } from "./project-groups.ts";

Deno.test("a master collects projects across repos and nested masters in reading order", () => {
  const grouped = ProjectGroups.resolve(new Set(["tsh", "chat", "blocks", "terms", "queue"]),
    new Map([["tsh", ["chat", "queue"]], ["chat", ["blocks", "terms"]]]));
  assertEquals([...grouped.descendants], [["tsh", [
    { slug: "chat", depth: 1, ordinal: "1" },
    { slug: "blocks", depth: 2, ordinal: "1.1" },
    { slug: "terms", depth: 2, ordinal: "1.2" },
    { slug: "queue", depth: 1, ordinal: "2" },
  ]]]);
  assertEquals([...grouped.parent], [["chat", "tsh"], ["queue", "tsh"], ["blocks", "chat"], ["terms", "chat"]]);
});

Deno.test("missing masters leave projects visible and missing children retain declared ordinals", () => {
  const grouped = ProjectGroups.resolve(new Set(["root", "present", "orphan"]),
    new Map([["root", ["missing", "present"]], ["absent-root", ["orphan"]]]));
  assertEquals(grouped.parent.has("orphan"), false);
  assertEquals(grouped.descendants.get("root"), [{ slug: "present", depth: 1, ordinal: "2" }]);
});

Deno.test("duplicate claims resolve once and cycles retain a visible root", () => {
  const grouped = ProjectGroups.resolve(new Set(["a", "b", "c", "d"]),
    new Map([["a", ["a", "b", "b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["b"]]]));
  assertEquals([...grouped.parent], [["b", "a"], ["c", "b"]]);
  assertEquals(grouped.descendants.get("a")?.map(x => x.slug), ["b", "c"]);
  assertEquals(grouped.parent.has("a"), false);
  assertEquals(grouped.parent.has("d"), false);
});

Deno.test("a stack without master rolls keeps every project as a root", () => {
  const grouped = ProjectGroups.resolve(new Set(["one", "two"]), new Map());
  assertEquals(grouped.parent.size, 0);
  assertEquals(grouped.descendants.size, 0);
});
