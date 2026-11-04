import { Geometry } from "./geometry";
import { PackingMetrics } from "./packing-metrics";
import { PlacementGeometry } from "./placement-geometry";
import type {
  PackOptions,
  PackOrder,
  PackResult,
  Placement,
  ShapeInput,
} from "./types";

/**
 * DOM-free organic sticker-sheet packer. The public strategy surface keeps an
 * id for Storybook and metrics plumbing, but the implementation intentionally
 * has one starting point: upright, top-down organic rows.
 */
export namespace PackingStrategy {
  export type Id = "organic-sheet";

  export type Options = Optional<{
    seed: number;
    metrics: PackingMetrics.Options;
  }>;

  export type Diagnostics = {
    originalVertexCount: number;
    calculationVertexCount: number;
    simplifiedShapeCount: number;
    simplificationFallbackCount: number;
    metricEvaluations: number;
    gridAlignmentPenalty: number;
    balancePenalty: number;
    organicScore: number;
    reorderId: PackOrder;
  };

  export type Run = {
    strategyId: Id;
    result: PackResult;
    metrics: PackingMetrics.Result;
    runtimeMs: number;
    diagnostics: Diagnostics;
  };

  type MutableDiagnostics = Diagnostics;

  type PreparedCalculation = {
    shapes: ShapeInput[];
    diagnostics: Pick<
      Diagnostics,
      | "originalVertexCount"
      | "calculationVertexCount"
      | "simplifiedShapeCount"
      | "simplificationFallbackCount"
      | "reorderId"
    >;
  };

  type OrganicRow = {
    placements: Placement[];
    width: number;
    height: number;
  };

  type OrganicAlignedRow = {
    placements: Placement[];
    height: number;
  };

  type AestheticDiagnostics = Pick<
    Diagnostics,
    "gridAlignmentPenalty" | "balancePenalty" | "organicScore"
  >;

  export const IDS: readonly Id[] = ["organic-sheet"];

  export const DEFAULT_ID: Id = "organic-sheet";

  export function run(
    shapes: readonly ShapeInput[],
    packOptions: PackOptions,
    strategyId: Id,
    strategyOptions: Options,
  ): Run {
    const startedAt = nowMs();
    const prepared = prepareCalculation(shapes, packOptions);
    const diagnostics = emptyDiagnostics(prepared.diagnostics);
    const result = organicSheetPack(
      prepared.shapes,
      packOptions,
      Math.trunc(strategyOptions.seed ?? 13871),
    );
    const runtimeMs = nowMs() - startedAt;
    const metrics = PackingMetrics.score(
      prepared.shapes,
      result,
      packOptions,
      strategyOptions.metrics ?? {},
    );
    diagnostics.metricEvaluations++;
    applyAestheticDiagnostics(diagnostics, result);
    return {
      strategyId,
      result,
      metrics,
      runtimeMs,
      diagnostics,
    };
  }

  export function runAll(
    shapes: readonly ShapeInput[],
    packOptions: PackOptions,
    strategyOptions: Options,
  ): Run[] {
    const runs: Run[] = [];
    for (const id of IDS) {
      runs.push(run(shapes, packOptions, id, strategyOptions));
    }
    return runs;
  }

