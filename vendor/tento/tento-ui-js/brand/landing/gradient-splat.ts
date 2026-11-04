/**
 * Procedural "grainy gradient splat" washes for the sticker-card background, the
 * `/gtm` catalog, and the GTM ad-creative templates.
 *
 * Each palette renders as ONE SVG (`shapesSvg`): organic blob shapes, soft-blurred,
 * with a feTurbulence grain baked in and MASKED to the blob alpha — so the grain
 * textures only the colored shapes and the gutter stays fully transparent (the
 * card/white shows through). Call `palette.backgroundForSize({ width, height })`
 * with the screen-space box being filled; the same seeded texture scales its
 * geometry/spread to that box instead of stretching a fixed bitmap-sized SVG.
 *
 * Pipeline:
 *   - `placeBlobs(seed, colors, spread)` — seeded cluster-growth: a `mulberry32(seed)`
 *     PRNG makes each layout random-LOOKING but STABLE (same seed → same layout). One
 *     large anchor near center; each later blob grows off an existing one at distance
 *     `(r_a + r_new) * factor * spread` (factor·spread ≲ 1 GUARANTEES overlap).
 *   - `blobPath` — a jittered closed polygon per blob (organic; the blur smooths it).
 *   - `shapesSvg(spec, size)` — scales the cluster about its centroid by
 *     `footprint`, maps the normalized blob geometry/spread to the requested
 *     screen-space canvas, then fits the actual path bounds plus blur gutter into
 *     that canvas so every edge feathers out instead of being hard-clipped. It
 *     blurs by size-scaled `softness` and overlays grain (strength `grain`)
 *     masked to the blobs.
 *
 * Palettes are organized by COLOR DISTRIBUTION (adjacent / complementary / triadic /
 * monochromatic / rainbow), labeled with their type, and individually tuned
 * (`footprint`/`spread`/`softness`/`grain` + the color alphas for dimness). Indices 0–5
 * are pinned to hue-compatible families (blue/teal/green/citrus/amber/red) because the
 * ad-creative templates index the background by number (`AD_CREATIVES` `bg: 0–5`).
 *
 * Bespoke decorative marketing colors (literal rgba, not colors.css tokens).
 */
export namespace GradientSplat {
  export type Palette = {
    label: string;
    background: string;
    // `offsetX` shifts the blob-cluster geometry horizontally (render px, + = right)
    // INSIDE the SVG canvas — the cluster is repositioned, then clipped at the canvas
    // edges, rather than the whole image being slid (background-position) or the box
    // moved (transform). Pass 0 for the default centered geometry.
    backgroundForSize: (size: RenderSize, offsetX: number) => string;
    // The flat backing shapes (same outlines as the wash, no blur/goo/grain) — for a storybook
    // toggle to inspect the geometry of `Gradient Splat — current`.
    geometryForSize: (size: RenderSize) => string;
    // Per-palette CSS filter for the wash layer. Always "none" here (the blur is baked
    // into the SVG); kept for a uniform API.
    blur: string;
    // A soft COMPLEMENTING gradient (this palette's own colors, solid) for a surface that sits in
    // FRONT of the wash — e.g. the feature-card hero. The consumer applies it at a low opacity.
    softBackground: string;
  };

  export type RenderSize = {
    width: number;
    height: number;
  };

  // One blob: color, radius (rx/ry as % of the box) and center (x/y %). Produced by
  // `placeBlobs`, outlined by `blobPath`, rendered by `shapesSvg`.
  type Blob = {
    color: string;
    rx: number;
    ry: number;
    x: number;
    y: number;
  };

  type Point = {
    x: number;
    y: number;
  };

