import { assert, assertEquals } from "jsr:@std/assert";

import { FractalNoise } from "./fractal-noise.ts";

function config(size: FractalNoise.RenderSize): FractalNoise.CommonConfig {
  return {
    seed: 9001,
    size,
    minRadiusPx: 6,
    maxRadiusPx: 86,
    birthBandPx: 16,
    growthExponent: 1.1,
    maxDepth: 6,
    maxShapeCount: 280,
    shapePoints: 28,
    jitter: 0.2,
  };
}

function options(): FractalNoise.PresetOptions {
  return {
    ...FractalNoise.Presets.DEFAULT_OPTIONS,
    splitArity: 3,
    areaRetention: 1.22,
  };
}

function signature(output: FractalNoise.Output): string {
  return output.nodes
    .map((node) =>
      `${node.id}:${node.lifecycle}:${node.radius}:${node.opacity}:${node.d}`
    )
    .join("|");
}

function fieldBounds(output: FractalNoise.Output): FractalNoise.Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of output.nodes) {
    minX = Math.min(minX, node.bounds.minX);
    minY = Math.min(minY, node.bounds.minY);
    maxX = Math.max(maxX, node.bounds.maxX);
    maxY = Math.max(maxY, node.bounds.maxY);
  }
  return { minX, minY, maxX, maxY };
}

function centerBounds(output: FractalNoise.Output): FractalNoise.Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of output.nodes) {
    minX = Math.min(minX, node.center.x);
    minY = Math.min(minY, node.center.y);
    maxX = Math.max(maxX, node.center.x);
    maxY = Math.max(maxY, node.center.y);
  }
  return { minX, minY, maxX, maxY };
}

Deno.test("FractalNoise is deterministic for the same seed, size, and strategies", () => {
  const common = config({ width: 420, height: 280 });
  const strategies = FractalNoise.Presets.smoothFieldFill(options());

  const first = FractalNoise.generate(common, strategies);
  const second = FractalNoise.generate(common, strategies);

  assertEquals(signature(first), signature(second));
});

Deno.test("FractalNoise changes geometry when the seed changes", () => {
  const strategies = FractalNoise.Presets.smoothFieldFill(options());
  const first = FractalNoise.generate(config({ width: 420, height: 280 }), strategies);
  const second = FractalNoise.generate(
    { ...config({ width: 420, height: 280 }), seed: 9002 },
    strategies,
  );

  assert(signature(first) !== signature(second));
});

Deno.test("FractalNoise starts from a couple of initial blobs", () => {
  const output = FractalNoise.generate(
    config({ width: 170, height: 140 }),
    FractalNoise.Presets.smoothFieldFill(options()),
  );

  assertEquals(output.nodes.length, 2);
  assert(output.nodes.every((node) => node.depth === 0));
});

Deno.test("FractalNoise never renders a radius beyond maxRadiusPx", () => {
  const common = config({ width: 900, height: 620 });
  const output = FractalNoise.generate(
    common,
    FractalNoise.Presets.largeIslandField(options()),
  );

  for (const node of output.nodes) {
    assert(
      node.radius <= common.maxRadiusPx + 0.001,
      `${node.id} radius ${node.radius} exceeds max ${common.maxRadiusPx}`,
    );
    assert(node.bounds.minX >= -0.001, `${node.id} left edge clips`);
    assert(node.bounds.minY >= -0.001, `${node.id} top edge clips`);
    assert(node.bounds.maxX <= common.size.width + 0.001, `${node.id} right edge clips`);
    assert(node.bounds.maxY <= common.size.height + 0.001, `${node.id} bottom edge clips`);
  }
});

Deno.test("FractalNoise births more shapes as screen-space size grows", () => {
  const strategies = FractalNoise.Presets.smoothFieldFill(options());
  const small = FractalNoise.generate(config({ width: 180, height: 140 }), strategies);
  const large = FractalNoise.generate(config({ width: 760, height: 520 }), strategies);

  assert(
    large.nodes.length > small.nodes.length,
    `expected large field (${large.nodes.length}) to have more shapes than small (${small.nodes.length})`,
  );
});