  function organicSheetPack(
    shapes: readonly ShapeInput[],
    packOptions: PackOptions,
    seed: number,
  ): PackResult {
    const W = packOptions.containerWidth ?? 360;
    const paddingPx = PlacementGeometry.resolvedPaddingPx(packOptions);
    const eps = PlacementGeometry.resolvedEpsilon(packOptions);
    const gapPx = organicGapBase(paddingPx);
    const ordered = organicOrder(
      shapes,
      packOptions.order ?? "mixed-desc",
      seed,
    );
    const rows: OrganicRow[] = [];
    const unplaced: string[] = [];
    let row: OrganicRow = emptyOrganicRow();
    let rowIndex = 0;
    let rowTargetWidth = organicRowTargetWidth(W, paddingPx, rowIndex, seed);

    for (const shape of ordered) {
      const placement = firstFittingPlacement(shape, [0], paddingPx, eps, W);
      if (!placement) {
        unplaced.push(shape.id);
        continue;
      }

      let gapBefore = row.placements.length === 0
        ? 0
        : organicColumnGap(gapPx, rowIndex, row.placements.length, seed);
      if (
        shouldStartOrganicRow(
          row,
          placement,
          gapBefore,
          rowTargetWidth,
          W,
          eps,
        )
      ) {
        rows.push(row);
        rowIndex++;
        row = emptyOrganicRow();
        rowTargetWidth = organicRowTargetWidth(W, paddingPx, rowIndex, seed);
        gapBefore = 0;
      }

      row = appendOrganicPlacement(row, placement, gapBefore);
    }
    if (row.placements.length > 0) rows.push(row);

    const placements: Placement[] = [];
    let y = 0;
    for (let index = 0; index < rows.length; index++) {
      const aligned = alignOrganicRow(rows[index], index, W, gapPx, seed);
      for (const placement of aligned.placements) {
        placements.push(
          PlacementGeometry.movePlacement(placement, { x: 0, y }),
        );
      }
      y += aligned.height;
      if (index < rows.length - 1) {
        y += organicRowGap(gapPx, index, seed);
      }
    }

    const result = PlacementGeometry.resultWithPlacements(
      shapes,
      {
        placements,
        containerWidth: W,
        containerHeight: PlacementGeometry.placementHeight(placements),
        density: 0,
        unplaced,
      },
      placements,
    );
    const validation = PlacementGeometry.validateResult(
      shapes,
      result,
      packOptions,
    );
    return validation.ok ? result : unplacedResult(shapes, W, unplaced);
  }

  function unplacedResult(
    shapes: readonly ShapeInput[],
    containerWidth: number,
    existingUnplaced: readonly string[],
  ): PackResult {
    const unplaced = new Set(existingUnplaced);
    for (const shape of shapes) unplaced.add(shape.id);
    return {
      placements: [],
      containerWidth,
      containerHeight: 0,
      density: 0,
      unplaced: [...unplaced],
    };
  }

  function emptyOrganicRow(): OrganicRow {
    return {
      placements: [],
      width: 0,
      height: 0,
    };
  }

  function appendOrganicPlacement(
    row: OrganicRow,
    placement: Placement,
    gapBefore: number,
  ): OrganicRow {
    const x = row.placements.length === 0 ? 0 : row.width + gapBefore;
    const placed = PlacementGeometry.movePlacement(placement, { x, y: 0 });
    return {
      placements: [...row.placements, placed],
      width: placed.translation.x + placed.bbox.width,
      height: Math.max(row.height, placed.bbox.height),
    };
  }

  function shouldStartOrganicRow(
    row: OrganicRow,
    placement: Placement,
    gapBefore: number,
    rowTargetWidth: number,
    containerWidth: number,
    eps: number,
  ): boolean {
    if (row.placements.length === 0) return false;
    const candidateWidth = row.width + gapBefore + placement.bbox.width;
    if (candidateWidth > containerWidth + eps) return true;
    if (candidateWidth <= rowTargetWidth + eps) return false;
    const rowHasUsefulMass = row.width >=
      Math.min(rowTargetWidth * 0.58, containerWidth * 0.64);
    return rowHasUsefulMass;
  }

