import type { Point } from "@tento-core/point";

import { Geometry } from "./geometry";
import type {
  PackOptions,
  PackResult,
  Placement,
  Polygon,
  ShapeInput,
} from "./types";

/**
 * Shared placement reconstruction helpers for packer strategies, evals, and
 * tests. These functions mirror the public `Placement` render metadata: raw
 * cutouts are spaced by inflated collision bodies, while visual content follows
 * `contentTranslation` and `contentOffset`.
 */
export namespace PlacementGeometry {
  export type Validation = {
    ok: boolean;
    collisionCount: number;
    outOfBoundsCount: number;
    topOffsetPx: number;
  };

  export function resolvedPaddingPx(options: PackOptions): number {
    return options.paddingPx ?? 4;
  }

  export function resolvedEpsilon(options: PackOptions): number {
    return options.epsilon ?? Geometry.EPS;
  }

  export function rawPolygonForPlacement(
    polygon: Polygon,
    placement: Placement,
  ): Point[] {
    const shifted = Geometry.translate(polygon, placement.contentOffset);
    const rotated = placement.rotationDeg === 0
      ? shifted
      : Geometry.rotate(shifted, placement.rotationDeg, { x: 0, y: 0 });
    return Geometry.translate(rotated, placement.contentTranslation);
  }

  export function collisionBodyForPlacement(
    polygon: Polygon,
    placement: Placement,
    paddingPx: number,
    eps: number,
  ): Point[] {
    const base = Geometry.normalizeToOrigin(Geometry.ensureCcw(polygon));
    const rotated = placement.rotationDeg === 0
      ? base
      : Geometry.rotate(base, placement.rotationDeg, { x: 0, y: 0 });
    const reNorm = Geometry.normalizeToOrigin(rotated);
    const body = Geometry.normalizeToOrigin(
      Geometry.inflate(reNorm, paddingPx / 2, eps),
    );
    return Geometry.translate(body, placement.translation);
  }

  export function makePlacement(
    shape: ShapeInput,
    translation: Point,
    rotationDeg: number,
    paddingPx: number,
    eps: number,
  ): Option<Placement> {
    const raw = Geometry.ensureCcw(shape.polygon);
    const rawBounds = Geometry.bounds(raw);
    const calculation = calculationPolygon(shape);
    const calculationBounds = Geometry.bounds(calculation);
    const base = Geometry.translate(calculation, {
      x: -calculationBounds.minX,
      y: -calculationBounds.minY,
    });
    if (base.length < 3 || Geometry.area(base) < eps) return null;

    const rotated = rotationDeg === 0
      ? base
      : Geometry.rotate(base, rotationDeg, { x: 0, y: 0 });
    const rotatedBounds = Geometry.bounds(rotated);
    const reNorm = Geometry.translate(rotated, {
      x: -rotatedBounds.minX,
      y: -rotatedBounds.minY,
    });
    const inflated = Geometry.inflate(reNorm, paddingPx / 2, eps);
    const inflatedBounds = Geometry.bounds(inflated);
    const body = Geometry.translate(inflated, {
      x: -inflatedBounds.minX,
      y: -inflatedBounds.minY,
    });

    return {
      id: shape.id,
      translation: {
        x: translation.x,
        y: translation.y,
      },
      contentTranslation: {
        x: translation.x - rotatedBounds.minX - inflatedBounds.minX,
        y: translation.y - rotatedBounds.minY - inflatedBounds.minY,
      },
      contentOffset: {
        x: -rawBounds.minX,
        y: -rawBounds.minY,
      },
      rotationDeg,
      bbox: Geometry.bounds(body),
    };
  }

  export function copyPlacement(placement: Placement): Placement {
    return {
      id: placement.id,
      translation: {
        x: placement.translation.x,
        y: placement.translation.y,
      },
      contentTranslation: {
        x: placement.contentTranslation.x,
        y: placement.contentTranslation.y,
      },
      contentOffset: {
        x: placement.contentOffset.x,
        y: placement.contentOffset.y,
      },
      rotationDeg: placement.rotationDeg,
      bbox: {
        width: placement.bbox.width,
        height: placement.bbox.height,
      },
    };
  }

