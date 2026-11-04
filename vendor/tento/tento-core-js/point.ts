export type Point<xUnit = number, yUnit = number> = { x: xUnit; y: yUnit };

export namespace Point {
  export function d2(p1: Point, p2: Point): number {
    return (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
  }
}

export type Tuple = [number, number];
export type Vector = Point;
