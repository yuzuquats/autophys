import { MathUtils } from "@tento-core/math";
import { GradientSplat } from "../gradient-splat";
import type { GeometrySource } from "./geometry-source";

// Renders a `GeometrySource`'s blobs through the real `GradientSplat` wash filter, plus the small
// harmonious palettes + tuning the storybooks drive it with.
export namespace GeometryWash {
  // Small harmonious palettes (2–3 ADJACENT hues each) reused across ALL blobs — a dense field can
  // grow without introducing new colors, so it stays cohesive instead of going rainbow. Translucent
  // so overlaps blend like the wash. Storybook-only decorative colors, not design tokens.
  export const PALETTES = {
    cool: [
      "rgba(56, 189, 248, 0.5)", // sky
      "rgba(34, 211, 238, 0.46)", // cyan
      "rgba(96, 165, 250, 0.46)", // blue
    ],
    warm: [
      "rgba(251, 191, 36, 0.5)", // amber
      "rgba(251, 146, 60, 0.46)", // orange
      "rgba(248, 113, 113, 0.46)", // coral
    ],
    violet: [
      "rgba(167, 139, 250, 0.5)", // violet
      "rgba(129, 140, 248, 0.46)", // indigo
      "rgba(96, 165, 250, 0.46)", // blue
    ],
    meadow: [
      "rgba(52, 211, 153, 0.5)", // emerald
      "rgba(74, 222, 128, 0.46)", // green
      "rgba(163, 230, 53, 0.42)", // lime
    ],
    rose: [
      "rgba(244, 114, 182, 0.5)", // pink
      "rgba(251, 113, 133, 0.46)", // rose
      "rgba(251, 146, 60, 0.42)", // coral
    ],
  } as const;

  // Tuning for the geometry→wash bridge: feather, sub-blob depth-of-field, grain, and palette.
  export type Options = {
    blurFrac: number; // softness = effectiveBlobSize · blurFrac (the feather amount)
    sharpRatio: number; // sharp-pass blur = softness · this (smaller ⇒ crisper sharp spots)
    patchFrac: number; // sharp-patch px = effectiveBlobSize · this (< 1 ⇒ only PART of a blob sharpens)
    sharpenAmount: number; // 0..1 — how much of the field resolves sharp (0 = uniformly soft)
    grain: number; // baked-noise strength
    colors: readonly string[]; // a fixed handful, reused across all blobs
  };

  export const DEFAULT: Options = {
    blurFrac: 0.28,
    sharpRatio: 0.12,
    patchFrac: 0.55,
    sharpenAmount: 0.4,
    grain: 0.7,
    colors: PALETTES.cool,
  };

  // Render a `GeometrySource`'s blobs through the real `GradientSplat` wash filter for `size`. The
  // softness + sharp-patch scale track the source's EFFECTIVE blob size, so the wash holds its
  // blob-relative character as the canvas resizes. Returns a `url("data:image/svg+xml,…")` string.
  // Shared by the live `GeometryField` (wash mode) and the "Gradient Splat — new" variant gallery.
  export function background(
    source: GeometrySource,
    size: GeometrySource.Size,
    options: Options,
  ): string {
    const blobPx = source.blobSizeFor(size);
    const softness = MathUtils.roundToDecimals(blobPx * options.blurFrac, 1);
    const pad = GradientSplat.washGutterFor(softness);
    const shapes = source.shapesFor(size, pad);
    const outlines: GradientSplat.WashOutline[] = shapes.map((shape, i) => ({
      d: shape.d,
      color: options.colors[i % options.colors.length],
    }));
    return GradientSplat.washForShapes(outlines, size, {
      softness,
      grain: options.grain,
      sharpen: {
        ratio: options.sharpRatio,
        patchPx: MathUtils.roundToDecimals(blobPx * options.patchFrac, 1),
        amount: options.sharpenAmount,
      },
    });
  }
}