Deno.test("FractalNoise area split tracks configured area ratio", () => {
  const common = config({ width: 720, height: 520 });
  const opts = options();
  const split = FractalNoise.areaThresholdSplit(opts);
  const root: FractalNoise.NodeRef = {
    id: "root",
    path: [],
    depth: 0,
    center: { x: common.size.width / 2, y: common.size.height / 2 },
    radiusScale: 1,
  };
  const state = split.stateForNode({
    common,
    node: root,
    rawRadius: common.maxRadiusPx + common.birthBandPx + 1,
  });

  assert(state.kind === "decomposed");
  const parentArea = common.maxRadiusPx * common.maxRadiusPx;
  const childArea = state.childCount *
    Math.pow(common.maxRadiusPx * state.childRadiusScale, 2);
  const ratio = childArea / parentArea;

  assert(
    Math.abs(ratio - opts.areaRetention) < 0.001,
    `expected area ratio ${ratio} to match ${opts.areaRetention}`,
  );
});

Deno.test("FractalNoise smooth presets split into small child groups", () => {
  const common = config({ width: 760, height: 520 });
  const root: FractalNoise.NodeRef = {
    id: "root.0",
    path: [0],
    depth: 0,
    center: { x: common.size.width / 2, y: common.size.height / 2 },
    radiusScale: 1,
  };
  const presets = [
    FractalNoise.Presets.smoothFieldFill(options()),
    FractalNoise.Presets.parentFootprintFill(options()),
    FractalNoise.Presets.largeIslandField(options()),
    FractalNoise.Presets.variedFieldFill(options()),
  ];

  for (const preset of presets) {
    const state = preset.split.stateForNode({
      common,
      node: root,
      rawRadius: common.maxRadiusPx + common.birthBandPx + 1,
    });
    assert(state.kind === "decomposed");
    assert(state.childCount <= 4, `${preset.split.name} split into ${state.childCount}`);
  }
});

Deno.test("FractalNoise strategy pieces compose across presets", () => {
  const common = config({ width: 640, height: 360 });
  const radial = FractalNoise.Presets.smoothFieldFill(options());
  const mixed: FractalNoise.StrategyBundle = {
    growth: radial.growth,
    split: radial.split,
    layout: FractalNoise.poissonLayout(),
    outline: FractalNoise.contourOutline(),
  };
  const output = FractalNoise.generate(common, mixed);

  assert(output.nodes.length > 0);
  assert(output.maxDepth <= common.maxDepth);
});

Deno.test("FractalNoise respects maxShapeCount", () => {
  const common = {
    ...config({ width: 1400, height: 900 }),
    maxShapeCount: 18,
  };
  const output = FractalNoise.generate(
    common,
    FractalNoise.Presets.variedFieldFill(options()),
  );

  assert(output.nodes.length <= common.maxShapeCount);
  assert(output.capped);
});

Deno.test("FractalNoise renders smooth cubic paths", () => {
  const output = FractalNoise.generate(
    config({ width: 560, height: 360 }),
    FractalNoise.Presets.smoothFieldFill(options()),
  );

  assert(output.nodes.length > 0);
  assert(output.nodes.every((node) => node.d.includes("C")));
});

Deno.test("FractalNoise smooth field covers most of the available space", () => {
  const common = config({ width: 760, height: 520 });
  const output = FractalNoise.generate(
    common,
    FractalNoise.Presets.smoothFieldFill(options()),
  );
  const bounds = fieldBounds(output);
  const widthCoverage = (bounds.maxX - bounds.minX) / common.size.width;
  const heightCoverage = (bounds.maxY - bounds.minY) / common.size.height;

  assert(widthCoverage > 0.58, `expected width coverage > 0.58, got ${widthCoverage}`);
  assert(heightCoverage > 0.52, `expected height coverage > 0.52, got ${heightCoverage}`);
});

Deno.test("FractalNoise smooth field disperses centers with seeded noise", () => {
  const common = config({ width: 760, height: 520 });
  const output = FractalNoise.generate(
    common,
    FractalNoise.Presets.variedFieldFill(options()),
  );
  const centers = centerBounds(output);
  const widthDispersion = (centers.maxX - centers.minX) / common.size.width;
  const heightDispersion = (centers.maxY - centers.minY) / common.size.height;

  assert(widthDispersion > 0.34, `expected width dispersion > 0.34, got ${widthDispersion}`);
  assert(heightDispersion > 0.28, `expected height dispersion > 0.28, got ${heightDispersion}`);
});

Deno.test("FractalNoise smooth variants produce distinct geometry", () => {
  const common = config({ width: 560, height: 360 });
  const variants = [
    FractalNoise.Presets.smoothFieldFill(options()),
    FractalNoise.Presets.parentFootprintFill(options()),
    FractalNoise.Presets.largeIslandField(options()),
    FractalNoise.Presets.variedFieldFill(options()),
  ];
  const signatures = new Set(
    variants.map((variant) => signature(FractalNoise.generate(common, variant))),
  );

  assertEquals(signatures.size, variants.length);
});
