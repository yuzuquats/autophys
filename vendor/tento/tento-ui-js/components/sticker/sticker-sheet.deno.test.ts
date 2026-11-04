import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";

Deno.test("sticker sheet load failure copy does not expose transport details", async () => {
  const { StickerSheet } = await import("./sticker-sheet.ts");
  const description = StickerSheet.LOAD_FAILURE_DESCRIPTION;

  assertEquals(description, "Stickers could not be loaded.");
  assert(!description.includes("GET "));
  assert(!description.includes("https://"));
  assert(!description.includes("status 404"));
});
