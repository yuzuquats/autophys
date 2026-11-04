import { PixelImage } from "@tento-core/pixel-image";

/** DOM-free PNG alpha decoding and vector SVG cutout generation for stickers. */
export namespace StickerCutoutOutline {
  export type PngColorType = PixelImage.PngColorType;

  export type PngMetadata = PixelImage.PngMetadata;

  export type RgbaImage = PixelImage.RgbaImage;

  export type Stroke = {
    widthPx: number;
    color: string;
    opacity: number;
  };

  export type Shadow = {
    dxPx: number;
    dyPx: number;
    blurPx: number;
    color: string;
    opacity: number;
  };

  export type Technique = "catmull-rom" | "chaikin" | "chaikin-cubic";
  export type BackgroundCleanup = PixelImage.BackgroundCleanup;

  /** A vertex in the cutout's viewBox coordinate space (px). Same shape as
   *  LayoutUtils.Point; re-declared here to keep this module DOM-free. */
  export type Point = {
    x: number;
    y: number;
  };

  export type Style = Optional<{
    paddingPx: number;
    cutoutWidthPx: number;
    smoothingPx: number;
    technique: Technique;
    growPx: number;
    roundPx: number;
    smoothPx: number;
    fill: string;
    stroke: Option<Stroke>;
    shadow: Shadow;
    alphaThreshold: number;
    edgeBleedPx: number;
  }>;

  export type Options = Optional<{
    id: string;
    style: Style;
    rasterScale: number;
    backgroundCleanup: BackgroundCleanup;
    trimTransparentPadding: boolean;
    /** Back-compat alias for `rasterScale`. New callers should use
     *  `rasterScale` so it is clear this is the intrinsic pixel-art backing
     *  scale, not the final screen-space display size. */
    scale: number;
  }>;

  export type ResolvedStyle = {
    paddingPx: number;
    cutoutWidthPx: number;
    roundPx: number;
    smoothingPx: number;
    technique: Technique;
    fill: string;
    stroke: Option<Stroke>;
    shadow: Shadow;
    alphaThreshold: number;
    edgeBleedPx: number;
  };

  export type Result = {
    metadata: PngMetadata;
    rasterScale: number;
    /** Back-compat alias for `rasterScale`. */
    scale: number;
    paddingPx: number;
    cutoutWidthPx: number;
    smoothingPx: number;
    technique: Technique;
    alphaThreshold: number;
    edgeBleedPx: number;
    artworkWidth: number;
    artworkHeight: number;
    artworkOffsetX: number;
    artworkOffsetY: number;
    width: number;
    height: number;
    viewBox: string;
    /** Nearest-neighbor raster backing PNG after `rasterScale` is applied. */
    pngDataUrl: string;
    svgText: string;
    svgDataUrl: string;
    pathData: string;
    /** All closed marching-squares loops in viewBox coords (px), same space as
     *  `pathData`/`viewBox`; includes interior holes when present. Diagnostic —
     *  packing uses `perimeter`. */
    outlineLoops: StickerCutoutOutline.Point[][];
    /** The OUTER perimeter as a single simple polygon (no holes): the loop with
     *  the largest |signed area|, in viewBox coords. Holes are NOT permitted
     *  downstream, so only this loop feeds silhouette packing. */
    perimeter: StickerCutoutOutline.Point[];
  };

  export const DEFAULT_STYLE: ResolvedStyle = {
    paddingPx: 14,
    cutoutWidthPx: 12,
    roundPx: 5,
    smoothingPx: 8,
    technique: "chaikin-cubic",
    fill: "#ffffff",
    stroke: null,
    shadow: {
      dxPx: 0,
      dyPx: 4,
      blurPx: 3,
      color: "#000000",
      opacity: 0.28,
    },
    alphaThreshold: 64,
    edgeBleedPx: 0.7,
  };

  export function parsePngMetadata(pngBytes: Uint8Array): PngMetadata {
    return PixelImage.parsePngMetadata(pngBytes);
  }