  function alignOrganicRow(
    row: OrganicRow,
    rowIndex: number,
    containerWidth: number,
    gapPx: number,
    seed: number,
  ): OrganicAlignedRow {
    const freeX = Math.max(0, containerWidth - row.width);
    const xStart = clampNumber(
      freeX * organicRowBias(rowIndex, seed),
      0,
      freeX,
    );
    const maxYOffset = row.placements.length <= 1
      ? 0
      : Math.min(Math.max(0, gapPx * 0.72), Math.max(0, row.height * 0.18));
    const rawOffsets = row.placements.map((_, index) =>
      maxYOffset * organicColumnWave(rowIndex, index, seed)
    );
    let minOffset = Infinity;
    for (const offset of rawOffsets) minOffset = Math.min(minOffset, offset);
    if (!Number.isFinite(minOffset)) minOffset = 0;

    const placements: Placement[] = [];
    let height = 0;
    for (let index = 0; index < row.placements.length; index++) {
      const placement = row.placements[index];
      const y = rawOffsets[index] - minOffset;
      const moved = PlacementGeometry.movePlacement(placement, {
        x: xStart,
        y,
      });
      placements.push(moved);
      height = Math.max(height, y + moved.bbox.height);
    }
    return { placements, height };
  }

  function organicOrder(
    shapes: readonly ShapeInput[],
    order: PackOrder,
    seed: number,
  ): ShapeInput[] {
    const sorted = orderedShapes(
      shapes,
      order === "as-given" ? order : "mixed-desc",
    );
    if (sorted.length < 6) return sorted;
    const largeCount = Math.ceil(sorted.length / 3);
    const mediumCount = Math.ceil((sorted.length - largeCount) / 2);
    const large = sorted.slice(0, largeCount);
    const medium = sorted.slice(largeCount, largeCount + mediumCount);
    const small = sorted.slice(largeCount + mediumCount);
    const out: ShapeInput[] = [];
    const longest = Math.max(large.length, medium.length, small.length);
    for (let index = 0; index < longest; index++) {
      const phase = positiveModulo(index + seed, 3);
      pushOrganicBucket(out, bucketAtPhase(large, medium, small, phase, index));
      pushOrganicBucket(
        out,
        bucketAtPhase(large, medium, small, phase + 1, index),
      );
      pushOrganicBucket(
        out,
        bucketAtPhase(large, medium, small, phase + 2, index),
      );
    }
    return out;
  }

  function bucketAtPhase(
    large: readonly ShapeInput[],
    medium: readonly ShapeInput[],
    small: readonly ShapeInput[],
    phase: number,
    index: number,
  ): Option<ShapeInput> {
    switch (positiveModulo(phase, 3)) {
      case 0:
        return large[index] ?? null;
      case 1:
        return small[index] ?? null;
      case 2:
        return medium[index] ?? null;
    }
    return null;
  }

  function pushOrganicBucket(
    out: ShapeInput[],
    shape: Option<ShapeInput>,
  ): void {
    if (shape) out.push(shape);
  }

  function organicGapBase(paddingPx: number): number {
    if (paddingPx <= 0) return 0;
    return Math.max(paddingPx, paddingPx * 1.22);
  }

  function organicColumnGap(
    gapPx: number,
    rowIndex: number,
    columnIndex: number,
    seed: number,
  ): number {
    if (gapPx <= 0) return 0;
    const jitter = (organicUnit(seed, rowIndex, columnIndex) - 0.5) * gapPx *
      0.32;
    return Math.max(gapPx, gapPx + jitter);
  }

  function organicRowGap(
    gapPx: number,
    rowIndex: number,
    seed: number,
  ): number {
    if (gapPx <= 0) return 0;
    const jitter = (organicUnit(seed, rowIndex, 71) - 0.5) * gapPx * 0.26;
    return Math.max(gapPx, gapPx + jitter);
  }

  function organicRowTargetWidth(
    containerWidth: number,
    paddingPx: number,
    rowIndex: number,
    seed: number,
  ): number {
    const edgePx = Math.min(
      Math.max(4, paddingPx * 0.8),
      Math.max(0, containerWidth * 0.08),
    );
    const innerWidth = Math.max(1, containerWidth - edgePx * 2);
    const fullness = 0.76 + organicUnit(seed, rowIndex, 97) * 0.2;
    return Math.min(
      containerWidth,
      Math.max(containerWidth * 0.48, innerWidth * fullness),
    );
  }

