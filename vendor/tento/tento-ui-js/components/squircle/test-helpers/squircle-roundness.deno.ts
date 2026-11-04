// Run: deno run --unstable-sloppy-imports components/squircle/test-helpers/squircle-roundness.deno.ts
import { SquircleMath } from "../squircle-math.ts";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;
const numbers = (s: string) =>
  [...s.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
const curves = (shape: ReturnType<typeof SquircleMath.genSvg>) =>
  shape.corners.flatMap((c) =>
    c.slice(1).map((arc, i) => [
      i === 0 ? c[0][0] : c[i][2],
      ...arc,
    ])
  );
let cases = 0;
let samples = 0;
// Include icons, panels, pills, extreme aspects and fractional/oversized radii.
for (
  const size of [
    { width: 18, height: 18 },
    { width: 11, height: 11 },
    { width: 320, height: 180 },
    { width: 180, height: 320 },
    { width: 140, height: 36 },
    { width: 36, height: 140 },
    { width: 1000, height: 2 },
    { width: 2, height: 1000 },
    { width: 100, height: 100.00002 },
    { width: 100.00002, height: 100 },
    { width: 480, height: 180 },
    { width: 480, height: 100 },
  ]
) {
  for (const radius of [-1, 0, 0.1, 2, 8, 20, 50, 200]) {
    for (let step = 0; step <= 20; step++) {
      const k = step / 20;
      const shape = SquircleMath.genSvg(size, radius, k);
      const [vx, vy, vw, vh] = shape.viewBox.split(" ").map(Number);
      const svg = numbers(shape.pathData);
      const pixels = numbers(SquircleMath.genPixelPath(size, radius, k));
      check(svg.length === pixels.length, "Paint/clip point counts differ");
      for (const [i, n] of svg.entries()) {
        const expected = i % 2 === 0
          ? (n - vx) / vw * size.width
          : (n - vy) / vh * size.height;
        check(near(expected, pixels[i]), "Paint and clip contours differ");
        check(
          expected >= -1e-7 &&
            expected <= (i % 2 === 0 ? size.width : size.height) + 1e-7,
          "Control point escaped bounds",
        );
      }
      const arcs = curves(shape);
      for (const [i, arc] of arcs.entries()) {
        const next = arcs[(i + 1) % arcs.length];
        const gap = [next[0][0] - arc[3][0], next[0][1] - arc[3][1]];
        const hasStraight = Math.hypot(...gap) > 1e-10;
        if (radius <= 0) continue; // Sharp rectangle is intentionally not smooth.
        const a = [arc[3][0] - arc[2][0], arc[3][1] - arc[2][1]];
        const b = [next[1][0] - next[0][0], next[1][1] - next[0][1]];
        check(
          Math.abs(a[0] * b[1] - a[1] * b[0]) <
              1e-7 * Math.hypot(...a) * Math.hypot(...b) &&
            a[0] * b[0] + a[1] * b[1] > 0,
          "Tangent direction jumps",
        );
        if (hasStraight) {
          check(
            near(a[0] * gap[1] - a[1] * gap[0], 0) &&
              a[0] * gap[0] + a[1] * gap[1] > 0,
            "Curve does not meet straight edge tangentially",
          );
        }
        const ca = SquircleMath.bezierCurve(1, ...arc)[0];
        const cb = SquircleMath.bezierCurve(0, ...next)[0];
        check(
          Math.abs(ca - cb) < 1e-5 * Math.max(1, Math.abs(ca)),
          `Curvature jumps at join: ${
            JSON.stringify({ size, radius, k, ca, cb })
          }`,
        );
        if (hasStraight) {
          check(
            Math.abs(ca) < 1e-7 && Math.abs(cb) < 1e-7,
            "Straight edge join has nonzero curvature",
          );
        }
        for (let j = 0; j <= 100; j++) {
          const curvature = SquircleMath.bezierCurve(j / 100, ...arc)[0];
          check(
            Number.isFinite(curvature) && curvature >= -1e-6,
            "Curve inflects or has a singularity",
          );
          samples++;
        }
      }
      // Reflection symmetry and 45-degree corner inset in physical coordinates.
      const unit = Math.min(size.width, size.height) / 2;
      const all = shape.corners.flat(2);
      for (const [x, y] of all) {
        check(
          all.some((p) => near(p[0], -x) && near(p[1], y)),
          "X reflection differs",
        );
        check(
          all.some((p) => near(p[0], x) && near(p[1], -y)),
          "Y reflection differs",
        );
      }
      const inset = Math.min(Math.max(radius, 0), unit) *
        (1 - SquircleMath.circleParams(k).diagonal);
      check(
        shape.corners[0].flat().some(([x, y]) =>
          near(x * unit + size.width / 2, inset) &&
          near(y * unit + size.height / 2, inset)
        ),
        "Corner radius stretches with bounds",
      );
      // The corner must fit its radius box, regardless of the card's aspect.
      const effective = Math.min(Math.max(radius, 0), unit);
      for (const [x, y] of shape.corners[0].flat()) {
        check(
          x * unit + size.width / 2 <= effective + 1e-7 &&
            y * unit + size.height / 2 <= effective + 1e-7,
          "Corner rounding leaked along the panel edge",
        );
      }
      cases++;
    }
  }
}
const circle = curves(SquircleMath.genSvg({ width: 2, height: 2 }, 1, 1))[0];
const circularCurvature = SquircleMath.bezierCurve(0, ...circle)[0];
let previousDiagonal = Infinity;
for (let step = 0; step <= 100; step++) {
  const k = step / 100;
  const shape = SquircleMath.genSvg({ width: 2, height: 2 }, 1, k);
  const arc = curves(shape)[0];
  check(
    near(SquircleMath.bezierCurve(0, ...arc)[0], k * circularCurvature),
    "Side curvature is not linear in k",
  );
  const extent = Math.hypot(...arc[3]);
  check(
    extent <= previousDiagonal + 1e-7,
    "Diagonal fails to converge toward circle",
  );
  previousDiagonal = extent;
}
for (let i = 0; i <= 1000; i++) {
  check(
    Math.abs(Math.hypot(...SquircleMath.bezierPos(i / 1000, ...circle)) - 1) <
      5e-6,
    "Circular endpoint approximation exceeds error bound",
  );
}
const selected = curves(SquircleMath.genSvg({ width: 2, height: 2 }, 1))[0];
check(
  near(Math.hypot(...selected[3]) - 1, 0.0595988290134204),
  "Approved marker diagonal changed",
);
check(
  SquircleMath.bezierCurve(0, ...selected)[0] > 0.59,
  "Approved marker side bend became flat",
);
for (const invalid of [-0.1, 1.1, NaN, Infinity]) {
  let rejected = false;
  try {
    SquircleMath.genSvg({ width: 18, height: 18 }, 50, invalid);
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  check(rejected, "Invalid curvature accepted");
}
for (
  const size of [{ width: 0, height: 18 }, { width: 18, height: NaN }, {
    width: Infinity,
    height: 18,
  }]
) {
  let rejected = false;
  try {
    SquircleMath.genSvg(size, 50);
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  check(rejected, "Invalid dimensions accepted");
}
console.log(
  JSON.stringify({
    surfaceCases: cases,
    convexitySamples: samples,
    circularSamples: 1001,
    approvedMarkerPreserved: true,
    oneGeometryModel: true,
    localCornersAndFlatEdges: true,
  }),
);