  export async function generateSvgFromPngBytes(
    pngBytes: Uint8Array,
    options: Options,
  ): Promise<Result> {
    const image = await PixelImage.decodePng(pngBytes);
    return generateSvgFromRgbaImageWithMetadata(
      image,
      PixelImage.parsePngMetadata(pngBytes),
      options,
    );
  }

  export function generateSvgFromRgbaImage(
    image: RgbaImage,
    options: Options,
  ): Result {
    return generateSvgFromRgbaImageWithMetadata(
      image,
      PixelImage.metadataFromRgbaImage(image),
      options,
    );
  }

  function generateSvgFromRgbaImageWithMetadata(
    image: RgbaImage,
    metadata: PngMetadata,
    options: Options,
  ): Result {
    const rasterScale = resolveRasterScale(
      options?.rasterScale ?? options?.scale ?? 1,
    );
    const style = resolveStyle(options?.style ?? null);
    const sourceImage = PixelImage.cleanForStickerUse(image, {
      backgroundCleanup: options?.backgroundCleanup ?? null,
      trimTransparentPadding: options?.trimTransparentPadding === true,
      alphaThreshold: style.alphaThreshold,
    });
    const scaledImage = PixelImage.scaleNearest(sourceImage, rasterScale);
    const scaledMask = alphaMaskFromImage(scaledImage);
    const strokeWidth = style.stroke?.widthPx ?? 0;
    // The cutout SVG is a pure shape (no baked shadow) — depth is applied
    // as a separate layer per surface (see StickerCutoutPreview `depth`),
    // so the host only needs room for the cutout band + smoothing + stroke,
    // not for a drop shadow's offset/blur.
    const effectPadding = Math.ceil(
      style.cutoutWidthPx +
        style.smoothingPx +
        strokeWidth,
    );
    const paddingPx = Math.max(style.paddingPx, effectPadding);
    const paddedMask = padAlphaMask(
      scaledMask,
      paddingPx,
      style.alphaThreshold,
    );
    const distanceField = buildDistanceField(paddedMask);
    const { pathData, loops } = traceDistanceFieldToPath(
      distanceField,
      style.cutoutWidthPx + 0.5,
      style.smoothingPx,
      style.technique,
    );

    if (pathData.length === 0) {
      throw new Error("PNG has no visible alpha to outline");
    }

    const perimeter = outerPerimeter(loops);

    const width = distanceField.width;
    const height = distanceField.height;
    const viewBox = `0 0 ${width} ${height}`;
    const pngDataUrl = PixelImage.pngBytesToDataUrl(
      PixelImage.encodePng(scaledImage),
    );
    const svgText = buildSvg({
      width,
      height,
      viewBox,
      pathData,
      style,
    });

    return {
      metadata,
      rasterScale,
      scale: rasterScale,
      paddingPx,
      cutoutWidthPx: style.cutoutWidthPx,
      smoothingPx: style.smoothingPx,
      technique: style.technique,
      alphaThreshold: style.alphaThreshold,
      edgeBleedPx: style.edgeBleedPx,
      artworkWidth: scaledMask.width,
      artworkHeight: scaledMask.height,
      artworkOffsetX: paddingPx,
      artworkOffsetY: paddingPx,
      width,
      height,
      viewBox,
      pngDataUrl,
      svgText,
      svgDataUrl: svgTextToDataUrl(svgText),
      pathData,
      outlineLoops: loops,
      perimeter,
    };
  }

  export function pngBytesToDataUrl(pngBytes: Uint8Array): string {
    return PixelImage.pngBytesToDataUrl(pngBytes);
  }

  export function pngDataUrlToBytes(dataUrl: string): Uint8Array {
    return PixelImage.pngDataUrlToBytes(dataUrl);
  }