  function organicRowBias(rowIndex: number, seed: number): number {
    const biases = [0.46, 0.14, 0.74, 0.32, 0.6];
    const base = biases[positiveModulo(rowIndex + seed, biases.length)] ?? 0.46;
    const drift = (organicUnit(seed, rowIndex, 131) - 0.5) * 0.14;
    return clampNumber(base + drift, 0, 1);
  }

  function organicColumnWave(
    rowIndex: number,
    columnIndex: number,
    seed: number,
  ): number {
    const alternating = columnIndex % 2 === 0 ? 0.24 : 0.78;
    const drift = (organicUnit(seed, rowIndex, columnIndex + 173) - 0.5) * 0.26;
    return clampNumber(alternating + drift, 0, 1);
  }

  function organicUnit(
    seed: number,
    rowIndex: number,
    columnIndex: number,
  ): number {
    let state = (Math.trunc(seed) + rowIndex * 374761393 +
      columnIndex * 668265263) >>> 0;
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  }

  function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function positiveModulo(value: number, modulus: number): number {
    return ((Math.trunc(value) % modulus) + modulus) % modulus;
  }

  function firstFittingPlacement(
    shape: ShapeInput,
    rotationsDeg: readonly number[],
    paddingPx: number,
    eps: number,
    containerWidth: number,
  ): Option<Placement> {
    for (const rotationDeg of rotationsDeg) {
      const placement = PlacementGeometry.makePlacement(
        shape,
        { x: 0, y: 0 },
        rotationDeg,
        paddingPx,
        eps,
      );
      if (placement && placement.bbox.width <= containerWidth + eps) {
        return placement;
      }
    }
    return null;
  }

