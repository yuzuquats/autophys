import { assertEquals, assertThrows } from "jsr:@std/assert";

import { JsonReader } from "../../json-reader.ts";

Deno.test("JsonReader reads required and optional typed fields", () => {
  const obj = JsonReader.parseObject(
    JSON.stringify({
      name: "Pixel Art",
      enabled: true,
      count: 16,
      tags: ["pixel", "stickers"],
      meta: { accent: "var(--purple)" },
    }),
    "registry",
  );

  assertEquals(JsonReader.string(obj, "name", "registry"), "Pixel Art");
  assertEquals(JsonReader.boolean(obj, "enabled", "registry"), true);
  assertEquals(JsonReader.positiveInteger(obj, "count", "registry"), 16);
  assertEquals(JsonReader.optionalString(obj, "missing", "registry"), null);
  assertEquals(JsonReader.optionalBoolean(obj, "missing", "registry"), null);
  assertEquals(JsonReader.array(obj, "tags", "registry").length, 2);

  const meta = JsonReader.childObject(obj, "meta", "registry");
  assertEquals(JsonReader.string(meta, "accent", "registry.meta"), "var(--purple)");
});

Deno.test("JsonReader reports labeled shape errors", () => {
  assertThrows(
    () => JsonReader.parseObject("[]", "registry"),
    Error,
    "registry must be an object",
  );

  const obj = JsonReader.parseObject(
    JSON.stringify({ name: "", count: 0, tags: "nope", enabled: "yes" }),
    "registry",
  );

  assertThrows(
    () => JsonReader.string(obj, "name", "registry"),
    Error,
    "registry.name must be a non-empty string",
  );
  assertThrows(
    () => JsonReader.boolean(obj, "enabled", "registry"),
    Error,
    "registry.enabled must be a boolean",
  );
  assertThrows(
    () => JsonReader.positiveInteger(obj, "count", "registry"),
    Error,
    "registry.count must be a positive integer",
  );
  assertThrows(
    () => JsonReader.array(obj, "tags", "registry"),
    Error,
    "registry.tags must be an array",
  );
});
