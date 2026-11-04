/** One continuous contour for painting, borders and content clipping. */
export namespace SquircleMath {
  export type Point = [number, number];
  export const DEFAULT_SIDE_CURVATURE = 0.6;

  /** Standard 45-degree cubic handle. Keeping it fixed makes side-midpoint
   * curvature exactly k times circular-cubic curvature at saturated radius.
   * The diagonal extension is sqrt(2)*diagonal - 1 ≈ .148997*(1-k).
   */
  export function circleParams(
    sideCurvature: number,
  ): { handle: number; diagonal: number } {
    if (
      !Number.isFinite(sideCurvature) || sideCurvature < 0 || sideCurvature > 1
    ) {
      throw new RangeError("sideCurvature must be finite and between 0 and 1");
    }
    const handle = (4 / 3) * Math.tan(Math.PI / 16);
    const diagonal = Math.SQRT1_2 +
      (1 - sideCurvature) * (1 - handle * Math.SQRT1_2 - Math.SQRT1_2);
    return { handle, diagonal };
  }

  /** Split a cubic, retaining the right-hand segment exactly. */
  function splitRight(curve: Point[], t: number): Point[] {
    const mix = (
      a: Point,
      b: Point,
    ): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const a = mix(curve[0], curve[1]);
    const b = mix(curve[1], curve[2]);
    const c = mix(curve[2], curve[3]);
    const d = mix(a, b);
    const e = mix(b, c);
    return [mix(d, e), e, c, curve[3]];
  }

  /** Fit the circular profile to a flat side without extending its corner
   * footprint. A straight side has zero curvature, so simply translating the
   * circle quadrant would leave a curvature jump. Replace its initial section
   * with a cubic whose first three points lie on the side. Match position,
   * tangent and curvature at the retained profile (G2).
   *
   * t = cbrt(clamp((halfExtent - radius) / radius, 0, 1)) consumes more of the
   * transition as straight-side room grows. At saturation t=0, preserving the
   * approved circle exactly. With >= one radius of extra room t=1: the whole
   * half-corner is local and independent of panel dimensions.
   */
  function sideTransition(profile: Point[], t: number): Point[][] {
    if (t === 0) return [profile];
    const remaining = splitRight(profile, t);
    const [x, y] = remaining[0];
    // Derivatives of the original curve at t, avoiding a division by 1-t at
    // the fully local endpoint.
    const u = 1 - t;
    const velocity = [0, 1].map((axis) =>
      3 * (profile[1][axis] - profile[0][axis]) * u * u +
      6 * (profile[2][axis] - profile[1][axis]) * u * t +
      3 * (profile[3][axis] - profile[2][axis]) * t * t
    );
    const acceleration = [0, 1].map((axis) =>
      6 * (profile[2][axis] - 2 * profile[1][axis] + profile[0][axis]) * u +
      6 * (profile[3][axis] - 2 * profile[2][axis] + profile[1][axis]) * t
    );
    const [dx, dy] = velocity;
    const [ddx, ddy] = acceleration;
    const slope = dy / dx;
    const lambda = x / dx;
    const b = y - x * slope; // Tangent intersection with the straight side.
    const a = b + 1.5 * lambda * lambda * (ddy - slope * ddx);
    const transition: Point[] = [[0, 1], [0, a], [0, b], [x, y]];
    return t === 1 ? [transition] : [transition, remaining];
  }