  export function svgTextToDataUrl(svgText: string): string {
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svgText)}`;
  }

  /**
   * Build a standalone inner-shadow SVG for a cutout silhouette, sized to
   * the cutout's box. The recessed `depth` of `StickerCutoutPreview`
   * overlays this so the same shape reads "in reverse" — pressed into the
   * source sheet. An inner shadow on an arbitrary silhouette can't be
   * expressed with CSS `box-shadow: inset` (that follows the rectangular
   * box), so it's an SVG filter: invert the shape alpha, blur + offset it,
   * composite it back inside the silhouette, then tint it.
   */
  export function buildInnerShadowSvg(
    pathData: string,
    viewBox: string,
    width: number,
    height: number,
    shadow: Shadow,
  ): string {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">`,
      "  <defs>",
      '    <filter id="sticker-inner-shadow" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">',
      '      <feComponentTransfer in="SourceAlpha" result="inverse">',
      '        <feFuncA type="table" tableValues="1 0" />',
      "      </feComponentTransfer>",
      `      <feGaussianBlur in="inverse" stdDeviation="${
        formatNumber(shadow.blurPx)
      }" result="blur" />`,
      `      <feOffset in="blur" dx="${formatNumber(shadow.dxPx)}" dy="${
        formatNumber(shadow.dyPx)
      }" result="offset" />`,
      '      <feComposite in="offset" in2="SourceAlpha" operator="in" result="clipped" />',
      `      <feFlood flood-color="${escapeXml(shadow.color)}" flood-opacity="${
        formatNumber(shadow.opacity)
      }" result="tint" />`,
      '      <feComposite in="tint" in2="clipped" operator="in" result="shadow" />',
      "    </filter>",
      "  </defs>",
      `  <path d="${pathData}" fill="#000000" filter="url(#sticker-inner-shadow)" shape-rendering="geometricPrecision" />`,
      "</svg>",
    ].join("\n");
  }
}

type AlphaMask = {
  width: number;
  height: number;
  data: Uint8Array;
};

type RgbaImage = StickerCutoutOutline.RgbaImage;

type DistanceField = {
  width: number;
  height: number;
  data: Float64Array;
};

type Point = StickerCutoutOutline.Point;

type Segment = {
  start: Point;
  end: Point;
};

type SvgBuildInput = {
  width: number;
  height: number;
  viewBox: string;
  pathData: string;
  style: StickerCutoutOutline.ResolvedStyle;
};

function alphaMaskFromImage(image: RgbaImage): AlphaMask {
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = image.data[i * 4 + 3];
  }
  return {
    width: image.width,
    height: image.height,
    data,
  };
}

function resolveRasterScale(rasterScale: number): number {
  if (!Number.isInteger(rasterScale) || rasterScale < 1) {
    throw new Error(
      `Sticker cutout rasterScale must be a positive integer, got ${rasterScale}`,
    );
  }
  return rasterScale;
}

function padAlphaMask(
  mask: AlphaMask,
  paddingPx: number,
  alphaThreshold: number,
): AlphaMask {
  const width = mask.width + paddingPx * 2;
  const height = mask.height + paddingPx * 2;
  const data = new Uint8Array(width * height);

  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x] >= alphaThreshold) {
        data[(y + paddingPx) * width + x + paddingPx] = 1;
      }
    }
  }

  return { width, height, data };
}

const DISTANCE_INFINITY = 1_000_000_000;

function buildDistanceField(mask: AlphaMask): DistanceField {
  const initial = new Float64Array(mask.data.length);
  initial.fill(DISTANCE_INFINITY);
  let hasSeed = false;

  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] > 0) {
      initial[i] = 0;
      hasSeed = true;
    }
  }

  if (!hasSeed) {
    throw new Error("PNG has no visible alpha to outline");
  }

  const columnPass = new Float64Array(initial.length);
  for (let x = 0; x < mask.width; x++) {
    const column = new Float64Array(mask.height);
    for (let y = 0; y < mask.height; y++) {
      column[y] = initial[y * mask.width + x];
    }

    const transformed = distanceTransform1D(column);
    for (let y = 0; y < mask.height; y++) {
      columnPass[y * mask.width + x] = transformed[y];
    }
  }

  const data = new Float64Array(initial.length);
  for (let y = 0; y < mask.height; y++) {
    const row = new Float64Array(mask.width);
    for (let x = 0; x < mask.width; x++) {
      row[x] = columnPass[y * mask.width + x];
    }

    const transformed = distanceTransform1D(row);
    for (let x = 0; x < mask.width; x++) {
      data[y * mask.width + x] = transformed[x];
    }
  }

  return {
    width: mask.width,
    height: mask.height,
    data,
  };
}

