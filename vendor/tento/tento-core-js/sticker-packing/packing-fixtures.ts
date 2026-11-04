import type { Point } from "@tento-core/point";

/**
 * Deterministic polygon fixtures shared by tests and the playground. All are
 * simple, hole-free, and authored CCW with their min corner at the origin.
 */
export namespace PackingFixtures {
  export function square(size: number): Point[] {
    return [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ];
  }

  export function rectangle(width: number, height: number): Point[] {
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  }

  export function rightTriangle(size: number): Point[] {
    return [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: 0, y: size },
    ];
  }

  /** An L: a `size × size` square with the top-right quadrant removed. */
  export function lShape(size: number): Point[] {
    const h = size / 2;
    return [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: h },
      { x: h, y: h },
      { x: h, y: size },
      { x: 0, y: size },
    ];
  }

  /** A U: a square with a rectangular notch cut from the top-center. */
  export function uShape(size: number): Point[] {
    const t = size / 3;
    return [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: size - t, y: size },
      { x: size - t, y: t },
      { x: t, y: t },
      { x: t, y: size },
      { x: 0, y: size },
    ];
  }

  /** A `points`-pointed star, normalized to min-corner origin. */
  export function star(points: number, outerR: number, innerR: number): Point[] {
    const verts: Point[] = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = (Math.PI * i) / points - Math.PI / 2;
      verts.push({ x: outerR + r * Math.cos(angle), y: outerR + r * Math.sin(angle) });
    }
    return verts;
  }

  export function regularPolygon(sides: number, radius: number): Point[] {
    const verts: Point[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
      verts.push({
        x: radius + radius * Math.cos(angle),
        y: radius + radius * Math.sin(angle),
      });
    }
    return verts;
  }
}