  export function movePlacement(
    placement: Placement,
    delta: Point,
  ): Placement {
    const copy = copyPlacement(placement);
    copy.translation = {
      x: copy.translation.x + delta.x,
      y: copy.translation.y + delta.y,
    };
    copy.contentTranslation = {
      x: copy.contentTranslation.x + delta.x,
      y: copy.contentTranslation.y + delta.y,
    };
    return copy;
  }

  export function copyResult(result: PackResult): PackResult {
    return {
      placements: result.placements.map((placement) => copyPlacement(placement)),
      containerWidth: result.containerWidth,
      containerHeight: result.containerHeight,
      density: result.density,
      unplaced: result.unplaced.slice(),
    };
  }

  export function resultWithPlacements(
    shapes: readonly ShapeInput[],
    base: PackResult,
    placements: readonly Placement[],
  ): PackResult {
    const normalized = normalizeTop(placements);
    const containerHeight = placementHeight(normalized);
    const totalArea = placedArea(shapes, normalized);
    return {
      placements: normalized,
      containerWidth: base.containerWidth,
      containerHeight,
      density: containerHeight > 0
        ? totalArea / (base.containerWidth * containerHeight)
        : 0,
      unplaced: base.unplaced.slice(),
    };
  }

  export function validateResult(
    shapes: readonly ShapeInput[],
    result: PackResult,
    options: PackOptions,
  ): Validation {
    const calculationById = new Map(shapes.map((shape) => [
      shape.id,
      calculationPolygon(shape),
    ]));
    const paddingPx = resolvedPaddingPx(options);
    const eps = resolvedEpsilon(options);
    const bodies: Point[][] = [];
    let outOfBoundsCount = 0;
    let topOffsetPx = Infinity;

    for (const placement of result.placements) {
      const polygon = calculationById.get(placement.id) ?? null;
      if (!polygon) {
        outOfBoundsCount++;
        continue;
      }
      const body = collisionBodyForPlacement(polygon, placement, paddingPx, eps);
      const bounds = Geometry.bounds(body);
      topOffsetPx = Math.min(topOffsetPx, bounds.minY);
      if (bounds.minX < -eps || bounds.maxX > result.containerWidth + eps) {
        outOfBoundsCount++;
      }
      if (bounds.minY < -eps) {
        outOfBoundsCount++;
      }
      bodies.push(body);
    }

    let collisionCount = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (Geometry.polygonsOverlap(bodies[i], bodies[j], eps)) {
          collisionCount++;
        }
      }
    }

    return {
      ok: collisionCount === 0 && outOfBoundsCount === 0,
      collisionCount,
      outOfBoundsCount,
      topOffsetPx: Number.isFinite(topOffsetPx) ? topOffsetPx : 0,
    };
  }

  export function placementHeight(placements: readonly Placement[]): number {
    let height = 0;
    for (const placement of placements) {
      height = Math.max(height, placement.translation.y + placement.bbox.height);
    }
    return height;
  }

  export function normalizeTop(
    placements: readonly Placement[],
  ): Placement[] {
    let top = Infinity;
    for (const placement of placements) {
      top = Math.min(top, placement.translation.y);
    }
    const offset = Number.isFinite(top) ? top : 0;
    if (Math.abs(offset) < 1e-9) {
      return placements.map((placement) => copyPlacement(placement));
    }
    return placements.map((placement) =>
      movePlacement(placement, { x: 0, y: -offset })
    );
  }

  function placedArea(
    shapes: readonly ShapeInput[],
    placements: readonly Placement[],
  ): number {
    const placedIds = new Set(placements.map((placement) => placement.id));
    let area = 0;
    for (const shape of shapes) {
      if (!placedIds.has(shape.id)) continue;
      area += Geometry.area(Geometry.normalizeToOrigin(shape.polygon));
    }
    return area;
  }

  function calculationPolygon(shape: ShapeInput): Point[] {
    return Geometry.ensureCcw(shape.calculationPolygon ?? shape.polygon);
  }
}