function distanceTransform1D(values: Float64Array): Float64Array {
  const result = new Float64Array(values.length);
  result.fill(DISTANCE_INFINITY);

  const firstFinite = firstFiniteIndex(values);
  if (firstFinite < 0) return result;

  const locations = new Int32Array(values.length);
  const boundaries = new Float64Array(values.length + 1);
  let envelopeIndex = 0;
  locations[0] = firstFinite;
  boundaries[0] = Number.NEGATIVE_INFINITY;
  boundaries[1] = Number.POSITIVE_INFINITY;

  for (let q = firstFinite + 1; q < values.length; q++) {
    if (!isFiniteDistance(values[q])) continue;

    let boundary = parabolaIntersection(values, q, locations[envelopeIndex]);
    while (boundary <= boundaries[envelopeIndex]) {
      envelopeIndex--;
      boundary = parabolaIntersection(values, q, locations[envelopeIndex]);
    }

    envelopeIndex++;
    locations[envelopeIndex] = q;
    boundaries[envelopeIndex] = boundary;
    boundaries[envelopeIndex + 1] = Number.POSITIVE_INFINITY;
  }

  envelopeIndex = 0;
  for (let q = 0; q < values.length; q++) {
    while (boundaries[envelopeIndex + 1] < q) {
      envelopeIndex++;
    }

    const location = locations[envelopeIndex];
    const offset = q - location;
    result[q] = offset * offset + values[location];
  }

  return result;
}

function firstFiniteIndex(values: Float64Array): number {
  for (let i = 0; i < values.length; i++) {
    if (isFiniteDistance(values[i])) return i;
  }
  return -1;
}

function isFiniteDistance(value: number): boolean {
  return value < DISTANCE_INFINITY / 2;
}

function parabolaIntersection(
  values: Float64Array,
  leftIndex: number,
  rightIndex: number,
): number {
  return (
    (values[leftIndex] + leftIndex * leftIndex -
      (values[rightIndex] + rightIndex * rightIndex)) /
    (2 * leftIndex - 2 * rightIndex)
  );
}

function traceDistanceFieldToPath(
  field: DistanceField,
  contourLevelPx: number,
  smoothingPx: number,
  technique: StickerCutoutOutline.Technique,
): { pathData: string; loops: Point[][] } {
  const segments: Segment[] = [];

  for (let y = 0; y < field.height - 1; y++) {
    for (let x = 0; x < field.width - 1; x++) {
      const topLeft = sqrtDistanceAt(field, x, y);
      const topRight = sqrtDistanceAt(field, x + 1, y);
      const bottomRight = sqrtDistanceAt(field, x + 1, y + 1);
      const bottomLeft = sqrtDistanceAt(field, x, y + 1);
      const squareIndex = (topLeft <= contourLevelPx ? 1 : 0) |
        (topRight <= contourLevelPx ? 2 : 0) |
        (bottomRight <= contourLevelPx ? 4 : 0) |
        (bottomLeft <= contourLevelPx ? 8 : 0);

      if (squareIndex === 0 || squareIndex === 15) continue;

      const top = interpolateContourPoint(
        { x: x + 0.5, y: y + 0.5 },
        { x: x + 1.5, y: y + 0.5 },
        topLeft,
        topRight,
        contourLevelPx,
      );
      const right = interpolateContourPoint(
        { x: x + 1.5, y: y + 0.5 },
        { x: x + 1.5, y: y + 1.5 },
        topRight,
        bottomRight,
        contourLevelPx,
      );
      const bottom = interpolateContourPoint(
        { x: x + 0.5, y: y + 1.5 },
        { x: x + 1.5, y: y + 1.5 },
        bottomLeft,
        bottomRight,
        contourLevelPx,
      );
      const left = interpolateContourPoint(
        { x: x + 0.5, y: y + 0.5 },
        { x: x + 0.5, y: y + 1.5 },
        topLeft,
        bottomLeft,
        contourLevelPx,
      );

      addContourSegmentsForCell(
        segments,
        squareIndex,
        top,
        right,
        bottom,
        left,
      );
    }
  }

  const loops = connectSegmentsToLoops(segments);
  const paths: string[] = [];
  for (const loop of loops) {
    paths.push(loopPath(loop, smoothingPx, technique));
  }
  return { pathData: paths.join(" "), loops };
}

