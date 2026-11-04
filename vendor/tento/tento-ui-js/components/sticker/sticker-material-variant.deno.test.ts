import { assertEquals } from "@std/assert";

import { StickerEffect } from "./sticker-effect.ts";
import { StickerMaterialVariant } from "./sticker-material-variant.ts";

Deno.test("StickerMaterialVariant: every variant maps to a saved effect id", () => {
  for (const variant of StickerMaterialVariant.ALL) {
    assertEquals(
      StickerEffect.fromWire(variant.effect),
      variant.effect,
      variant.id,
    );
  }
});

Deno.test("StickerMaterialVariant.defaultForEffect: keeps saved ids stable", () => {
  assertEquals(StickerMaterialVariant.defaultForEffect("plain"), "plain");
  assertEquals(StickerMaterialVariant.defaultForEffect("foil"), "foil-satin");
  assertEquals(StickerMaterialVariant.defaultForEffect("holo"), "holo-prism");
  assertEquals(StickerMaterialVariant.defaultForEffect("poly"), "poly-chroma");
  assertEquals(
    StickerMaterialVariant.defaultForEffect("shimmer"),
    "shimmer-sweep",
  );
});

Deno.test("StickerMaterialVariant.fromWire: accepts material ids", () => {
  assertEquals(StickerMaterialVariant.fromWire("holo-cosmos"), "holo-cosmos");
  assertEquals(
    StickerMaterialVariant.fromWire("holo-cosmos-animated"),
    "holo-cosmos-animated",
  );
  assertEquals(StickerMaterialVariant.fromWire("shader-prism"), "shader-prism");
  assertEquals(
    StickerMaterialVariant.fromWire("shader-prism-static"),
    "shader-prism-static",
  );
});

Deno.test("StickerMaterialVariant.fromWire: defaults invalid values to plain", () => {
  assertEquals(StickerMaterialVariant.fromWire(null), "plain");
  assertEquals(StickerMaterialVariant.fromWire("rainbow"), "plain");
});

Deno.test("StickerMaterialVariant: every visual style has static and animated choices", () => {
  const motionsByStyle = new Map<
    StickerMaterialVariant.Style,
    Set<StickerMaterialVariant.Motion>
  >();

  for (const variant of StickerMaterialVariant.ALL) {
    if (variant.style === "plain") continue;
    const motions = motionsByStyle.get(variant.style) ??
      new Set<StickerMaterialVariant.Motion>();
    motions.add(variant.motion);
    motionsByStyle.set(variant.style, motions);
  }

  for (const [style, motions] of motionsByStyle) {
    assertEquals(motions.has("static"), true, style);
    assertEquals(motions.has("animated"), true, style);
  }
});

Deno.test("StickerMaterialVariant: css rendering matches motion", () => {
  for (const variant of StickerMaterialVariant.CSS) {
    const expected = variant.motion === "animated"
      ? "animated-css"
      : "static-css";
    assertEquals(variant.rendering, expected, variant.id);
  }
});
