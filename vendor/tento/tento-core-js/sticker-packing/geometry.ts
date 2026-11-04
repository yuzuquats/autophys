import type { Point } from "@tento-core/point";

import type { Bounds, Polygon } from "./types";

/**
 * Pure 2D polygon primitives for silhouette packing. No DOM, no state.
 *
 * Conventions:
 * - Polygons are simple (non-self-intersecting), closed implicitly (no repeated
 *   final vertex), and — once normalized via `ensureCcw` — wound counter-
 *   clockwise so "interior is to the left of each edge".
 * - Tolerance `eps` is passed explicitly where it matters; `Geometry.EPS` is the
 *   module default a caller can thread through.
 */
export namespace Geometry {
  export const EPS = 1e-4;

  export type SimplifyClosedPolygonOptions = Optional<{
    tolerancePx: number;
    minVertices: number;
    maxAreaDeltaRatio: number;
    preserveBoundsEpsilon: number;
    epsilon: number;
  }>;

  export type SimplifyClosedPolygonResult = {
    polygon: Point[];
    simplified: boolean;
    originalVertexCount: number;
    simplifiedVertexCount: number;
    areaDeltaRatio: number;
    fallbackReason: Option<
      | "disabled"
      | "too-few-vertices"
      | "degenerate-area"
      | "bounds-changed"
      | "area-delta"
      | "self-intersection"
    >;
  };

  /** z-component of (b-o) × (c-o). >0 ⇒ left turn (CCW), <0 ⇒ right turn. */
  export function cross(o: Point, b: Point, c: Point): number {
    return (b.x - o.x) * (c.y - o.y) - (b.y - o.y) * (c.x - o.x);
  }

  /** Twice the signed area (shoelace). >0 ⇒ CCW winding. */
  export function signedArea2(poly: Polygon): number {
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum;
  }

  export function area(poly: Polygon): number {
    return Math.abs(signedArea2(poly)) / 2;
  }

  export function isCcw(poly: Polygon): boolean {
    return signedArea2(poly) > 0;
  }

  /** Returns the polygon wound CCW (reversing a copy when it is CW). */
  export function ensureCcw(poly: Polygon): Point[] {
    const copy = poly.map((p) => ({ x: p.x, y: p.y }));
    return signedArea2(copy) >= 0 ? copy : copy.reverse();
  }