function sqrtDistanceAt(field: DistanceField, x: number, y: number): number {
  return Math.sqrt(field.data[y * field.width + x]);
}

function interpolateContourPoint(
  start: Point,
  end: Point,
  startValue: number,
  endValue: number,
  contourLevelPx: number,
): Point {
  const denominator = endValue - startValue;
  const rawT = denominator === 0
    ? 0.5
    : (contourLevelPx - startValue) / denominator;
  const t = clamp(rawT, 0, 1);
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function addContourSegmentsForCell(
  segments: Segment[],
  squareIndex: number,
  top: Point,
  right: Point,
  bottom: Point,
  left: Point,
): void {
  if (squareIndex === 1) addContourSegment(segments, left, top);
  else if (squareIndex === 2) addContourSegment(segments, top, right);
  else if (squareIndex === 3) addContourSegment(segments, left, right);
  else if (squareIndex === 4) addContourSegment(segments, right, bottom);
  else if (squareIndex === 5) {
    addContourSegment(segments, left, top);
    addContourSegment(segments, right, bottom);
  } else if (squareIndex === 6) addContourSegment(segments, top, bottom);
  else if (squareIndex === 7) addContourSegment(segments, left, bottom);
  else if (squareIndex === 8) addContourSegment(segments, bottom, left);
  else if (squareIndex === 9) addContourSegment(segments, top, bottom);
  else if (squareIndex === 10) {
    addContourSegment(segments, top, right);
    addContourSegment(segments, bottom, left);
  } else if (squareIndex === 11) addContourSegment(segments, right, bottom);
  else if (squareIndex === 12) addContourSegment(segments, left, right);
  else if (squareIndex === 13) addContourSegment(segments, top, right);
  else if (squareIndex === 14) addContourSegment(segments, left, top);
}

function addContourSegment(
  segments: Segment[],
  start: Point,
  end: Point,
): void {
  if (samePoint(start, end)) return;
  segments.push({ start, end });
}

function connectSegmentsToLoops(segments: Segment[]): Point[][] {
  const remaining = segments.slice();
  const loops: Point[][] = [];

  while (remaining.length > 0) {
    const segment = remaining[remaining.length - 1];
    remaining.splice(remaining.length - 1, 1);
    const loop: Point[] = [segment.start, segment.end];
    let changed = true;

    while (changed) {
      changed = false;

      for (let i = remaining.length - 1; i >= 0; i--) {
        const candidate = remaining[i];
        const first = loop[0];
        const last = loop[loop.length - 1];

        if (samePoint(last, candidate.start)) {
          loop.push(candidate.end);
        } else if (samePoint(last, candidate.end)) {
          loop.push(candidate.start);
        } else if (samePoint(first, candidate.end)) {
          loop.unshift(candidate.start);
        } else if (samePoint(first, candidate.start)) {
          loop.unshift(candidate.end);
        } else {
          continue;
        }

        remaining.splice(i, 1);
        changed = true;
        break;
      }
    }

    if (loop.length > 2 && samePoint(loop[0], loop[loop.length - 1])) {
      loop.pop();
    }

    const cleanedLoop = removeSequentialDuplicatePoints(loop);
    if (cleanedLoop.length >= 3) {
      loops.push(cleanedLoop);
    }
  }

  return loops;
}

/** Shoelace signed area of a closed polygon loop. Sign encodes winding;
 *  magnitude is the enclosed area. */
function signedArea(loop: Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** The outer perimeter loop — the one enclosing the most area (largest
 *  |signed area|). Returns [] when there are no loops. Interior holes (smaller
 *  loops) are intentionally dropped: silhouette packing uses the solid hull. */
function outerPerimeter(loops: Point[][]): Point[] {
  let best: Point[] = [];
  let bestAbs = -1;
  for (const loop of loops) {
    const abs = Math.abs(signedArea(loop));
    if (abs > bestAbs) {
      bestAbs = abs;
      best = loop;
    }
  }
  return best;
}

function removeSequentialDuplicatePoints(points: Point[]): Point[] {
  const deduped: Point[] = [];
  for (const point of points) {
    if (
      deduped.length === 0 || !samePoint(deduped[deduped.length - 1], point)
    ) {
      deduped.push(point);
    }
  }

  if (
    deduped.length > 2 && samePoint(deduped[0], deduped[deduped.length - 1])
  ) {
    deduped.pop();
  }

  return deduped;
}

function samePoint(a: Point, b: Point): boolean {
  return sameRoundedCoordinate(a.x, b.x) && sameRoundedCoordinate(a.y, b.y);
}

function sameRoundedCoordinate(a: number, b: number): boolean {
  // A gap of 0.002 cannot round to the same three-decimal value. Nearby
  // coordinates still use exact string rounding, including signed zero and NaN.
  if (a === b) return true;
  if (Math.abs(a - b) >= 0.002) return false;
  return a.toFixed(3) === b.toFixed(3);
}

function loopPath(
  points: Point[],
  smoothingPx: number,
  technique: StickerCutoutOutline.Technique,
): string {
  if (technique === "chaikin") {
    return chaikinLoopPath(points, smoothingPx);
  }
  if (technique === "chaikin-cubic") {
    return chaikinCubicLoopPath(points, smoothingPx);
  }
  return catmullRomLoopPath(points, smoothingPx);
}

function catmullRomLoopPath(points: Point[], smoothingPx: number): string {
  const simplifiedPoints = simplifyClosedLoop(
    simplifyLoop(points),
    smoothingPx,
  );
  if (smoothingPx <= 0 || simplifiedPoints.length < 4) {
    return polylineLoopPath(simplifiedPoints);
  }

  return cubicLoopPath(simplifiedPoints);
}

function cubicLoopPath(points: Point[]): string {
  const path: string[] = [`M ${formatPoint(points[0])}`];
  const tension = 0.55;
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const point = points[i];
    const next = points[(i + 1) % points.length];
    const nextNext = points[(i + 2) % points.length];
    const control1 = {
      x: point.x + ((next.x - prev.x) * tension) / 6,
      y: point.y + ((next.y - prev.y) * tension) / 6,
    };
    const control2 = {
      x: next.x - ((nextNext.x - point.x) * tension) / 6,
      y: next.y - ((nextNext.y - point.y) * tension) / 6,
    };
    path.push(
      `C ${formatPoint(control1)} ${formatPoint(control2)} ${
        formatPoint(next)
      }`,
    );
  }
  path.push("Z");
  return path.join(" ");
}

function chaikinLoopPath(points: Point[], smoothingPx: number): string {
  return polylineLoopPath(chaikinSmoothedLoop(points, smoothingPx));
}

function chaikinCubicLoopPath(points: Point[], smoothingPx: number): string {
  const smoothedPoints = chaikinSmoothedLoop(points, smoothingPx);
  if (smoothingPx <= 0 || smoothedPoints.length < 4) {
    return polylineLoopPath(smoothedPoints);
  }
  return cubicLoopPath(smoothedPoints);
}

function chaikinSmoothedLoop(points: Point[], smoothingPx: number): Point[] {
  const simplifyTolerancePx = Math.min(Math.max(smoothingPx, 0) * 0.25, 2);
  let smoothedPoints = simplifyClosedLoop(
    simplifyLoop(points),
    simplifyTolerancePx,
  );
  if (smoothingPx <= 0 || smoothedPoints.length < 4) {
    return smoothedPoints;
  }

  const iterations = chaikinIterationCount(smoothingPx);
  for (let i = 0; i < iterations; i++) {
    smoothedPoints = chaikinClosedLoop(smoothedPoints);
  }
  return smoothedPoints;
}

function chaikinIterationCount(smoothingPx: number): number {
  return Math.round(clamp(Math.ceil(smoothingPx / 2), 1, 4));
}

function chaikinClosedLoop(points: Point[]): Point[] {
  const smoothed: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    smoothed.push(
      {
        x: current.x * 0.75 + next.x * 0.25,
        y: current.y * 0.75 + next.y * 0.25,
      },
      {
        x: current.x * 0.25 + next.x * 0.75,
        y: current.y * 0.25 + next.y * 0.75,
      },
    );
  }
  return smoothed;
}

