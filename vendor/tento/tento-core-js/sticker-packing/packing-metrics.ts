import type { Point } from "@tento-core/point";

import { Geometry } from "./geometry";
import { PlacementGeometry } from "./placement-geometry";
import type { PackOptions, PackResult, Polygon, ShapeInput } from "./types";

/**
 * DOM-free whitespace scoring for sticker packing. The metric intentionally
 * looks at a coarse black/white field, because the visual target is evenly
 * distributed empty space at a zoomed-out scale rather than perfect density.
 */
export namespace PackingMetrics {
  export type Options = Optional<{
    gapPx: number;
    windowPx: number;
    baselineHeightPx: number;
  }>;

  export type Result = {
    smoothNoiseScore: number;
    localEmptyVariance: number;
    largestEmptyRegionRatio: number;
    maxEmptyRadiusPx: number;
    meanEmptyFraction: number;
    heightRatio: number;
    windowPx: number;
    collisionCount: number;
    outOfBoundsCount: number;
    hotspotCenter: Point;
  };

  type Cell = {
    col: number;
    row: number;
    center: Point;
    emptyFraction: number;
  };

  export function score(
    shapes: readonly ShapeInput[],
    result: PackResult,
    packOptions: PackOptions,
    options: Options,
  ): Result {
    const validation = PlacementGeometry.validateResult(
      shapes,
      result,
      packOptions,
    );
    const windowPx = resolvedWindowPx(packOptions, options);
    const polygons = placedPolygons(shapes, result);
    const cells = rasterCells(result, polygons, windowPx);
    const meanEmptyFraction = mean(cells.map((cell) => cell.emptyFraction));
    const localEmptyVariance = variance(
      cells.map((cell) => cell.emptyFraction),
      meanEmptyFraction,
    );
    const largestEmptyRegionRatio = largestEmptyRegion(cells);
    const maxEmptyRadiusPx = maxEmptyRadius(cells, windowPx);
    const baselineHeightPx = options.baselineHeightPx ?? result.containerHeight;
    const heightRatio = baselineHeightPx > 0
      ? result.containerHeight / baselineHeightPx
      : 1;
    const norm = Math.max(result.containerWidth, result.containerHeight, 1);
    const validationPenalty = (validation.collisionCount +
      validation.outOfBoundsCount) * 1000;
    const heightPenalty = Math.max(0, heightRatio - 1) * 20;
    const smoothNoiseScore = validationPenalty +
      localEmptyVariance * 100 +
      largestEmptyRegionRatio * 25 +
      (maxEmptyRadiusPx / norm) * 25 +
      heightPenalty;

    return {
      smoothNoiseScore,
      localEmptyVariance,
      largestEmptyRegionRatio,
      maxEmptyRadiusPx,
      meanEmptyFraction,
      heightRatio,
      windowPx,
      collisionCount: validation.collisionCount,
      outOfBoundsCount: validation.outOfBoundsCount,
      hotspotCenter: hotspotCenter(cells),
    };
  }

  function resolvedWindowPx(
    packOptions: PackOptions,
    options: Options,
  ): number {
    const gapPx = Math.max(
      0,
      options.gapPx ?? packOptions.paddingPx ?? 4,
    );
    const requested = options.windowPx ?? Math.max(24, gapPx * 3);
    if (!Number.isFinite(requested) || requested <= 0) return 24;
    return Math.max(8, requested);
  }

  function placedPolygons(
    shapes: readonly ShapeInput[],
    result: PackResult,
  ): Point[][] {
    const byId = new Map(shapes.map((shape) => [
      shape.id,
      shape.calculationPolygon ?? shape.polygon,
    ]));
    const out: Point[][] = [];
    for (const placement of result.placements) {
      const polygon = byId.get(placement.id) ?? null;
      if (!polygon) continue;
      out.push(PlacementGeometry.rawPolygonForPlacement(polygon, placement));
    }
    return out;
  }