  type Bounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };

  type BlobPath = {
    points: Point[];
    bounds: Bounds;
  };

  type PathTransform = {
    scale: number;
    dx: number;
    dy: number;
  };

  // ---- Placement tunables (one-line knobs for the next visual pass) -------------
  // Blobs are sized as a % of the box; the wash REGENERATES at the container size (its
  // ResizeObserver), so the blobs scale with the box and re-rasterize crisp — no upscale artifact.
  const ANCHOR_MIN = 62; // first (anchor) blob radius range, % of box
  const ANCHOR_MAX = 78;
  const R_MIN = 40; // subsequent blob radius range, % of box
  const R_MAX = 62;
  const R_BIAS = 1.7; // >1 biases radii small (pow); a few come out large
  const OVERLAP_MIN = 0.45; // new-blob distance = (r_anchor + r_new) * factor * spread;
  const OVERLAP_MAX = 0.9; //   factor·spread < 1 ⇒ always overlapping (close ↔ further)
  const INSET_MIN = 14; // clamp blob centers to this band so the cluster stays
  const INSET_MAX = 86; //   mostly inset
  const CENTER_JITTER = 10; // anchor wander from dead-center, ±%
  const EXTRA_BLOBS = 4; // up to this many blobs beyond the color count
  const MAX_BLOBS = 9;
  const SPREAD_SCALE = 1.25; // global: distribute blobs wider (heavier blur re-merges them)
  const FOOTPRINT_SCALE = 1.9; // global: cluster fills more of the card (fit still re-fits)
  // Cap on the fit UPSCALE (>1 lets an under-sized cluster grow uniformly to cover more of the box,
  // bounded by "contain the available rect" so the blur feather stays inside).
  const COVERAGE_BOOST = 3.5;
  // Cover this fraction of the box (1 = edge-to-edge). <1 pulls the splat in a touch.
  const COVER_FILL = 0.9;
  // SCALE THE BLOBS UP: multiply each blob's radius (NOT its position) so the same composition reads
  // bolder/larger. Regenerated per size, so no artifact. 1 = original size.
  const BLOB_SCALE = 1.6;

  // ---- Shape-render tunables ----------------------------------------------------
  const SHAPE_PTS = 14; // control points around each blob (smoothPathD curves between them)
  const SHAPE_JITTER = 0.3; // radius wobble: per-vertex radius ∈ ~[0.85 … 1.15]·r (smoother)
  const SHAPE_GRAIN_FREQ = 1.4; // feTurbulence baseFrequency (higher = finer grain)
  // Goo / metaball merge: each blob is SOLID-filled, the cluster is blurred, then an alpha
  // CONTRAST re-tightens the blurred alpha so overlapping halos FUSE into one seamless
  // organic mass while thin edges fall to zero — feathered, blended, and free of the
  // clipped-radial border ring the per-blob fade left behind.
  const GOO_ALPHA = 1.12; // feColorMatrix alpha multiplier (gentler ⇒ softer mass edge)
  const GOO_BIAS = -0.1; // feColorMatrix alpha offset (less negative ⇒ no hard density step)
  const SOFTNESS_SCALE = 1.9; // global feather boost (scales the blur AND the fit gutter)
  // Progressive sharpness (depth-of-field): blend a SHARP pass and the full SOFT pass through a
  // low-frequency organic "focus" mask, so some regions resolve crisp and others stay blurry.
  const SHARP_RATIO = 0.1; // sharp-pass blur = softness * this (smaller ⇒ crisper sharp areas)
  const FOCUS_PATCHES = 1.3; // LOW freq ⇒ a few big regions (so only a couple can be sharp)
  const FOCUS_CONTRAST = 3.0; // feColorMatrix alpha gain on the focus noise (steeper ⇒ crisper spots)
  const FOCUS_BIAS = -1.7; // high threshold ⇒ only the top noise peaks (≈ 2-3 spots) are sharp
  const FOCUS_SEED = 11; // focus-mask turbulence seed
  const COORD_SIZE = 100; // normalized authoring space before screen-space scaling
  const BASE_CANVAS_SIZE = 128; // visual baseline for softness/gutter scale
  const DEFAULT_RENDER_SIZE: RenderSize = {
    width: BASE_CANVAS_SIZE,
    height: BASE_CANVAS_SIZE,
  };
  const EDGE_GUTTER = 4; // keep the blurred shape visibly away from the SVG edge
  const BLUR_PAD_FACTOR = 2.8; // reserve ~2.8 std devs (tighter ⇒ wash fills closer to the edges)
  // The fit reserves only the BULK of the feather (was the full 2.8σ above), so the splat covers
  // MORE of the box and the faint outer tail of the blur softly reaches the edges. Current pipeline
  // only — `washGutterFor` (the decoupled geometry wash) keeps the full BLUR_PAD_FACTOR.
  const FIT_BLUR_PAD_FACTOR = 0.9;
  const BLUR_PAD_EXTRA = 1; // absorbs coordinate rounding and filter math variance
  // `footprint` (centroid scale; ~0.5–0.78 is the contained sweet spot), `softness`
  // (blur stdDeviation) and `grain` (baked-noise strength) are PER-VARIANT.

  // Deterministic [0,1) PRNG (mulberry32). Tiny, dependency-free, stable per seed.
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

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const round3 = (n: number): number => Math.round(n * 1000) / 1000;

  function boundsFor(points: readonly Point[]): Bounds {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function mergeBounds(bounds: readonly Bounds[]): Bounds {
    return {
      minX: Math.min(...bounds.map((b) => b.minX)),
      minY: Math.min(...bounds.map((b) => b.minY)),
      maxX: Math.max(...bounds.map((b) => b.maxX)),
      maxY: Math.max(...bounds.map((b) => b.maxY)),
    };
  }

  export function renderSizeFor(size: RenderSize): RenderSize {
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }

  export function sizeKey(size: RenderSize): string {
    const renderSize = renderSizeFor(size);
    return `${renderSize.width}x${renderSize.height}`;
  }

  function fitTransformFor(
    bounds: Bounds,
    softness: number,
    size: RenderSize,
    offsetX: number,
  ): PathTransform {
    const scale = Math.min(size.width, size.height) / BASE_CANVAS_SIZE;
    const blurPad = softness * FIT_BLUR_PAD_FACTOR + BLUR_PAD_EXTRA * scale;
    const minX = EDGE_GUTTER * scale + blurPad;
    const minY = EDGE_GUTTER * scale + blurPad;
    const maxX = size.width - EDGE_GUTTER * scale - blurPad;
    const maxY = size.height - EDGE_GUTTER * scale - blurPad;
    const availableWidth = Math.max(1, maxX - minX);
    const availableHeight = Math.max(1, maxY - minY);
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    // COVER (max ratio): scale the square cluster up to fill the LONGER dimension of the box and
    // overflow the shorter — so the splat covers the whole box (e.g. a wide hero) edge-to-edge,
    // bounded by COVERAGE_BOOST. (Was `min` = contain, which left side gaps on a wide box.)
    const fitScale = Math.min(
      COVERAGE_BOOST,
      Math.max(availableWidth / width, availableHeight / height) * COVER_FILL,
    );
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return {
      scale: fitScale,
      dx: size.width / 2 - cx * fitScale + offsetX,
      dy: size.height / 2 - cy * fitScale,
    };
  }

  function transformPoint(point: Point, transform: PathTransform): Point {
    return {
      x: round1(point.x * transform.scale + transform.dx),
      y: round1(point.y * transform.scale + transform.dy),
    };
  }

  // Seeded cluster-growth (in the normalized COORD space): an anchor near center, then each blob
  // grown off an existing one within (r_a + r_new)·spread so it always overlaps the mass. Radii are
  // a % of the box; positions/distances use the UNSCALED radii, then every radius is multiplied by
  // `BLOB_SCALE` at the end so the blobs read bigger without moving the cluster.
  function placeBlobs(
    seed: number,
    colors: readonly string[],
    spread: number,
  ): Blob[] {
    const rng = mulberry32(seed);
    const clamp = (n: number): number =>
      Math.max(INSET_MIN, Math.min(INSET_MAX, n));

    const count = Math.min(
      MAX_BLOBS,
      colors.length + 1 + Math.floor(rng() * EXTRA_BLOBS),
    );

    const blobs: Blob[] = [];

    const anchorR = ANCHOR_MIN + rng() * (ANCHOR_MAX - ANCHOR_MIN);
    blobs.push({
      color: colors[0],
      rx: round1(anchorR),
      ry: round1(anchorR * (0.85 + rng() * 0.3)),
      x: round1(clamp(50 + (rng() * 2 - 1) * CENTER_JITTER)),
      y: round1(clamp(50 + (rng() * 2 - 1) * CENTER_JITTER)),
    });

    for (let i = 1; i < count; i++) {
      const anchor = blobs[Math.floor(rng() * blobs.length)];
      const rx = R_MIN + (R_MAX - R_MIN) * Math.pow(rng(), R_BIAS);
      const ry = rx * (0.85 + rng() * 0.3);
      const angle = rng() * Math.PI * 2;
      const factor = OVERLAP_MIN + rng() * (OVERLAP_MAX - OVERLAP_MIN);
      const distance = (anchor.rx + rx) * factor * spread;
      blobs.push({
        color: colors[i % colors.length],
        rx: round1(rx),
        ry: round1(ry),
        x: round1(clamp(anchor.x + Math.cos(angle) * distance)),
        y: round1(clamp(anchor.y + Math.sin(angle) * distance)),
      });
    }

    // Scale the blobs UP in size (radii only — positions/spacing unchanged) so the same
    // composition reads bolder/larger (`BLOB_SCALE` 1 = original size).
    return blobs.map((b) => ({
      ...b,
      rx: round1(b.rx * BLOB_SCALE),
      ry: round1(b.ry * BLOB_SCALE),
    }));
  }

  // One organic blob outline: SHAPE_PTS points on the ellipse, each pushed in/out by a
  // seeded radius wobble. `smoothPathD` joins them into a C1-smooth closed curve (the flat
  // geometry reads smooth on its own; the gradient additionally blurs).
  function blobPath(b: Blob, rng: () => number): BlobPath {
    const points: Point[] = [];
    for (let k = 0; k < SHAPE_PTS; k++) {
      const a = (k / SHAPE_PTS) * Math.PI * 2;
      const rad = 1 - SHAPE_JITTER / 2 + rng() * SHAPE_JITTER;
      points.push({
        x: round1(b.x + Math.cos(a) * b.rx * rad),
        y: round1(b.y + Math.sin(a) * b.ry * rad),
      });
    }
    return { points, bounds: boundsFor(points) };
  }

  function pathD(points: readonly Point[]): string {
    return `M${points.map((p) => `${p.x} ${p.y}`).join("L")}Z`;
  }

  const midpoint = (a: Point, b: Point): Point => ({
    x: round1((a.x + b.x) / 2),
    y: round1((a.y + b.y) / 2),
  });

  // A SMOOTH closed outline through `points`: each vertex becomes a quadratic-Bézier
  // control point and each edge midpoint an on-curve anchor. The result is C1-smooth
  // (no facets) yet stays INSIDE the polygon — every coordinate it emits is a vertex or a
  // midpoint, so its bounding box never exceeds the vertices'. That keeps the fit/gutter
  // math (and the responsive-canvas test, which bounds the path coords) unchanged, and
  // means the flat geometry reads as smooth blobs instead of 14-gon facets.
  function smoothPathD(points: readonly Point[]): string {
    if (points.length < 3) return pathD(points);
    const n = points.length;
    const start = midpoint(points[n - 1], points[0]);
    const segments: string[] = [`M${start.x} ${start.y}`];
    for (let i = 0; i < n; i++) {
      const ctrl = points[i];
      const end = midpoint(points[i], points[(i + 1) % n]);
      segments.push(`Q${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`);
    }
    segments.push("Z");
    return segments.join("");
  }

  // Map the normalized cluster to screen space with a UNIFORM scale (same factor for x and y) so a
  // circular blob stays circular at any box aspect — no horizontal/vertical stretch. (`fitTransformFor`
  // then contains + centres the square cluster.) On a square box this equals the old per-axis map.
  function canvasPointFor(point: Point, size: RenderSize): Point {
    const scale = Math.min(size.width, size.height) / COORD_SIZE;
    return {
      x: point.x * scale,
      y: point.y * scale,
    };
  }

  // One screen-space outline ready to paint: its palette color and its transformed points.
  type RenderOutline = {
    color: string;
    points: Point[];
  };

  type RenderGeometry = {
    outlines: RenderOutline[];
    softness: number;
  };

  // The shared geometry behind BOTH the finished gradient and its flat preview: place the
  // blobs, footprint-scale the cluster about its centroid, outline each blob, map into the
  // requested screen-space canvas, and fit the cluster (reserving the blur gutter) so the
  // SAME shapes sit in the SAME place whether or not the blur/grain are applied.
  function renderGeometryFor(
    spec: ShapeSpec,
    renderSize: RenderSize,
    offsetX: number,
  ): RenderGeometry {
    const rng = mulberry32((spec.seed ^ 0x9e3779b9) >>> 0);
    const blobs = placeBlobs(spec.seed, spec.colors, spec.spread * SPREAD_SCALE);
    const cx = blobs.reduce((s, b) => s + b.x, 0) / blobs.length;
    const cy = blobs.reduce((s, b) => s + b.y, 0) / blobs.length;
    const footprint = spec.footprint * FOOTPRINT_SCALE;
    const scaled: Blob[] = blobs.map((b) => ({
      color: b.color,
      rx: round1(b.rx * footprint),
      ry: round1(b.ry * footprint),
      x: round1(cx + (b.x - cx) * footprint),
      y: round1(cy + (b.y - cy) * footprint),
    }));
    const canvasOutlines = scaled.map((b) => ({
      color: b.color,
      points: blobPath(b, rng).points.map((point) =>
        canvasPointFor(point, renderSize)
      ),
    }));
    const softnessScale =
      Math.min(renderSize.width, renderSize.height) / BASE_CANVAS_SIZE;
    const softness = round1(spec.softness * softnessScale * SOFTNESS_SCALE);
    const transform = fitTransformFor(
      mergeBounds(canvasOutlines.map((outline) => boundsFor(outline.points))),
      softness,
      renderSize,
      offsetX,
    );
    const outlines = canvasOutlines.map((outline) => ({
      color: outline.color,
      points: outline.points.map((point) => transformPoint(point, transform)),
    }));
    return { outlines, softness };
  }

  // The shared WASH treatment: wrap solid color `paths` in a progressive-sharpness blur → goo
  // (metaball alpha-contrast) → grain filter. A SHARP pass and the full SOFT pass are blended
  // through a low-frequency organic focus mask, so some regions resolve crisp and others stay
  // blurry (a depth-of-field look). `washSvg` only feeds different `paths`/geometry through it.
  // Focus parameters for the depth-of-field blend — WHERE and HOW MUCH the sharp pass shows
  // through. Pulled out so the internal palettes and an external consumer can each supply their
  // own (e.g. sub-blob patches so only PART of a blob resolves sharp).
  type WashFocus = {
    sharpSoftness: number; // sharp-pass blur stdDeviation (px)
    fx: number; // focus-noise frequency (≈ 1/patchPx) — finer ⇒ smaller, sub-blob sharp patches
    fy: number;
    contrast: number; // alpha gain on the focus noise (steeper ⇒ crisper sharp/soft split)
    bias: number; // alpha threshold (higher ⇒ MORE of the field resolves sharp)
  };

  function washSvg(
    paths: string,
    renderSize: RenderSize,
    softness: number,
    grain: number,
    focus: WashFocus,
  ): string {
    const { sharpSoftness, fx, fy } = focus;
    // Explicit width/height (not just a viewBox) gives the SVG a DEFINITE intrinsic
    // size so `background-size: cover` resolves reliably (else it can tile).
    const svg = [
      `<svg xmlns='http://www.w3.org/2000/svg' width='${renderSize.width}' `,
      `height='${renderSize.height}' `,
      `viewBox='0 0 ${renderSize.width} ${renderSize.height}' `,
      "preserveAspectRatio='xMidYMid slice'>",
      "<filter id='w' filterUnits='userSpaceOnUse' ",
      `x='0' y='0' width='${renderSize.width}' height='${renderSize.height}'>`,
      // SOFT pass FIRST (its stdDeviation drives the reserved blur gutter), then a SHARP pass.
      `<feGaussianBlur in='SourceGraphic' stdDeviation='${softness}' result='blurSoft'/>`,
      `<feGaussianBlur in='SourceGraphic' stdDeviation='${sharpSoftness}' result='blurSharp'/>`,
      // Focus mask: low-freq organic noise → an alpha map where alpha = "this region is SHARP".
      `<feTurbulence type='fractalNoise' baseFrequency='${fx} ${fy}' numOctaves='2' `,
      `seed='${FOCUS_SEED}' stitchTiles='stitch' result='focusNoise'/>`,
      "<feColorMatrix in='focusNoise' type='matrix' ",
      `values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${focus.contrast} 0 0 0 ${focus.bias}' result='focusMask'/>`,
      // sharp where the mask is opaque, soft where it isn't — merge into a progressive blend.
      "<feComposite in='blurSharp' in2='focusMask' operator='in' result='sharpPart'/>",
      "<feComposite in='blurSoft' in2='focusMask' operator='out' result='softPart'/>",
      "<feMerge result='blended'><feMergeNode in='softPart'/><feMergeNode in='sharpPart'/></feMerge>",
      // CONTRAST the alpha (identity RGB, alpha row only) so overlapping halos fuse — the "goo".
      "<feColorMatrix in='blended' type='matrix' ",
      `values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${GOO_ALPHA} ${GOO_BIAS}' result='goo'/>`,
      // mask grain to the fused mass and overlay it — grain only touches the shapes; the
      // gutter stays transparent.
      `<feTurbulence type='fractalNoise' baseFrequency='${SHAPE_GRAIN_FREQ}' `,
      "numOctaves='2' seed='7' stitchTiles='stitch' result='noise'/>",
      "<feColorMatrix in='noise' type='saturate' values='0' result='gray'/>",
      "<feComponentTransfer in='gray' result='grain'>",
      `<feFuncA type='linear' slope='${grain}'/>`,
      "</feComponentTransfer>",
      "<feComposite in='grain' in2='goo' operator='in' result='grainMasked'/>",
      "<feBlend in='goo' in2='grainMasked' mode='overlay'/>",
      "</filter>",
      `<g filter='url(#w)'>${paths}</g>`,
      "</svg>",
    ].join("");
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  // ---- Public wash API: render the SAME grainy-gradient treatment from EXTERNALLY-supplied
  // shapes (e.g. a decoupled, resizable `GeometrySource`) instead of the internal `placeBlobs`.
  // This is the seam the geometry pipeline plugs into: a source generates constant-size blobs
  // for the box, we color them and feed them through `washSvg`. ------------------------------

  // One externally-supplied blob: a closed SVG path `d` (in screen-space px) + its fill.
  export type WashOutline = {
    d: string;
    color: string;
  };

  // Depth-of-field control for the public wash: only PART of the field (and so only part of any
  // one blob, when `patchPx` < blob size) resolves sharp; the rest stays soft.
  export type WashSharpen = {
    ratio: number; // sharp-pass blur = softness · ratio (smaller ⇒ crisper sharp spots)
    patchPx: number; // px size of a sharp patch — set BELOW blob size so only part of a blob sharpens
    amount: number; // 0..1 — fraction of the field that resolves sharp (0 = uniformly soft)
  };

  export type WashOptions = {
    softness: number; // Gaussian blur stdDeviation (px) — the feather amount
    grain: number; // baked-noise strength
    sharpen: WashSharpen; // where/how much the wash resolves crisp vs soft
  };

  // Inset (px) a wash consumer should reserve on every edge so `softness`-blur doesn't clip at
  // the canvas edge. Mirrors the gutter `fitTransformFor` reserves for the internal pipeline.
  export function washGutterFor(softness: number): number {
    return Math.ceil(softness * BLUR_PAD_FACTOR + BLUR_PAD_EXTRA + EDGE_GUTTER);
  }

  // Render the grainy-gradient wash from pre-built outlines (blur → goo → grain), returning a
  // `url("data:image/svg+xml,…")` background string sized to `size`. The `sharpen` focus uses
  // absolute-px patches (so they hold their blob-relative scale as the canvas grows).
  export function washForShapes(
    outlines: readonly WashOutline[],
    size: RenderSize,
    options: WashOptions,
  ): string {
    const renderSize = renderSizeFor(size);
    const paths = outlines
      .map((outline) => `<path d='${outline.d}' fill='${outline.color}'/>`)
      .join("");
    const { sharpen } = options;
    const freq = round3(1 / Math.max(1, sharpen.patchPx));
    const amount = Math.max(0, Math.min(1, sharpen.amount));
    const focus: WashFocus = {
      sharpSoftness: round1(options.softness * sharpen.ratio),
      fx: freq,
      fy: freq,
      contrast: FOCUS_CONTRAST,
      // amount 0 ⇒ bias −contrast (mask all-soft); amount 1 ⇒ bias 0 (mask mostly sharp).
      bias: round3(-FOCUS_CONTRAST * (1 - amount)),
    };
    return washSvg(paths, renderSize, options.softness, options.grain, focus);
  }

  // One self-contained grainy-gradient SVG: SOLID organic color shapes, Gaussian-blurred and
  // then FUSED by a goo/metaball alpha-contrast so overlapping blobs melt into one seamless
  // mass with feathered edges (no clipped-radial ring); grain is baked in and MASKED to that
  // fused mass (so the gutter stays transparent — the white card shows through). `footprint`
  // scales the cluster about its centroid; `softness` is the blur; `grain` the noise strength.
  function shapesSvg(spec: ShapeSpec, size: RenderSize, offsetX: number): string {
    const renderSize = renderSizeFor(size);
    const { outlines, softness } = renderGeometryFor(spec, renderSize, offsetX);
    const paths = outlines
      .map((outline) => `<path d='${smoothPathD(outline.points)}' fill='${outline.color}'/>`)
      .join("");
    return washSvg(paths, renderSize, softness, spec.grain, productionFocus(softness, renderSize));
  }

  // Spec-driven wash for headless/offline raster generation (the `lona-atoms` colors generator):
  // the EXACT `shapesSvg` the 21 production palettes use, exposed as a `url("data:image/svg+xml,…")`
  // background string so a swept `ShapeSpec` re-renders byte-identically. Purely additive — the
  // production palettes (which go through `paletteFromSpec` → `shapesSvg`) are unaffected.
  export function washFromSpec(spec: ShapeSpec, size: RenderSize): string {
    return shapesSvg(spec, size, 0);
  }

  // The production depth-of-field: a few large LOW-frequency patches across the whole canvas. These
  // are the historical constants, so the 21 palettes (`shapesSvg`) render byte-for-byte identically.
  function productionFocus(softness: number, renderSize: RenderSize): WashFocus {
    return {
      sharpSoftness: round1(softness * SHARP_RATIO),
      fx: round3(FOCUS_PATCHES / renderSize.width),
      fy: round3(FOCUS_PATCHES / renderSize.height),
      contrast: FOCUS_CONTRAST,
      bias: FOCUS_BIAS,
    };
  }

  // Hairline outline so each blob reads as a distinct shape in the flat geometry view.
  const GEOMETRY_STROKE = "rgba(15, 23, 42, 0.45)";

  // The GEOMETRY behind `Gradient Splat — current`: the exact same placed/scaled blob outlines
  // the wash is built from, drawn FLAT — translucent fills + a hairline stroke, NO blur / goo /
  // grain — so a storybook toggle can show the backing shapes. Same `renderGeometryFor` as the
  // wash, so the geometry view lines up 1:1 with the splat.
  function geometrySvg(spec: ShapeSpec, size: RenderSize): string {
    const renderSize = renderSizeFor(size);
    const { outlines } = renderGeometryFor(spec, renderSize, 0);
    const paths = outlines
      .map(
        (outline) =>
          `<path d='${smoothPathD(outline.points)}' fill='${outline.color}' ` +
          `stroke='${GEOMETRY_STROKE}' stroke-width='1.5' stroke-linejoin='round'/>`,
      )
      .join("");
    const svg = [
      `<svg xmlns='http://www.w3.org/2000/svg' width='${renderSize.width}' `,
      `height='${renderSize.height}' `,
      `viewBox='0 0 ${renderSize.width} ${renderSize.height}' `,
      "preserveAspectRatio='xMidYMid slice'>",
      paths,
      "</svg>",
    ].join("");
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  // Authoring data: a color set + seed + per-variant tuning. `footprint` = cluster size
  // (the contained intrinsic size; ~0.5–0.78), `spread` = placement looseness,
  // `softness` = baked blur, `grain` = baked-noise strength. Dimness lives in the alphas.
  export type ShapeSpec = {
    label: string;
    seed: number;
    colors: readonly string[];
    footprint: number;
    spread: number;
    softness: number;
    grain: number;
  };

  // NOTE: indices 0–5 are pinned to hue-compatible families (blue/teal/green/citrus/
  // amber/red) — the ad-creative templates (`AD_CREATIVES` `bg: 0–5` in
  // gtm-bento-page.ts) index the background by number. Append new palettes; don't
  // reorder 0–5.
  export const SHAPE_SPECS: readonly ShapeSpec[] = [
    {
      label: "Aurora · adjacent", // cool-blue: sky · cyan · blue (ad bg 0)
      seed: 1013,
      colors: [
        "rgba(56, 189, 248, 0.48)",
        "rgba(34, 211, 238, 0.44)",
        "rgba(96, 165, 250, 0.44)",
      ],
      footprint: 0.64,
      spread: 1.0,
      softness: 3.4,
      grain: 0.7,
    },
    {
      label: "Lagoon · adjacent", // teal · cyan · mint (ad bg 1)
      seed: 2027,
      colors: [
        "rgba(45, 212, 191, 0.48)",
        "rgba(34, 211, 238, 0.44)",
        "rgba(110, 231, 183, 0.44)",
      ],
      footprint: 0.62,
      spread: 0.98,
      softness: 3.2,
      grain: 0.7,
    },
    {
      label: "Meadow · adjacent", // emerald · green · lime (ad bg 2)
      seed: 3041,
      colors: [
        "rgba(52, 211, 153, 0.48)",
        "rgba(74, 222, 128, 0.44)",
        "rgba(163, 230, 53, 0.4)",
      ],
      footprint: 0.66,
      spread: 1.04,
      softness: 3.2,
      grain: 0.7,
    },
    {
      label: "Citrus · adjacent", // lime · yellow · amber, muted/tight (ad bg 3)
      seed: 4051,
      colors: [
        "rgba(163, 230, 53, 0.4)",
        "rgba(250, 204, 21, 0.4)",
        "rgba(251, 191, 36, 0.36)",
      ],
      footprint: 0.54,
      spread: 0.9,
      softness: 3.0,
      grain: 0.65,
    },
    {
      label: "Sunset · adjacent", // amber · orange · coral, spread/soft (ad bg 4)
      seed: 5077,
      colors: [
        "rgba(251, 191, 36, 0.48)",
        "rgba(251, 146, 60, 0.46)",
        "rgba(248, 113, 113, 0.44)",
      ],
      footprint: 0.72,
      spread: 1.1,
      softness: 3.8,
      grain: 0.7,
    },
    {
      label: "Ember · adjacent", // red · coral · rose (ad bg 5)
      seed: 6089,
      colors: [
        "rgba(239, 68, 68, 0.44)",
        "rgba(248, 113, 113, 0.44)",
        "rgba(244, 114, 182, 0.4)",
      ],
      footprint: 0.62,
      spread: 0.98,
      softness: 3.2,
      grain: 0.7,
    },
    {
      label: "Cobalt & Amber · complementary", // blue ↔ amber, vibrant + big spread
      seed: 7103,
      colors: [
        "rgba(37, 99, 235, 0.46)",
        "rgba(59, 130, 246, 0.42)",
        "rgba(251, 191, 36, 0.46)",
        "rgba(250, 204, 21, 0.42)",
      ],
      footprint: 0.76,
      spread: 1.12,
      softness: 3.4,
      grain: 0.7,
    },
    {
      label: "Orchid & Lime · complementary", // violet ↔ lime, a bit muted
      seed: 8111,
      colors: [
        "rgba(168, 85, 247, 0.4)",
        "rgba(139, 92, 246, 0.36)",
        "rgba(163, 230, 53, 0.38)",
      ],
      footprint: 0.66,
      spread: 1.06,
      softness: 3.4,
      grain: 0.62,
    },
    {
      label: "Reef · complementary", // teal ↔ coral, vibrant
      seed: 9127,
      colors: [
        "rgba(20, 184, 166, 0.46)",
        "rgba(34, 211, 238, 0.42)",
        "rgba(251, 113, 113, 0.44)",
        "rgba(251, 146, 60, 0.4)",
      ],
      footprint: 0.7,
      spread: 1.08,
      softness: 3.2,
      grain: 0.7,
    },
    {
      label: "Carnival · triadic", // coral + emerald + violet, crisper
      seed: 10139,
      colors: [
        "rgba(248, 113, 113, 0.44)",
        "rgba(52, 211, 153, 0.44)",
        "rgba(167, 139, 250, 0.44)",
      ],
      footprint: 0.68,
      spread: 1.06,
      softness: 2.6,
      grain: 0.7,
    },
    {
      label: "Festival · triadic", // orange + green + blue-violet
      seed: 11149,
      colors: [
        "rgba(251, 146, 60, 0.44)",
        "rgba(74, 222, 128, 0.42)",
        "rgba(99, 102, 241, 0.42)",
      ],
      footprint: 0.66,
      spread: 1.02,
      softness: 2.8,
      grain: 0.68,
    },
    {
      label: "Mist · mono", // blue pale → deep — DIM, tight, very soft
      seed: 12157,
      colors: [
        "rgba(147, 197, 253, 0.32)",
        "rgba(96, 165, 250, 0.3)",
        "rgba(59, 130, 246, 0.3)",
      ],
      footprint: 0.5,
      spread: 0.86,
      softness: 4.2,
      grain: 0.6,
    },
    {
      label: "Dusk · mono", // rose/mauve pale → deep — DIM, tight, soft
      seed: 13171,
      colors: [
        "rgba(249, 168, 212, 0.3)",
        "rgba(244, 114, 182, 0.3)",
        "rgba(192, 132, 252, 0.28)",
      ],
      footprint: 0.52,
      spread: 0.88,
      softness: 4.0,
      grain: 0.58,
    },
    {
      label: "Prism · rainbow", // full spectrum, vibrant + big spread
      seed: 14197,
      colors: [
        "rgba(248, 113, 113, 0.4)",
        "rgba(250, 204, 21, 0.38)",
        "rgba(74, 222, 128, 0.38)",
        "rgba(56, 189, 248, 0.38)",
        "rgba(167, 139, 250, 0.38)",
      ],
      footprint: 0.78,
      spread: 1.12,
      softness: 3.4,
      grain: 0.7,
    },
    {
      label: "Glacier · adjacent", // icy blue: ice · sky · pale-blue
      seed: 15013,
      colors: [
        "rgba(125, 211, 252, 0.46)",
        "rgba(56, 189, 248, 0.44)",
        "rgba(186, 230, 253, 0.4)",
      ],
      footprint: 0.64,
      spread: 1.0,
      softness: 3.6,
      grain: 0.68,
    },
    {
      label: "Coral · adjacent", // warm pink → coral → orange
      seed: 16033,
      colors: [
        "rgba(251, 113, 133, 0.48)",
        "rgba(248, 113, 113, 0.46)",
        "rgba(251, 146, 60, 0.42)",
      ],
      footprint: 0.66,
      spread: 1.04,
      softness: 3.2,
      grain: 0.7,
    },
    {
      label: "Sunset & Sea · complementary", // orange ↔ blue, vibrant + big spread
      seed: 17041,
      colors: [
        "rgba(251, 146, 60, 0.48)",
        "rgba(251, 191, 36, 0.42)",
        "rgba(56, 189, 248, 0.46)",
        "rgba(37, 99, 235, 0.42)",
      ],
      footprint: 0.76,
      spread: 1.12,
      softness: 3.4,
      grain: 0.7,
    },
    {
      label: "Rose & Pine · complementary", // pink ↔ green
      seed: 18061,
      colors: [
        "rgba(244, 114, 182, 0.46)",
        "rgba(236, 72, 153, 0.4)",
        "rgba(52, 211, 153, 0.44)",
        "rgba(74, 222, 128, 0.4)",
      ],
      footprint: 0.7,
      spread: 1.08,
      softness: 3.2,
      grain: 0.68,
    },
    {
      label: "Primary · triadic", // red + yellow + blue
      seed: 19073,
      colors: [
        "rgba(248, 113, 113, 0.44)",
        "rgba(250, 204, 21, 0.42)",
        "rgba(59, 130, 246, 0.44)",
      ],
      footprint: 0.68,
      spread: 1.06,
      softness: 2.6,
      grain: 0.7,
    },
    {
      label: "Sage · mono", // muted green pale → deep — DIM, tight, soft
      seed: 20089,
      colors: [
        "rgba(200, 214, 170, 0.34)",
        "rgba(150, 185, 130, 0.32)",
        "rgba(94, 140, 96, 0.3)",
      ],
      footprint: 0.5,
      spread: 0.88,
      softness: 4.0,
      grain: 0.58,
    },
  ];

  // A soft gradient of the palette's OWN colors (alpha stripped → solid), for a surface in front
  // of the wash to tint at a low opacity so it coordinates with the splat.
  // Strip a color's alpha → solid `rgb(...)`. Exported so curated section-tints can
  // mix a wash's own color into var(--bg).
  export function solidColorOf(rgba: string): string {
    const m = rgba.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : rgba;
  }

  function softBackgroundFor(spec: ShapeSpec): string {
    return `linear-gradient(135deg, ${spec.colors.map(solidColorOf).join(", ")})`;
  }

  function paletteFromSpec(spec: ShapeSpec): Palette {
    const cache = new Map<string, string>();
    const geometryCache = new Map<string, string>();
    const backgroundForSize = (size: RenderSize, offsetX: number): string => {
      const renderSize = renderSizeFor(size);
      const key = `${sizeKey(renderSize)}@${offsetX}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const background = shapesSvg(spec, renderSize, offsetX);
      cache.set(key, background);
      return background;
    };
    const geometryForSize = (size: RenderSize): string => {
      const renderSize = renderSizeFor(size);
      const key = sizeKey(renderSize);
      const cached = geometryCache.get(key);
      if (cached) return cached;
      const geometry = geometrySvg(spec, renderSize);
      geometryCache.set(key, geometry);
      return geometry;
    };
    return {
      label: spec.label,
      blur: "none",
      background: backgroundForSize(DEFAULT_RENDER_SIZE, 0),
      backgroundForSize,
      geometryForSize,
      softBackground: softBackgroundFor(spec),
    };
  }

  // Public wrapper over the private paletteFromSpec so the curated-washes module can
  // build Palette caches for arbitrary specs (the operator-curated set).
  export function paletteForSpec(spec: ShapeSpec): Palette {
    return paletteFromSpec(spec);
  }

  export const PALETTES: readonly Palette[] = SHAPE_SPECS.map(paletteFromSpec);
}
