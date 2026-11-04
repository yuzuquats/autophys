import { assertEquals } from "jsr:@std/assert";

import { StickerEffect } from "./sticker-effect.ts";

Deno.test("StickerEffect.fromWire: accepts known effect ids", () => {
  assertEquals(StickerEffect.fromWire("foil"), "foil");
  assertEquals(StickerEffect.fromWire("holo"), "holo");
  assertEquals(StickerEffect.fromWire("poly"), "poly");
  assertEquals(StickerEffect.fromWire("shimmer"), "shimmer");
});

Deno.test("StickerEffect.fromWire: defaults invalid or empty values to plain", () => {
  assertEquals(StickerEffect.fromWire(null), "plain");
  assertEquals(StickerEffect.fromWire(""), "plain");
  assertEquals(StickerEffect.fromWire("rainbow"), "plain");
});