  /** Area-weighted centroid. Falls back to the vertex mean for degenerate area. */
  export function centroid(poly: Polygon): Point {
    let a2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const f = p.x * q.y - q.x * p.y;
      a2 += f;
      cx += (p.x + q.x) * f;
      cy += (p.y + q.y) * f;
    }
    if (Math.abs(a2) < EPS) {
      const mean = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), {
        x: 0,
        y: 0,
      });
      return { x: mean.x / poly.length, y: mean.y / poly.length };
    }
    return { x: cx / (3 * a2), y: cy / (3 * a2) };
  }

  export function bounds(poly: Polygon): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  export function boundsOverlap(a: Bounds, b: Bounds, eps: number): boolean {
    return a.minX < b.maxX - eps &&
      b.minX < a.maxX - eps &&
      a.minY < b.maxY - eps &&
      b.minY < a.maxY - eps;
  }

  export function translate(poly: Polygon, d: Point): Point[] {
    return poly.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
  }

  /** Rotate CCW by `deg` about `about`. */
  export function rotate(poly: Polygon, deg: number, about: Point): Point[] {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return poly.map((p) => {
      const dx = p.x - about.x;
      const dy = p.y - about.y;
      return {
        x: about.x + dx * cos - dy * sin,
        y: about.y + dx * sin + dy * cos,
      };
    });
  }

  /** Reflect through `about` (point negation): p ↦ 2·about − p. */
  export function negate(poly: Polygon, about: Point): Point[] {
    return poly.map((p) => ({ x: 2 * about.x - p.x, y: 2 * about.y - p.y }));
  }

  /** Translate so the polygon's bbox min corner sits at the origin. */
  export function normalizeToOrigin(poly: Polygon): Point[] {
    const b = bounds(poly);
    return translate(poly, { x: -b.minX, y: -b.minY });
  }

  /**
   * Strict point-in-polygon (interior only — points on the boundary return
   * false). Ray casting with an explicit on-edge guard.
   */
  export function pointInPolygon(
    pt: Point,
    poly: Polygon,
    eps: number,
  ): boolean {
    // On-boundary ⇒ not strictly inside.
    for (let i = 0; i < poly.length; i++) {
      if (pointOnSegment(pt, poly[i], poly[(i + 1) % poly.length], eps)) {
        return false;
      }
    }
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      const straddles = (a.y > pt.y) !== (b.y > pt.y);
      if (!straddles) continue;
      const xCross = ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
      if (pt.x < xCross) inside = !inside;
    }
    return inside;
  }

  export function pointOnSegment(
    pt: Point,
    a: Point,
    b: Point,
    eps: number,
  ): boolean {
    const crossv = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (Math.abs(crossv) > eps * segLength(a, b)) return false;
    const dot = (pt.x - a.x) * (b.x - a.x) + (pt.y - a.y) * (b.y - a.y);
    if (dot < -eps) return false;
    const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    return dot <= lenSq + eps;
  }

  function segLength(a: Point, b: Point): number {
    return Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  }

  /**
   * Proper segment intersection: true only when the two open segments cross
   * (shared endpoints / collinear touching do NOT count). Used by the overlap
   * test, where touching must read as "not overlapping".
   */
  export function segmentsProperlyCross(
    a1: Point,
    a2: Point,
    b1: Point,
    b2: Point,
    eps: number,
  ): boolean {
    const d1 = orient(b1, b2, a1, eps);
    const d2 = orient(b1, b2, a2, eps);
    const d3 = orient(a1, a2, b1, eps);
    const d4 = orient(a1, a2, b2, eps);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }

  /** Sign of the turn a→b→c: -1 right, 0 collinear (within eps), +1 left. */
  export function orient(a: Point, b: Point, c: Point, eps: number): number {
    const v = cross(a, b, c);
    if (v > eps) return 1;
    if (v < -eps) return -1;
    return 0;
  }

  /**
   * Intersection point of two segments if they intersect at a single point
   * (including at endpoints). Returns null for parallel / non-intersecting.
   * Used for candidate generation (wants touch points too).
   */
  export function segmentIntersectionPoint(
    a1: Point,
    a2: Point,
    b1: Point,
    b2: Point,
    eps: number,
  ): Option<Point> {
    const rx = a2.x - a1.x;
    const ry = a2.y - a1.y;
    const sx = b2.x - b1.x;
    const sy = b2.y - b1.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < eps) return null; // parallel or degenerate
    const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / denom;
    const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / denom;
    if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
    return { x: a1.x + t * rx, y: a1.y + t * ry };
  }

  /**
   * True iff the interiors of two simple polygons intersect. Touching boundaries
   * (shared edge/vertex, one tangent to the other) return false — that is what
   * lets packed shapes sit flush. Cheap-to-expensive with bbox + edge-cross +
   * containment.
   */
  export function polygonsOverlap(a: Polygon, b: Polygon, eps: number): boolean {
    if (!boundsOverlap(bounds(a), bounds(b), eps)) return false;
    // Decompose into convex pieces and test each pair via SAT. This is robust
    // for the degenerate axis-aligned / coincident-coordinate cases that the
    // edge-crossing test misses (two squares overlapping along a shared axis
    // span have no properly-crossing edges and no vertex strictly inside).
    const aPieces = convexDecompose(a, eps);
    const bPieces = convexDecompose(b, eps);
    for (const pa of aPieces) {
      const ba = bounds(pa);
      for (const pb of bPieces) {
        if (boundsOverlap(ba, bounds(pb), eps) && convexOverlap(pa, pb, eps)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * True iff two CONVEX polygons' interiors intersect, via the Separating Axis
   * Theorem. Touching (projection overlap ≤ eps on some edge normal) counts as
   * separated — packed shapes may sit flush. The packer pre-decomposes shapes
   * and calls this per convex-piece pair to avoid re-decomposition.
   */
  export function convexOverlap(a: Polygon, b: Polygon, eps: number): boolean {
    return !hasSeparatingAxis(a, b, eps) && !hasSeparatingAxis(b, a, eps);
  }

  function hasSeparatingAxis(from: Polygon, other: Polygon, eps: number): boolean {
    for (let i = 0; i < from.length; i++) {
      const p = from[i];
      const q = from[(i + 1) % from.length];
      let ax = -(q.y - p.y);
      let ay = q.x - p.x;
      const len = Math.hypot(ax, ay);
      if (len < 1e-9) continue;
      ax /= len;
      ay /= len;
      const [minA, maxA] = project(from, ax, ay);
      const [minB, maxB] = project(other, ax, ay);
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= eps) return true;
    }
    return false;
  }

  function project(poly: Polygon, ax: number, ay: number): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (const v of poly) {
      const d = v.x * ax + v.y * ay;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return [min, max];
  }

  /** Andrew's monotone chain convex hull, returned CCW. */
  export function convexHull(points: ReadonlyArray<Point>): Point[] {
    const pts = points
      .map((p) => ({ x: p.x, y: p.y }))
      .sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
    if (pts.length <= 2) return pts;
    const half = (src: Point[]): Point[] => {
      const out: Point[] = [];
      for (const p of src) {
        while (
          out.length >= 2 &&
          cross(out[out.length - 2], out[out.length - 1], p) <= 0
        ) {
          out.pop();
        }
        out.push(p);
      }
      out.pop();
      return out;
    };
    const lower = half(pts);
    const upper = half([...pts].reverse());
    return lower.concat(upper);
  }

  /**
   * Decompose a simple polygon into convex pieces. Ear-clipping triangulation
   * (each triangle is convex), then a Hertel–Mehlhorn merge that removes a
   * shared diagonal whenever the union stays convex. Correctness downstream only
   * needs convex pieces; the merge just reduces their count.
   */
  export function convexDecompose(poly: Polygon, eps: number): Point[][] {
    const triangles = earClip(poly, eps);
    return hertelMehlhorn(triangles, eps);
  }

  function earClip(poly: Polygon, eps: number): Point[][] {
    const verts = ensureCcw(poly);
    const n = verts.length;
    if (n < 3) return [];
    if (n === 3) return [verts];
    const indices: number[] = [];
    for (let i = 0; i < n; i++) indices.push(i);
    const triangles: Point[][] = [];
    let guard = 0;
    const guardMax = n * n + 16;
    while (indices.length > 3 && guard++ < guardMax) {
      let clipped = false;
      for (let i = 0; i < indices.length; i++) {
        const iPrev = indices[(i - 1 + indices.length) % indices.length];
        const iCur = indices[i];
        const iNext = indices[(i + 1) % indices.length];
        const a = verts[iPrev];
        const b = verts[iCur];
        const c = verts[iNext];
        if (cross(a, b, c) <= eps) continue; // reflex or collinear ⇒ not an ear
        let containsOther = false;
        for (const k of indices) {
          if (k === iPrev || k === iCur || k === iNext) continue;
          if (pointInTriangle(verts[k], a, b, c, eps)) {
            containsOther = true;
            break;
          }
        }
        if (containsOther) continue;
        triangles.push([a, b, c]);
        indices.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break; // degenerate; bail with what we have
    }
    if (indices.length === 3) {
      triangles.push([verts[indices[0]], verts[indices[1]], verts[indices[2]]]);
    }
    return triangles;
  }

  function pointInTriangle(
    p: Point,
    a: Point,
    b: Point,
    c: Point,
    eps: number,
  ): boolean {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    const hasNeg = d1 < -eps || d2 < -eps || d3 < -eps;
    const hasPos = d1 > eps || d2 > eps || d3 > eps;
    return !(hasNeg && hasPos);
  }

  /**
   * Greedily merge adjacent convex pieces sharing an edge when the result stays
   * convex. O(pieces²) passes; fine for the small piece counts of simplified
   * sticker silhouettes.
   */
  function hertelMehlhorn(pieces: Point[][], eps: number): Point[][] {
    let current = pieces.map((p) => p.slice());
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < current.length; i++) {
        for (let j = i + 1; j < current.length; j++) {
          const union = mergeIfConvex(current[i], current[j], eps);
          if (!union) continue;
          current = current.filter((_, k) => k !== i && k !== j);
          current.push(union);
          merged = true;
          break outer;
        }
      }
    }
    return current;
  }

  /** Merge two convex polygons sharing exactly one edge, iff the result is convex. */
  function mergeIfConvex(a: Point[], b: Point[], eps: number): Option<Point[]> {
    for (let i = 0; i < a.length; i++) {
      const a1 = a[i];
      const a2 = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        const b1 = b[j];
        const b2 = b[(j + 1) % b.length];
        // Shared edge appears reversed in the neighbouring polygon.
        if (samePoint(a1, b2, eps) && samePoint(a2, b1, eps)) {
          const ring: Point[] = [];
          for (let k = 0; k < a.length; k++) ring.push(a[(i + 1 + k) % a.length]);
          for (let k = 1; k < b.length - 1; k++) {
            ring.push(b[(j + 1 + k) % b.length]);
          }
          return isConvex(ring, eps) ? ring : null;
        }
      }
    }
    return null;
  }

  export function isConvex(poly: Polygon, eps: number): boolean {
    if (poly.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const v = cross(
        poly[i],
        poly[(i + 1) % poly.length],
        poly[(i + 2) % poly.length],
      );
      if (v > eps) {
        if (sign < 0) return false;
        sign = 1;
      } else if (v < -eps) {
        if (sign > 0) return false;
        sign = -1;
      }
    }
    return true;
  }

  export function samePoint(a: Point, b: Point, eps: number): boolean {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  export function simplifyClosedPolygon(
    poly: Polygon,
    options: SimplifyClosedPolygonOptions,
  ): SimplifyClosedPolygonResult {
    const eps = options.epsilon ?? EPS;
    const tolerancePx = Math.max(0, options.tolerancePx ?? 0);
    const original = dedupeRing(ensureCcw(poly), eps);
    const originalArea = area(original);
    const fallback = (
      reason: NonNullable<SimplifyClosedPolygonResult["fallbackReason"]>,
    ): SimplifyClosedPolygonResult => ({
      polygon: original,
      simplified: false,
      originalVertexCount: original.length,
      simplifiedVertexCount: original.length,
      areaDeltaRatio: 0,
      fallbackReason: reason,
    });

    if (tolerancePx <= eps) return fallback("disabled");
    if (original.length < 3) return fallback("too-few-vertices");
    if (originalArea <= eps) return fallback("degenerate-area");

    const minVertices = Math.max(3, Math.trunc(options.minVertices ?? 4));
    const protectedIndexes = protectedVertexIndexes(original);
    const simplified = simplifyRingByDistance(
      original,
      tolerancePx,
      minVertices,
      protectedIndexes,
    );
    const simplifiedCcw = ensureCcw(simplified);
    if (simplifiedCcw.length < minVertices) return fallback("too-few-vertices");

    const preserveBoundsEpsilon = Math.max(
      eps,
      options.preserveBoundsEpsilon ?? Math.max(eps, tolerancePx * 0.25),
    );
    if (!boundsAlmostEqual(bounds(original), bounds(simplifiedCcw), preserveBoundsEpsilon)) {
      return fallback("bounds-changed");
    }

    const simplifiedArea = area(simplifiedCcw);
    if (simplifiedArea <= eps) return fallback("degenerate-area");
    const areaDeltaRatio = Math.abs(simplifiedArea - originalArea) / originalArea;
    const maxAreaDeltaRatio = Math.max(0, options.maxAreaDeltaRatio ?? 0.06);
    if (areaDeltaRatio > maxAreaDeltaRatio) return fallback("area-delta");
    if (hasSelfIntersection(simplifiedCcw, eps)) return fallback("self-intersection");

    return {
      polygon: simplifiedCcw,
      simplified: simplifiedCcw.length < original.length,
      originalVertexCount: original.length,
      simplifiedVertexCount: simplifiedCcw.length,
      areaDeltaRatio,
      fallbackReason: null,
    };
  }

  function simplifyRingByDistance(
    ring: readonly Point[],
    tolerancePx: number,
    minVertices: number,
    protectedIndexes: ReadonlySet<number>,
  ): Point[] {
    const keep = new Set<number>(protectedIndexes);
    if (keep.size === 0) keep.add(0);
    const anchors = Array.from(keep).sort((a, b) => a - b);
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i];
      const end = anchors[(i + 1) % anchors.length];
      simplifyRingSegment(ring, start, end, tolerancePx, keep);
    }
    while (keep.size < Math.min(minVertices, ring.length)) {
      keep.add(Math.floor((keep.size * ring.length) / minVertices));
    }
    return Array.from(keep)
      .sort((a, b) => a - b)
      .map((index) => ({ x: ring[index].x, y: ring[index].y }));
  }

  function simplifyRingSegment(
    ring: readonly Point[],
    start: number,
    end: number,
    tolerancePx: number,
    keep: Set<number>,
  ): void {
    const indexes = segmentIndexes(ring.length, start, end);
    if (indexes.length <= 2) return;
    const a = ring[start];
    const b = ring[end];
    let maxDistance = -1;
    let maxIndex = -1;
    for (let i = 1; i < indexes.length - 1; i++) {
      const index = indexes[i];
      const distance = distanceToSegment(ring[index], a, b);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }
    if (maxDistance <= tolerancePx || maxIndex < 0) return;
    keep.add(maxIndex);
    simplifyRingSegment(ring, start, maxIndex, tolerancePx, keep);
    simplifyRingSegment(ring, maxIndex, end, tolerancePx, keep);
  }

  function segmentIndexes(length: number, start: number, end: number): number[] {
    const out: number[] = [start];
    let index = start;
    while (index !== end) {
      index = (index + 1) % length;
      out.push(index);
    }
    return out;
  }

  function protectedVertexIndexes(poly: readonly Point[]): Set<number> {
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (let index = 1; index < poly.length; index++) {
      const point = poly[index];
      if (point.x < poly[minX].x) minX = index;
      if (point.x > poly[maxX].x) maxX = index;
      if (point.y < poly[minY].y) minY = index;
      if (point.y > poly[maxY].y) maxY = index;
    }
    return new Set([minX, maxX, minY, maxY]);
  }

  function distanceToSegment(point: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(
      0,
      Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq),
    );
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    return Math.hypot(point.x - x, point.y - y);
  }

  function boundsAlmostEqual(a: Bounds, b: Bounds, eps: number): boolean {
    return Math.abs(a.minX - b.minX) <= eps &&
      Math.abs(a.minY - b.minY) <= eps &&
      Math.abs(a.maxX - b.maxX) <= eps &&
      Math.abs(a.maxY - b.maxY) <= eps;
  }

  function hasSelfIntersection(poly: Polygon, eps: number): boolean {
    for (let i = 0; i < poly.length; i++) {
      const a1 = poly[i];
      const a2 = poly[(i + 1) % poly.length];
      for (let j = i + 1; j < poly.length; j++) {
        if (Math.abs(i - j) <= 1) continue;
        if (i === 0 && j === poly.length - 1) continue;
        const b1 = poly[j];
        const b2 = poly[(j + 1) % poly.length];
        if (segmentsProperlyCross(a1, a2, b1, b2, eps)) return true;
      }
    }
    return false;
  }

  /**
   * Minkowski sum of two CONVEX polygons (both treated as CCW). O(n+m) angular
   * edge merge. The result is the convex polygon {a + b : a∈A, b∈B}.
   */
  export function minkowskiConvex(a: Polygon, b: Polygon): Point[] {
    const pa = reorderFromLowest(ensureCcw(a));
    const pb = reorderFromLowest(ensureCcw(b));
    const n = pa.length;
    const m = pb.length;
    if (n === 0 || m === 0) return [];
    const result: Point[] = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      result.push({ x: pa[i % n].x + pb[j % m].x, y: pa[i % n].y + pb[j % m].y });
      const crossv = edgeCross(pa, i, n, pb, j, m);
      if (i >= n) {
        j++;
      } else if (j >= m) {
        i++;
      } else if (crossv > 0) {
        i++;
      } else if (crossv < 0) {
        j++;
      } else {
        i++;
        j++;
      }
    }
    return dedupeRing(result, EPS);
  }

  function edgeCross(
    pa: Point[],
    i: number,
    n: number,
    pb: Point[],
    j: number,
    m: number,
  ): number {
    const ea = { x: pa[(i + 1) % n].x - pa[i % n].x, y: pa[(i + 1) % n].y - pa[i % n].y };
    const eb = { x: pb[(j + 1) % m].x - pb[j % m].x, y: pb[(j + 1) % m].y - pb[j % m].y };
    return ea.x * eb.y - ea.y * eb.x;
  }

  function reorderFromLowest(poly: Point[]): Point[] {
    let lowest = 0;
    for (let i = 1; i < poly.length; i++) {
      if (
        poly[i].y < poly[lowest].y ||
        (poly[i].y === poly[lowest].y && poly[i].x < poly[lowest].x)
      ) {
        lowest = i;
      }
    }
    return poly.slice(lowest).concat(poly.slice(0, lowest));
  }

  function dedupeRing(poly: Point[], eps: number): Point[] {
    const out: Point[] = [];
    for (const p of poly) {
      if (out.length === 0 || !samePoint(out[out.length - 1], p, eps)) out.push(p);
    }
    if (out.length > 1 && samePoint(out[0], out[out.length - 1], eps)) out.pop();
    return out;
  }

  /**
   * Outward miter offset of a simple CCW polygon by `d` (concavity-preserving:
   * vertex count and topology are kept). Each vertex moves along the bisector of
   * its two outward edge normals; the miter length is clamped to avoid spikes at
   * sharp corners. `d <= eps` returns a copy unchanged.
   */
  export function inflate(poly: Polygon, d: number, eps: number): Point[] {
    if (d <= eps) return poly.map((p) => ({ x: p.x, y: p.y }));
    const verts = ensureCcw(poly);
    const n = verts.length;
    const miterLimit = 3 * d;
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
      const prev = verts[(i - 1 + n) % n];
      const cur = verts[i];
      const next = verts[(i + 1) % n];
      const nPrev = outwardNormal(prev, cur);
      const nNext = outwardNormal(cur, next);
      let bx = nPrev.x + nNext.x;
      let by = nPrev.y + nNext.y;
      const blen = Math.hypot(bx, by);
      if (blen < eps) {
        // Edges nearly antiparallel — just offset along one normal.
        out.push({ x: cur.x + nPrev.x * d, y: cur.y + nPrev.y * d });
        continue;
      }
      bx /= blen;
      by /= blen;
      // Scale so the offset edges meet: 1/cos(half-angle) = blen / (1 + nPrev·nNext).
      const dot = nPrev.x * nNext.x + nPrev.y * nNext.y;
      let scale = d / Math.max(eps, (1 + dot) / blen);
      scale = Math.min(scale, miterLimit);
      out.push({ x: cur.x + bx * scale, y: cur.y + by * scale });
    }
    return out;
  }

  /** Unit outward normal of edge a→b for a CCW polygon (interior on the left). */
  function outwardNormal(a: Point, b: Point): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1e-9, Math.hypot(dx, dy));
    // Right of travel direction = outward for CCW winding.
    return { x: dy / len, y: -dx / len };
  }
}
