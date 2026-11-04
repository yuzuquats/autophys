import type { Point } from "@tento-core/point";

/**
 * Shared types for sticker silhouette packing.
 *
 * A sticker silhouette is a single simple closed polygon — no holes (holes are
 * not permitted; only the outer perimeter loop from the cutout is used). All
 * coordinates are plain px in the same space the polygon was authored in; the
 * packer bbox-normalizes each shape before placing it.
 */

/** A simple closed polygon: ordered vertices, no repeated closing vertex. */
export type Polygon = ReadonlyArray<Point>;

export type Size = {
  width: number;
  height: number;
};

/** Axis-aligned bounds plus the derived width/height. */
export type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

export type ShapeInput = {
  id: string;
  polygon: Polygon;
} & Optional<{
  /**
   * Geometry used only for packing calculations. The source `polygon` remains
   * the visual/rendering truth, so simplification cannot visibly simplify art.
   */
  calculationPolygon: Polygon;
}>;

export type Placement = {
  id: string;
  /** Top-left of the placed (rotated, padded) polygon bbox, in container px. */
  translation: Point;
  /** Container-space translation used to render the original sticker content. */
  contentTranslation: Point;
  /** Pre-rotation offset that moves the original polygon bbox-min to origin. */
  contentOffset: Point;
  /** Discrete rotation chosen, degrees CCW. 0 when rotation is disabled. */
  rotationDeg: number;
  /** Size of the placed (rotated, padded) polygon bbox. */
  bbox: Size;
};

export type PackOrder =
  | "area-desc"
  | "height-desc"
  | "bbox-area-desc"
  | "mixed-desc"
  | "as-given";

export type CalculationGeometryOptions = Optional<{
  enabled: boolean;
  simplifyTolerancePx: number;
  minVertices: number;
  maxAreaDeltaRatio: number;
}>;

export type RowJustifyAlign = "left" | "center";

export type RowJustifyOptions = {
  /** Desired horizontal clearance between adjacent row items. */
  gapPx: number;
  /** Max top-edge delta for placements to be treated as one row. */
  rowTolerancePx: number;
  /** Row alignment inside the fixed strip width after gap application. */
  alignX: RowJustifyAlign;
};

export type PackOptions = Optional<{
  /** Fixed strip width in px. Default 360 (sidebar palette). */
  containerWidth: number;
  /** Clearance between shapes in px (each shape is inflated by half). Default 4. */
  paddingPx: number;
  /** Candidate rotations per shape in degrees CCW. Default [0] (no rotation). */
  rotationsDeg: number[];
  /** Geometric tolerance. Default 1e-4. */
  epsilon: number;
  /** Placement ordering heuristic. Default "area-desc". */
  order: PackOrder;
  /** Calculation-only simplification for faster collision/search. */
  geometry: CalculationGeometryOptions;
  /** Legacy search candidate cap; organic-sheet keeps it for API compatibility. */
  maxCandidates: number;
  /** Optional post-pass that regularizes row gaps while preserving collision safety. */
  rowJustify: RowJustifyOptions;
}>;

export type PackResult = {
  placements: Placement[];
  containerWidth: number;
  /** Used height = max bottom edge reached across top-anchored placements. */
  containerHeight: number;
  /** sum(shape areas) / (containerWidth * containerHeight), in (0, 1]. */
  density: number;
  /** Ids of shapes wider than the strip at every rotation (could not fit). */
  unplaced: string[];
};