function polylineLoopPath(points: Point[]): string {
  const path: string[] = [`M ${formatPoint(points[0])}`];
  for (let i = 1; i < points.length; i++) {
    path.push(`L ${formatPoint(points[i])}`);
  }
  path.push("Z");
  return path.join(" ");
}

function simplifyLoop(points: Point[]): Point[] {
  if (points.length <= 3) return points;

  const simplified: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const point = points[i];
    const next = points[(i + 1) % points.length];

    if (isNearlyCollinear(prev, point, next)) continue;
    simplified.push(point);
  }

  return simplified.length >= 3 ? simplified : points;
}

function isNearlyCollinear(prev: Point, point: Point, next: Point): boolean {
  if (samePoint(prev, point) || samePoint(point, next)) return true;
  return perpendicularDistance(point, prev, next) <= 0.001;
}

function simplifyClosedLoop(points: Point[], tolerancePx: number): Point[] {
  if (points.length <= 4 || tolerancePx <= 0) return points;

  const startIndex = 0;
  const oppositeIndex = farthestPointIndex(points, points[startIndex]);
  if (oppositeIndex === startIndex) return points;

  const firstArc = collectLoopArc(points, startIndex, oppositeIndex);
  const secondArc = collectLoopArc(points, oppositeIndex, startIndex);
  const firstSimplified = simplifyOpenPolyline(firstArc, tolerancePx);
  const secondSimplified = simplifyOpenPolyline(secondArc, tolerancePx);
  const combined = firstSimplified.concat(
    secondSimplified.slice(1, secondSimplified.length - 1),
  );

  return combined.length >= 4 ? combined : points;
}

