import { MathUtils } from "@tento-core/math";
import type { GeometrySource } from "./geometry-source";

/**
 * The BASELINE geometry source: seeded cluster-growth (the idea behind `Gradient Splat —
 * current`), re-architected so blobs are a CONSTANT absolute size and the cluster grows to FILL
 * the canvas — so resizing adds more same-size blobs instead of scaling them up. A few scattered
 * anchors seed coverage; the rest grow off existing blobs (always overlapping) into one organic
 * connected field. Each blob is a jittered polygon smoothed into a closed curve.
 *
 * `ClusterGrowthSource.create(config)` builds a `GeometrySource`.
 */
export namespace ClusterGrowthSource {
  export type Config = {
    seed: number;
    blobSizePx: number; // characteristic blob radius (the density target)
    sizeJitter: number; // ± fraction of blobSizePx per blob (0 = uniform) — ↑ = more size variance
    packing: number; // count ≈ area · packing / (π·blobSizePx²) — higher = denser fill
    spread: number; // scales the inter-blob gap: 1 = heavy overlap, ↑ = looser, airier cluster
    sizeScaleFactor: number; // 0 = constant blob size (count fills area); ↑ = blobs grow with canvas dim
    shapePoints: number; // outline vertices per blob (the curve flows between them)
    shapeJitter: number; // per-vertex radius wobble
    cornerSmoothing: number; // 1 = soft round blobs, → 0 = sharper corners / harder edges
  };

  export const DEFAULT: Config = {
    seed: 1337,
    blobSizePx: 48,
    sizeJitter: 0.5,
    packing: 0.44,
    spread: 1.5,
    sizeScaleFactor: 0.4,
    shapePoints: 14,
    shapeJitter: 0.3,
    cornerSmoothing: 1.0,
  };

  export function create(config: Config = DEFAULT): GeometrySource {
    // Effective blob radius at a canvas: `blobSizePx` scaled by (dim / ref)^sizeScaleFactor. Factor
    // 0 ⇒ constant size; 1 ⇒ fully proportional; in between ⇒ blobs grow gently with the canvas.
    const blobSizeFor = (size: GeometrySource.Size): number => {
      const dim = Math.sqrt(size.width * size.height);
      return config.blobSizePx * Math.pow(dim / SIZE_REF_DIM, config.sizeScaleFactor);
    };
    return {
      name: "cluster-growth",
      blobSizePx: config.blobSizePx,
      blobSizeFor,
      shapesFor(size: GeometrySource.Size, pad: number): GeometrySource.Shape[] {
        const rng = mulberry32(config.seed);
        const effBlobPx = blobSizeFor(size);
        const blobArea = Math.PI * effBlobPx * effBlobPx;
        // Count scales with AREA, blob size per `blobSizeFor` (so at factor 0 a 2× canvas gets ~4×
        // blobs of the same size; at higher factors fewer, bigger blobs).
        const targetCount = Math.max(
          1,
          Math.round((size.width * size.height * config.packing) / blobArea),
        );
        // Keep every blob's OUTLINE fully inside the canvas (no bleed), plus `pad` extra so a
        // blurring consumer's feather also stays in-bounds. The jittered outline reaches
        // r·(1 + shapeJitter/2) from the center, so contain by that (not just r); if the blob is
        // too big to fit, pin to the canvas centre.
        const outlineReach = 1 + config.shapeJitter / 2;
        const containCenter = (v: number, r: number, max: number): number => {
          const reach = r * outlineReach + EDGE_PAD + pad;
          const lo = reach;
          const hi = max - reach;
          return lo >= hi ? max / 2 : Math.max(lo, Math.min(hi, v));
        };
        const radiusFor = (): number =>
          effBlobPx * (1 - config.sizeJitter + rng() * config.sizeJitter * 2);

        const blobs: Blob[] = [];
        // Anchor at the canvas centre so the cluster stays CENTRED, then grow off existing blobs
        // (always overlapping), each new centre contained inside the canvas.
        const r0 = radiusFor();
        blobs.push({
          x: containCenter(size.width / 2, r0, size.width),
          y: containCenter(size.height / 2, r0, size.height),
          r: r0,
        });
        for (let i = 1; i < targetCount; i++) {
          const anchor = blobs[Math.floor(rng() * blobs.length)];
          const r = radiusFor();
          const angle = rng() * Math.PI * 2;
          const distance = (anchor.r + r) *
            (OVERLAP_MIN + rng() * (OVERLAP_MAX - OVERLAP_MIN)) * config.spread;
          blobs.push({
            x: containCenter(anchor.x + Math.cos(angle) * distance, r, size.width),
            y: containCenter(anchor.y + Math.sin(angle) * distance, r, size.height),
            r,
          });
        }

        // Centre the whole cluster: shift its outline-bbox centre onto the canvas centre, then
        // re-contain (a no-op when it already fits) so it stays centred AND inside the edges.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const blob of blobs) {
          const reach = blob.r * outlineReach;
          minX = Math.min(minX, blob.x - reach);
          maxX = Math.max(maxX, blob.x + reach);
          minY = Math.min(minY, blob.y - reach);
          maxY = Math.max(maxY, blob.y + reach);
        }
        const dx = size.width / 2 - (minX + maxX) / 2;
        const dy = size.height / 2 - (minY + maxY) / 2;
        for (const blob of blobs) {
          blob.x = containCenter(blob.x + dx, blob.r, size.width);
          blob.y = containCenter(blob.y + dy, blob.r, size.height);
        }

        return blobs.map((blob) => shapeForBlob(blob, config, rng));
      },
    };
  }
}

