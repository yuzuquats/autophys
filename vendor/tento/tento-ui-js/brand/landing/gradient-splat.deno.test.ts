import { assert, assertEquals } from "jsr:@std/assert";

import { GradientSplat } from "./gradient-splat.ts";

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const EDGE_GUTTER = 4;
// Mirrors `FIT_BLUR_PAD_FACTOR` in gradient-splat.ts: the fit reserves the bulk of the feather
// (not the full 2.8σ) so the splat covers more of the box; the faint outer tail may reach the edge.
const BLUR_PAD_FACTOR = 0.9;
const BLUR_PAD_EXTRA = 1;
const BASE_CANVAS_SIZE = 128;
const EPSILON = 0.6;

function decodeSvg(background: string): string {
  const prefix = 'url("data:image/svg+xml,';
  const suffix = '")';
  assert(background.startsWith(prefix), "background is an SVG data URL");
  assert(background.endsWith(suffix), "background data URL is quoted");
  return decodeURIComponent(
    background.slice(prefix.length, background.length - suffix.length),
  );
}

function numberMatch(svg: string, pattern: RegExp, label: string): number {
  const match = svg.match(pattern);
  assert(match, label);
  const value = Number(match[1]);
  assert(Number.isFinite(value), label);
  return value;
}

function pathBounds(d: string): Bounds {
  const numbers = Array.from(d.matchAll(/-?\d+(?:\.\d+)?/g)).map((match) =>
    Number(match[0])
  );
  assert(numbers.length > 0, "path has coordinates");
  assertEquals(numbers.length % 2, 0, "path has x/y coordinate pairs");

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < numbers.length; i += 2) {
    const x = numbers[i];
    const y = numbers[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
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

function expandBounds(bounds: Bounds, pad: number): Bounds {
  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  };
}

Deno.test("GradientSplat palettes keep blurred paths inside responsive SVG canvases", () => {
  const renderSizes: GradientSplat.RenderSize[] = [
    { width: 128, height: 128 },
    { width: 420, height: 260 },
    { width: 720, height: 420 },
  ];

  for (const palette of GradientSplat.PALETTES) {
    for (const renderSize of renderSizes) {
      const sizeLabel = `${renderSize.width}x${renderSize.height}`;
      const svg = decodeSvg(palette.backgroundForSize(renderSize, 0));
      assert(
        svg.includes("filterUnits='userSpaceOnUse'"),
        `${palette.label} ${sizeLabel}: filter uses SVG canvas coordinates`,
      );
      assert(
        svg.includes(`viewBox='0 0 ${renderSize.width} ${renderSize.height}'`),
        `${palette.label} ${sizeLabel}: viewBox uses the expected canvas`,
      );

      const width = numberMatch(svg, /<svg[^>]* width='([0-9.]+)'/, "svg width");
      const height = numberMatch(
        svg,
        /<svg[^>]* height='([0-9.]+)'/,
        "svg height",
      );
      assertEquals(width, renderSize.width, `${palette.label} ${sizeLabel}: width`);
      assertEquals(
        height,
        renderSize.height,
        `${palette.label} ${sizeLabel}: height`,
      );

      const paths = Array.from(
        svg.matchAll(/<path d='([^']+)' fill='[^']+'\/>/g),
      );
      assert(paths.length > 0, `${palette.label} ${sizeLabel}: emits paths`);

      // The splat now COVERS its box (the fit fills the longer dimension and overflows the
      // shorter), so its larger span reaches most of the box's longer side — guard against an
      // under-filling / hard-clipped regression.
      const cluster = mergeBounds(paths.map((path) => pathBounds(path[1])));
      const longerBox = Math.max(renderSize.width, renderSize.height);
      const longerSpan = Math.max(
        cluster.maxX - cluster.minX,
        cluster.maxY - cluster.minY,
      );
      assert(
        longerSpan >= 0.7 * longerBox,
        `${palette.label} ${sizeLabel}: splat covers the box (span ${
          longerSpan.toFixed(0)
        } >= 70% of ${longerBox})`,
      );
    }
  }
});