function collectLoopArc(
  points: Point[],
  startIndex: number,
  endIndex: number,
): Point[] {
  const arc: Point[] = [];
  let index = startIndex;

  while (true) {
    arc.push(points[index]);
    if (index === endIndex) break;
    index = (index + 1) % points.length;
  }

  return arc;
}

function farthestPointIndex(points: Point[], origin: Point): number {
  let farthestIndex = 0;
  let farthestDistance = -1;

  for (let i = 0; i < points.length; i++) {
    const candidateDistance = distance(points[i], origin);
    if (candidateDistance > farthestDistance) {
      farthestDistance = candidateDistance;
      farthestIndex = i;
    }
  }

  return farthestIndex;
}

function simplifyOpenPolyline(points: Point[], tolerancePx: number): Point[] {
  if (points.length <= 2) return points;

  const first = points[0];
  const last = points[points.length - 1];
  let maxDistance = 0;
  let splitIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const candidateDistance = perpendicularDistance(points[i], first, last);
    if (candidateDistance > maxDistance) {
      maxDistance = candidateDistance;
      splitIndex = i;
    }
  }

  if (maxDistance <= tolerancePx) return [first, last];

  const left = simplifyOpenPolyline(
    points.slice(0, splitIndex + 1),
    tolerancePx,
  );
  const right = simplifyOpenPolyline(points.slice(splitIndex), tolerancePx);
  return left.slice(0, left.length - 1).concat(right);
}