// Canvas dimension (geometric mean of w·h) at which the effective blob size equals `blobSizePx`.
// At the storybook's default 360×240 frame this is ≈ 294, so the blobs start ≈ nominal size.
const SIZE_REF_DIM = 300;

// Base overlap window (× `spread`): grown-blob distance = (r_a + r_new) · factor · spread.
// factor·spread < 1 ⇒ blobs overlap; ≈ 1 ⇒ kiss; > 1 ⇒ a gap opens between them.
const OVERLAP_MIN = 0.45;
const OVERLAP_MAX = 0.9;
const EDGE_PAD = 2; // keep every blob FULLY inside the canvas — center ∈ [r+pad, size-r-pad]

// Deterministic [0,1) PRNG (mulberry32) — same family the wash uses, so layouts are stable.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const polygonD = (points: readonly GeometrySource.Point[]): string =>
  `M${points.map((p) => `${p.x} ${p.y}`).join("L")}Z`;

// Closed outline through `points` with PARAMETRIC corner rounding. `smoothing` ∈ [0,1]: at 1 the
// corner anchors sit at the edge midpoints (a fully round, soft organic blob); lower pulls the
// anchors toward each vertex so corners get sharper and the edges between them straighter; 0 is a
// hard polygon. Every coordinate it emits is either ON an edge (anchor) or a vertex used only as
// an off-curve quadratic CONTROL, so the curve stays inside the polygon and the blob's bounds
// never exceed its vertices' — keeping the containment math honest.
function outlinePathD(points: readonly GeometrySource.Point[], smoothing: number): string {
  const n = points.length;
  if (n < 3 || smoothing <= 0) return polygonD(points);
  const t = 0.5 * Math.min(1, smoothing); // fraction along each edge to the corner anchor
  const anchor = (from: GeometrySource.Point, to: GeometrySource.Point): GeometrySource.Point => ({
    x: MathUtils.roundToDecimals(from.x + (to.x - from.x) * t, 1),
    y: MathUtils.roundToDecimals(from.y + (to.y - from.y) * t, 1),
  });
  const segments: string[] = [];
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const aIn = anchor(curr, prev);
    const aOut = anchor(curr, next);
    // straight run into this corner (zero-length at smoothing=1, when both anchors are midpoints)
    segments.push(i === 0 ? `M${aIn.x} ${aIn.y}` : `L${aIn.x} ${aIn.y}`);
    segments.push(`Q${curr.x} ${curr.y} ${aOut.x} ${aOut.y}`);
  }
  segments.push("Z");
  return segments.join("");
}

type Blob = { x: number; y: number; r: number };

function shapeForBlob(
  blob: Blob,
  config: ClusterGrowthSource.Config,
  rng: () => number,
): GeometrySource.Shape {
  const points: GeometrySource.Point[] = [];
  for (let k = 0; k < config.shapePoints; k++) {
    const angle = (k / config.shapePoints) * Math.PI * 2;
    const rad = 1 - config.shapeJitter / 2 + rng() * config.shapeJitter;
    points.push({
      x: MathUtils.roundToDecimals(blob.x + Math.cos(angle) * blob.r * rad, 1),
      y: MathUtils.roundToDecimals(blob.y + Math.sin(angle) * blob.r * rad, 1),
    });
  }
  return {
    points,
    center: { x: MathUtils.roundToDecimals(blob.x, 1), y: MathUtils.roundToDecimals(blob.y, 1) },
    radius: MathUtils.roundToDecimals(blob.r, 1),
    d: outlinePathD(points, config.cornerSmoothing),
  };
}