  /** Local radius-sized corners joined by straight edges. Saturated axes keep
   * the approved circle's side bend; spare room introduces a curvature-matched
   * transition to the straight side. The same contour paints and clips. */
  function roundedCorners(size: Size, radius: number, k: number): Point[][][] {
    const params = circleParams(k);
    const unit = Math.min(size.width, size.height!) / 2;
    const r = Math.min(Math.max(radius, 0), unit) / unit;
    const a = size.width / (2 * unit);
    const b = size.height! / (2 * unit);
    const h = params.handle;
    const inset = 1 - params.diagonal;
    const q = h * Math.SQRT1_2;
    const profile: Point[] = [
      [0, 1],
      [0, 1 - h],
      [inset - q, inset + q],
      [inset, inset],
    ];
    const transition = (halfExtent: number) =>
      r === 0 ? 0 : Math.cbrt(Math.min(Math.max((halfExtent - r) / r, 0), 1));
    const left = sideTransition(profile, transition(b));
    const top = sideTransition(profile, transition(a))
      .reverse().map((curve) =>
        [...curve].reverse().map(([x, y]): Point => [y, x])
      );
    const curves = [...left, ...top];
    const corner: Point[] = [curves[0][0], ...curves.flatMap((c) => c.slice(1))]
      .map(([x, y]): Point => [-a + r * x, -b + r * y]);
    return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([x, y], i) => {
      const points = corner.map(([px, py]): Point => [px * x, py * y]);
      if (i % 2) points.reverse();
      return [
        points.slice(0, 1),
        ...Array.from(
          { length: (points.length - 1) / 3 },
          (_, j) => points.slice(1 + j * 3, 4 + j * 3),
        ),
      ];
    });
  }

  // Bezier curve calculations
  export const bezierPos = (t: number, ...points: Point[]): Point => {
    const f = (c0: number, c1: number, c2: number, c3: number) =>
      c0 * (1 - t) ** 3 +
      c1 * 3 * (1 - t) ** 2 * t +
      c2 * 3 * (1 - t) * t ** 2 +
      c3 * t ** 3;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [f(xs[0], xs[1], xs[2], xs[3]), f(ys[0], ys[1], ys[2], ys[3])];
  };

  export const bezierCurve = (
    t: number,
    ...points: Point[]
  ): [number, Point] => {
    const d1f = (c0: number, c1: number, c2: number, c3: number) =>
      (c1 - c0) * 3 * (1 - t) ** 2 +
      (c2 - c1) * 6 * (1 - t) * t +
      (c3 - c2) * 3 * t ** 2;
    const d2f = (c0: number, c1: number, c2: number, c3: number) =>
      (c2 - c1 * 2 + c0) * 6 * (1 - t) + (c3 - c2 * 2 + c1) * 6 * t;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const d1 = [
      d1f(xs[0], xs[1], xs[2], xs[3]),
      d1f(ys[0], ys[1], ys[2], ys[3]),
    ];
    const d2 = [
      d2f(xs[0], xs[1], xs[2], xs[3]),
      d2f(ys[0], ys[1], ys[2], ys[3]),
    ];
    const curvature = (d1[0] * d2[1] - d1[1] * d2[0]) /
      (d1[0] ** 2 + d1[1] ** 2) ** (3 / 2);
    const normal = [-d1[1], d1[0]];
    const mag = Math.sqrt(normal[0] ** 2 + normal[1] ** 2);
    return [
      curvature,
      normal.map((c) => ((c * 1) / mag) * curvature * -0.1) as Point,
    ];
  };

  /** Radius is in CSS pixels; curvature is dimensionless in [0,1]. */
  export function genSvg(
    size: Size,
    radius: number,
    sideCurvature: number = DEFAULT_SIDE_CURVATURE,
  ): { viewBox: string; pathData: string; corners: Point[][][] } {
    if (
      !Number.isFinite(size.width) || !Number.isFinite(size.height) ||
      size.width <= 0 || size.height <= 0 || !Number.isFinite(radius)
    ) {
      throw new RangeError(
        "Contour size must be positive and finite; radius must be finite",
      );
    }
    const unit = Math.min(size.width, size.height) / 2;
    const a = size.width / (2 * unit);
    const b = size.height / (2 * unit);
    const corners = roundedCorners(size, radius, sideCurvature);
    return {
      viewBox: `${-a} ${-b} ${2 * a} ${2 * b}`,
      pathData: path(corners),
      corners,
    };
  }

  function path(corners: Point[][][]): string {
    const join = (points: Point[]) => points.map((p) => p.join(" ")).join(" ");
    return `M ${join(corners[0][0])} ${
      corners.map((c) =>
        `L ${join(c[0])} ${c.slice(1).map((arc) => `C ${join(arc)}`).join(" ")}`
      )
        .join(" ")
    } Z`;
  }

  /** The paint contour transformed into CSS-pixel clip-path coordinates. */
  export function genPixelPath(
    size: Size,
    radius: number,
    sideCurvature: number = DEFAULT_SIDE_CURVATURE,
  ): string {
    const { corners } = genSvg(size, radius, sideCurvature);
    const unit = Math.min(size.width, size.height) / 2;
    return path(
      corners.map((c) =>
        c.map((points) =>
          points.map((
            [x, y],
          ): Point => [x * unit + size.width / 2, y * unit + size.height / 2])
        )
      ),
    );
  }
}