function perpendicularDistance(
  point: Point,
  lineStart: Point,
  lineEnd: Point,
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return distance(point, lineStart);

  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) /
    lengthSquared;
  const projection = {
    x: lineStart.x + t * dx,
    y: lineStart.y + t * dy,
  };
  return distance(point, projection);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointKey(point: Point): string {
  return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function resolveStyle(
  style: Option<StickerCutoutOutline.Style>,
): StickerCutoutOutline.ResolvedStyle {
  const cutoutWidthPx = style?.cutoutWidthPx ??
    style?.growPx ??
    StickerCutoutOutline.DEFAULT_STYLE.cutoutWidthPx;
  const smoothingPx = style?.smoothingPx ??
    style?.smoothPx ??
    StickerCutoutOutline.DEFAULT_STYLE.smoothingPx;
  const technique = resolveTechnique(
    style?.technique ?? StickerCutoutOutline.DEFAULT_STYLE.technique,
  );

  return {
    paddingPx: style?.paddingPx ?? StickerCutoutOutline.DEFAULT_STYLE.paddingPx,
    cutoutWidthPx,
    roundPx: style?.roundPx ?? StickerCutoutOutline.DEFAULT_STYLE.roundPx,
    smoothingPx,
    technique,
    fill: style?.fill ?? StickerCutoutOutline.DEFAULT_STYLE.fill,
    stroke: style?.stroke ?? StickerCutoutOutline.DEFAULT_STYLE.stroke,
    shadow: style?.shadow ?? StickerCutoutOutline.DEFAULT_STYLE.shadow,
    alphaThreshold: style?.alphaThreshold ??
      StickerCutoutOutline.DEFAULT_STYLE.alphaThreshold,
    edgeBleedPx: style?.edgeBleedPx ??
      StickerCutoutOutline.DEFAULT_STYLE.edgeBleedPx,
  };
}

function resolveTechnique(value: string): StickerCutoutOutline.Technique {
  if (
    value === "catmull-rom" ||
    value === "chaikin" ||
    value === "chaikin-cubic"
  ) {
    return value;
  }
  throw new Error(`Unsupported sticker cutout technique: ${value}`);
}

function buildSvg(input: SvgBuildInput): string {
  const { width, height, viewBox, pathData, style } = input;
  const stroke = style.stroke;
  const edgeBleedAttrs = style.edgeBleedPx > 0
    ? ` stroke="${escapeXml(style.fill)}" stroke-width="${
      formatNumber(style.edgeBleedPx)
    }" stroke-linejoin="round" stroke-linecap="round"`
    : "";
  const strokeAttrs = stroke
    ? ` stroke="${escapeXml(stroke.color)}" stroke-width="${
      formatNumber(stroke.widthPx)
    }" stroke-opacity="${
      formatNumber(stroke.opacity)
    }" stroke-linejoin="round" stroke-linecap="round"`
    : "";

  // Pure shape: the white silhouette only (plus an optional stroke).
  // Depth — a drop shadow (raised) or inner shadow (recessed) — is a
  // separate per-surface layer, not baked here. See
  // `StickerCutoutOutline.buildInnerShadowSvg` and the `depth` prop on
  // `StickerCutoutPreview`.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">`,
    `  <path d="${pathData}" fill="${
      escapeXml(style.fill)
    }" fill-rule="evenodd" shape-rendering="geometricPrecision"${edgeBleedAttrs} />`,
    ...(stroke
      ? [
        `  <path d="${pathData}" fill="none" fill-rule="evenodd" shape-rendering="geometricPrecision"${strokeAttrs} />`,
      ]
      : []),
    "</svg>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(3);
}

function formatPoint(point: Point): string {
  return `${formatNumber(point.x)} ${formatNumber(point.y)}`;
}