  function rasterCells(
    result: PackResult,
    polygons: readonly Polygon[],
    windowPx: number,
  ): Cell[] {
    const cols = Math.max(1, Math.ceil(result.containerWidth / windowPx));
    const rows = Math.max(1, Math.ceil(result.containerHeight / windowPx));
    const cells: Cell[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const minX = col * windowPx;
        const minY = row * windowPx;
        const maxX = Math.min(result.containerWidth, minX + windowPx);
        const maxY = Math.min(result.containerHeight, minY + windowPx);
        const emptyFraction = sampledEmptyFraction(
          polygons,
          minX,
          minY,
          maxX,
          maxY,
        );
        cells.push({
          col,
          row,
          center: {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
          },
          emptyFraction,
        });
      }
    }
    return cells;
  }

  function sampledEmptyFraction(
    polygons: readonly Polygon[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): number {
    let empty = 0;
    let total = 0;
    for (let yi = 0; yi < 3; yi++) {
      for (let xi = 0; xi < 3; xi++) {
        total++;
        const point = {
          x: minX + ((xi + 0.5) / 3) * (maxX - minX),
          y: minY + ((yi + 0.5) / 3) * (maxY - minY),
        };
        if (!occupied(point, polygons)) empty++;
      }
    }
    return total > 0 ? empty / total : 1;
  }

  function occupied(point: Point, polygons: readonly Polygon[]): boolean {
    for (const polygon of polygons) {
      if (Geometry.pointInPolygon(point, polygon, Geometry.EPS)) return true;
    }
    return false;
  }

  function largestEmptyRegion(cells: readonly Cell[]): number {
    if (cells.length === 0) return 0;
    const byKey = new Map<string, Cell>();
    const visited = new Set<string>();
    for (const cell of cells) {
      byKey.set(cellKey(cell.col, cell.row), cell);
    }

    let largest = 0;
    for (const cell of cells) {
      const key = cellKey(cell.col, cell.row);
      if (visited.has(key) || cell.emptyFraction < 0.72) continue;
      const size = floodEmptyRegion(cell, byKey, visited);
      largest = Math.max(largest, size);
    }
    return largest / cells.length;
  }

  function floodEmptyRegion(
    start: Cell,
    byKey: Map<string, Cell>,
    visited: Set<string>,
  ): number {
    const stack: Cell[] = [start];
    let size = 0;
    while (stack.length > 0) {
      const cell = stack.pop() ?? null;
      if (!cell) continue;
      const key = cellKey(cell.col, cell.row);
      if (visited.has(key)) continue;
      visited.add(key);
      if (cell.emptyFraction < 0.72) continue;
      size++;
      for (const next of neighbours(cell, byKey)) {
        const nextKey = cellKey(next.col, next.row);
        if (!visited.has(nextKey)) stack.push(next);
      }
    }
    return size;
  }

  function neighbours(
    cell: Cell,
    byKey: Map<string, Cell>,
  ): Cell[] {
    const out: Cell[] = [];
    const offsets: Point[] = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    for (const offset of offsets) {
      const next = byKey.get(cellKey(cell.col + offset.x, cell.row + offset.y)) ??
        null;
      if (next) out.push(next);
    }
    return out;
  }

  function maxEmptyRadius(cells: readonly Cell[], windowPx: number): number {
    const occupiedCells = cells.filter((cell) => cell.emptyFraction <= 0.35);
    if (occupiedCells.length === 0) {
      return Math.sqrt(cells.length) * windowPx;
    }

    let radius = 0;
    for (const cell of cells) {
      if (cell.emptyFraction < 0.65) continue;
      let nearest = Infinity;
      for (const occupiedCell of occupiedCells) {
        nearest = Math.min(
          nearest,
          Math.hypot(
            cell.center.x - occupiedCell.center.x,
            cell.center.y - occupiedCell.center.y,
          ),
        );
      }
      if (Number.isFinite(nearest)) radius = Math.max(radius, nearest);
    }
    return radius;
  }

  function hotspotCenter(cells: readonly Cell[]): Point {
    if (cells.length === 0) return { x: 0, y: 0 };
    let best = cells[0];
    for (const cell of cells) {
      if (cell.emptyFraction > best.emptyFraction) best = cell;
    }
    return best.center;
  }

  function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length;
  }

  function variance(values: readonly number[], meanValue: number): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const value of values) sum += (value - meanValue) ** 2;
    return sum / values.length;
  }

  function cellKey(col: number, row: number): string {
    return `${col}:${row}`;
  }
}
