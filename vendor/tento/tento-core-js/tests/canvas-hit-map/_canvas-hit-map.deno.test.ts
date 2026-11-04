import { assertEquals } from "jsr:@std/assert";
import { Fixtures } from "../fixture-runner.deno.ts";
import { CanvasHitMap } from "../../canvas-hit-map.ts";

type EntryDef = {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
};

type Input = {
  entries: EntryDef[];
  point: { x: number; y: number };
};

type Expected = {
  id: string;
  region: "body" | "top" | "bottom";
} | null;

Fixtures.load<Input, Expected>(
  new URL(".", import.meta.url).pathname,
  "canvas-hit-map",
).run(
  (input) => {
    const hitMap = new CanvasHitMap();
    for (const entry of input.entries) {
      hitMap.add(entry);
    }
    hitMap.build();
    return hitMap.resolve(input.point.x, input.point.y);
  },
  (result, expected) => {
    if (expected === null) {
      assertEquals(result, null, "expected no hit");
      return;
    }
    assertEquals(result != null, true, "expected a hit");
    assertEquals(result!.id, expected.id, "id");
    assertEquals(result!.region, expected.region, "region");
  },
);