  function orderedShapes(
    shapes: readonly ShapeInput[],
    order: PackOrder,
  ): ShapeInput[] {
    if (order === "as-given") return shapes.slice();
    const sorted = shapes.slice().sort((a, b) => {
      const da = shapeMetric(a, order);
      const db = shapeMetric(b, order);
      if (Math.abs(db - da) > 1e-9) return db - da;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (order !== "mixed-desc" || sorted.length < 4) return sorted;
    const out: ShapeInput[] = [];
    const midpoint = Math.ceil(sorted.length / 2);
    for (let index = 0; index < midpoint; index++) {
      const large = sorted[index] ?? null;
      const medium = sorted[index + midpoint] ?? null;
      if (large) out.push(large);
      if (medium) out.push(medium);
    }
    return out;
  }

  function shapeMetric(shape: ShapeInput, order: PackOrder): number {
    const polygon = shape.calculationPolygon ?? shape.polygon;
    const bounds = Geometry.bounds(polygon);
    switch (order) {
      case "height-desc":
        return bounds.height;
      case "bbox-area-desc":
      case "mixed-desc":
        return bounds.width * bounds.height;
      case "area-desc":
      case "as-given":
        return Geometry.area(polygon);
    }
  }

  function prepareCalculation(
    shapes: readonly ShapeInput[],
    packOptions: PackOptions,
  ): PreparedCalculation {
    const geometry = packOptions.geometry ?? {};
    const enabled = geometry.enabled ?? true;
    const gapPx = Math.max(0, packOptions.paddingPx ?? 4);
    const tolerancePx = Math.max(
      0,
      geometry.simplifyTolerancePx ?? Math.min(2, Math.max(0.75, gapPx * 0.12)),
    );
    const minVertices = Math.max(3, Math.trunc(geometry.minVertices ?? 4));
    const maxAreaDeltaRatio = Math.max(0, geometry.maxAreaDeltaRatio ?? 0.06);
    const prepared: ShapeInput[] = [];
    let originalVertexCount = 0;
    let calculationVertexCount = 0;
    let simplifiedShapeCount = 0;
    let simplificationFallbackCount = 0;

    for (const shape of shapes) {
      originalVertexCount += shape.polygon.length;
      const suppliedCalculationPolygon = shape.calculationPolygon ?? null;
      if (!enabled) {
        const calculationPolygon = suppliedCalculationPolygon ?? shape.polygon;
        calculationVertexCount += calculationPolygon.length;
        prepared.push({ ...shape, calculationPolygon });
        continue;
      }
      if (suppliedCalculationPolygon) {
        calculationVertexCount += suppliedCalculationPolygon.length;
        prepared.push({
          ...shape,
          calculationPolygon: suppliedCalculationPolygon,
        });
        continue;
      }

      const simplified = Geometry.simplifyClosedPolygon(shape.polygon, {
        tolerancePx,
        minVertices,
        maxAreaDeltaRatio,
      });
      calculationVertexCount += simplified.polygon.length;
      if (simplified.simplified) simplifiedShapeCount++;
      if (simplified.fallbackReason) simplificationFallbackCount++;
      prepared.push({
        ...shape,
        calculationPolygon: simplified.polygon,
      });
    }

    return {
      shapes: prepared,
      diagnostics: {
        originalVertexCount,
        calculationVertexCount,
        simplifiedShapeCount,
        simplificationFallbackCount,
        reorderId: packOptions.order ?? "area-desc",
      },
    };
  }

  function emptyDiagnostics(
    prepared: PreparedCalculation["diagnostics"],
  ): MutableDiagnostics {
    return {
      originalVertexCount: prepared.originalVertexCount,
      calculationVertexCount: prepared.calculationVertexCount,
      simplifiedShapeCount: prepared.simplifiedShapeCount,
      simplificationFallbackCount: prepared.simplificationFallbackCount,
      metricEvaluations: 0,
      gridAlignmentPenalty: 0,
      balancePenalty: 0,
      organicScore: 0,
      reorderId: prepared.reorderId,
    };
  }

  function applyAestheticDiagnostics(
    diagnostics: MutableDiagnostics,
    result: PackResult,
  ): void {
    const aesthetic = aestheticDiagnostics(result);
    diagnostics.gridAlignmentPenalty = aesthetic.gridAlignmentPenalty;
    diagnostics.balancePenalty = aesthetic.balancePenalty;
    diagnostics.organicScore = aesthetic.organicScore;
  }

  function aestheticDiagnostics(result: PackResult): AestheticDiagnostics {
    if (result.placements.length < 2) {
      return {
        gridAlignmentPenalty: 0,
        balancePenalty: 0,
        organicScore: 0,
      };
    }

    let alignedPairs = 0;
    let pairs = 0;
    const tolerancePx = 2;
    for (let i = 0; i < result.placements.length; i++) {
      const a = result.placements[i];
      for (let j = i + 1; j < result.placements.length; j++) {
        const b = result.placements[j];
        pairs++;
        if (
          Math.abs(a.translation.x - b.translation.x) <= tolerancePx ||
          Math.abs(a.translation.y - b.translation.y) <= tolerancePx ||
          Math.abs(centerX(a) - centerX(b)) <= tolerancePx
        ) {
          alignedPairs++;
        }
      }
    }

    const gridAlignmentPenalty = alignedPairs / Math.max(1, pairs);
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    for (const placement of result.placements) {
      const weight = Math.max(1, placement.bbox.width * placement.bbox.height);
      weightedX += centerX(placement) * weight;
      weightedY += centerY(placement) * weight;
      totalWeight += weight;
    }
    const balancePenalty = Math.abs(
          weightedX / totalWeight -
            result.containerWidth / 2,
        ) / Math.max(1, result.containerWidth) +
      Math.abs(weightedY / totalWeight - result.containerHeight / 2) /
        Math.max(1, result.containerHeight);
    return {
      gridAlignmentPenalty,
      balancePenalty,
      organicScore: gridAlignmentPenalty * 100 + balancePenalty * 40,
    };
  }

  function centerX(placement: Placement): number {
    return placement.translation.x + placement.bbox.width / 2;
  }

  function centerY(placement: Placement): number {
    return placement.translation.y + placement.bbox.height / 2;
  }

  function nowMs(): number {
    return performance.now();
  }
}
