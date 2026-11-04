/**
 * Decoupled geometry generation for resizable gradients.
 *
 * A `GeometrySource` produces the BLOB SHAPES that back a gradient wash, RE-GENERATED for each
 * target size rather than transform-scaled. The defining property: as the canvas grows, each
 * blob stays ~the SAME absolute size (`blobSizePx`) and the COUNT rises to fill the area — so a
 * resized gradient gains more blobs instead of bigger ones. `blobSizePx` is the "density" the
 * sources are tuned to share (the cluster-growth baseline here, a fractal-noise source later).
 *
 * The renderer (the wash, or the flat geometry component) consumes `shapesFor(size)` and never
 * needs to know which generator produced the shapes.
 */
export interface GeometrySource {
  // Stable id for cache keys / labels.
  readonly name: string;
  // The NOMINAL characteristic blob radius in px (at the reference canvas size) — the density
  // target. The EFFECTIVE radius at a given canvas comes from `blobSizeFor` (it may scale).
  readonly blobSizePx: number;
  // Effective characteristic radius (px) at this canvas size. With a size-scale factor of 0 it
  // equals `blobSizePx` (constant size, the count fills the area); higher factors let the blob
  // grow with the canvas dimension — so a consumer's blur/detail can track it.
  blobSizeFor(size: GeometrySource.Size): number;
  // Generate the blobs that fill `size`. Count scales with area; blob size per `blobSizeFor`.
  // `pad` is an extra inset (px) reserved on every edge so a consumer that blurs the shapes (the
  // wash) keeps its feather inside the canvas instead of clipping it — pass 0 for a flat draw.
  shapesFor(size: GeometrySource.Size, pad: number): GeometrySource.Shape[];
}

export namespace GeometrySource {
  export type Size = {
    width: number;
    height: number;
  };

  export type Point = {
    x: number;
    y: number;
  };

  // One blob, in absolute screen-space px: its smooth outline `points` (+ a closed SVG path `d`),
  // its `center`, and its characteristic `radius` (≈ the source's blobSizePx).
  export type Shape = {
    points: Point[];
    center: Point;
    radius: number;
    d: string;
  };

  // ---- Density readouts (blob size is the target; these are diagnostics) --------------------

  // Mean blob radius across the field — should track `blobSizePx` regardless of canvas size.
  export function meanRadius(shapes: readonly Shape[]): number {
    if (shapes.length === 0) return 0;
    const total = shapes.reduce((sum, shape) => sum + shape.radius, 0);
    return Math.round((total / shapes.length) * 10) / 10;
  }

  // Coverage ≈ how much of the canvas the blobs occupy. Sum of blob disc areas clamped to the
  // canvas (overlap means this over-counts, so it saturates ~1) — a cheap "fullness" signal that
  // should stay roughly constant as the field resizes (blobs scale in count, not size).
  export function coverage(shapes: readonly Shape[], size: Size): number {
    const canvasArea = Math.max(1, size.width * size.height);
    const blobArea = shapes.reduce(
      (sum, shape) => sum + Math.PI * shape.radius * shape.radius,
      0,
    );
    return Math.min(1, Math.round((blobArea / canvasArea) * 100) / 100);
  }
}
