/**
 * FractalNoise — a procedural blob-FIELD generator (the engine behind the `std-fractal-noise-field`
 * storybook). Hierarchical cluster growth: a seeded tree of nodes where each node may SPLIT into
 * children, GROW its radius, LAY OUT those children, and OUTLINE itself — each step a swappable
 * `StrategyBundle` member (`growth` / `split` / `childLayout` / `outline`). `generate(config,
 * strategies)` runs the tree to an `Output` of `RenderNode`s (smooth SVG outlines + lifecycle
 * state); `powerGrowth` / `areaThresholdSplit` / the field-layout presets are ready-made strategies.
 *
 * STATUS: experimental generative-art, exercised ONLY by the Noise storybook (no production
 * consumer) — kept as a reusable building block / reference for procedural wash geometry. It is an
 * ALTERNATIVE blob source to `brand/landing/geometry/cluster-growth-source.ts`; neither is wired
 * into the production `brand/landing/gradient-splat.ts` wash.
 */
export namespace FractalNoise {
  export type RenderSize = {
    width: number;
    height: number;
  };

  export type Point = {
    x: number;
    y: number;
  };

  export type Bounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };

  export type CommonConfig = {
    seed: number;
    size: RenderSize;
    minRadiusPx: number;
    maxRadiusPx: number;
    birthBandPx: number;
    growthExponent: number;
    maxDepth: number;
    maxShapeCount: number;
    shapePoints: number;
    jitter: number;
  };

  export type NodeRef = {
    id: string;
    path: readonly number[];
    depth: number;
    center: Point;
    radiusScale: number;
  };

  export type GrowthInput = {
    common: CommonConfig;
    node: NodeRef;
    screenScale: number;
  };

  export interface GrowthStrategy {
    readonly name: string;
    radiusForNode(input: GrowthInput): number;
  }

  export type SplitInput = {
    common: CommonConfig;
    node: NodeRef;
    rawRadius: number;
  };

  export type SplitState =
    | {
      kind: "stable";
    }
    | {
      kind: "birthing";
      progress: number;
      childCount: number;
      parentOpacity: number;
      childRadiusScale: number;
    }
    | {
      kind: "decomposed";
      childCount: number;
      childRadiusScale: number;
    };

  export interface SplitStrategy {
    readonly name: string;
    stateForNode(input: SplitInput): SplitState;
  }

  export type ChildLayoutInput = {
    common: CommonConfig;
    parent: NodeRef;
    childCount: number;
    childRadiusScale: number;
    parentRadius: number;
  };

  export type ChildPlacement = {
    pathIndex: number;
    center: Point;
    radiusScale: number;
  };

  export interface ChildLayoutStrategy {
    readonly name: string;
    children(input: ChildLayoutInput): ChildPlacement[];
  }

  export type OutlineInput = {
    common: CommonConfig;
    node: NodeRef;
    radius: number;
  };

  export interface OutlineStrategy {
    readonly name: string;
    points(input: OutlineInput): Point[];
  }

  export type StrategyBundle = {
    growth: GrowthStrategy;
    split: SplitStrategy;
    layout: ChildLayoutStrategy;
    outline: OutlineStrategy;
  };

  export type RenderNode = {
    id: string;
    path: readonly number[];
    depth: number;
    center: Point;
    radius: number;
    rawRadius: number;
    opacity: number;
    lifecycle: "stable" | "birthing-parent" | "birthing-child";
    points: Point[];
    bounds: Bounds;
    d: string;
  };

  export type Output = {
    size: RenderSize;
    nodes: RenderNode[];
    maxDepth: number;
    capped: boolean;
  };

  export type AreaSplitOptions = {
    splitArity: number;
    areaRetention: number;
  };

  export type PowerGrowthOptions = {
    referenceScalePx: number;
    baseRadiusPx: number;
  };

  export type PresetOptions = AreaSplitOptions & PowerGrowthOptions;

  export type SmoothOutlineOptions = {
    name: string;
    minAspect: number;
    maxAspect: number;
    waveAmplitude: number;
    secondaryWaveAmplitude: number;
    randomAmplitude: number;
  };

  export type FieldLayoutOptions = {
    name: string;
    minDistanceRatio: number;
    maxDistanceRatio: number;
    angleJitter: number;
    scaleMin: number;
    scaleMax: number;
  };

  const HASH_INIT = 0x811c9dc5;
  const HASH_PRIME = 0x01000193;

  function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }

  function round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  function hashStep(hash: number, value: number): number {
    return Math.imul(hash ^ (value & 0xff), HASH_PRIME) >>> 0;
  }

  function hashFor(seed: number, path: readonly number[], salt: number): number {
    let hash = HASH_INIT;
    hash = hashStep(hash, seed);
    hash = hashStep(hash, salt);
    for (const segment of path) {
      hash = hashStep(hash, segment + 37);
    }
    return hash >>> 0;
  }

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

  function rngFor(
    common: CommonConfig,
    path: readonly number[],
    salt: number,
  ): () => number {
    return mulberry32(hashFor(common.seed, path, salt));
  }

  function noiseFor(
    common: CommonConfig,
    path: readonly number[],
    salt: number,
    index: number,
  ): number {
    return mulberry32(hashFor(common.seed, [...path, index], salt))();
  }

  function noiseRange(
    common: CommonConfig,
    path: readonly number[],
    salt: number,
    index: number,
    min: number,
    max: number,
  ): number {
    return min + noiseFor(common, path, salt, index) * (max - min);
  }

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

  function cubicPathD(points: readonly Point[]): string {
    if (points.length < 3) {
      return `M${points.map((p) => `${round1(p.x)} ${round1(p.y)}`).join("L")}Z`;
    }

    const commands: string[] = [`M${round1(points[0].x)} ${round1(points[0].y)}`];
    const tension = 1 / 6;
    for (let i = 0; i < points.length; i++) {
      const p0 = points[(i - 1 + points.length) % points.length];
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      const p3 = points[(i + 2) % points.length];
      const c1 = {
        x: p1.x + (p2.x - p0.x) * tension,
        y: p1.y + (p2.y - p0.y) * tension,
      };
      const c2 = {
        x: p2.x - (p3.x - p1.x) * tension,
        y: p2.y - (p3.y - p1.y) * tension,
      };
      commands.push(
        `C${round1(c1.x)} ${round1(c1.y)} ${round1(c2.x)} ${round1(c2.y)} ` +
          `${round1(p2.x)} ${round1(p2.y)}`,
      );
    }
    return `${commands.join("")}Z`;
  }

  function nodeId(path: readonly number[]): string {
    return path.length === 0 ? "root" : `root.${path.join(".")}`;
  }

  function childPath(parent: NodeRef, childIndex: number): number[] {
    return [...parent.path, childIndex];
  }

  function rootNodes(common: CommonConfig): NodeRef[] {
    const shortest = Math.min(common.size.width, common.size.height);
    const count = shortest < 220 ? 2 : 3;
    const rotation = noiseRange(common, [], 307, 0, 0, Math.PI * 2);
    const radius = shortest * 0.24;
    const roots: NodeRef[] = [];
    for (let i = 0; i < count; i++) {
      const path = [i];
      const angle = rotation + (Math.PI * 2 * i) / count +
        noiseRange(common, [], 311, i, -0.42, 0.42);
      const distance = radius * noiseRange(common, [], 313, i, 0.42, 1.0);
      const center = clampCenter(common, {
        x: common.size.width / 2 + Math.cos(angle) * distance,
        y: common.size.height / 2 + Math.sin(angle) * distance,
      }, common.maxRadiusPx);
      roots.push({
        id: nodeId(path),
        path,
        depth: 0,
        center,
        radiusScale: noiseRange(common, [], 317, i, 0.92, 1.16),
      });
    }
    return roots;
  }

  function clampCenter(
    common: CommonConfig,
    center: Point,
    radius: number,
  ): Point {
    const margin = Math.max(4, radius * 1.08);
    return {
      x: clampCoordinate(center.x, margin, common.size.width - margin, common.size.width / 2),
      y: clampCoordinate(center.y, margin, common.size.height - margin, common.size.height / 2),
    };
  }

  function clampCoordinate(
    value: number,
    min: number,
    max: number,
    fallback: number,
  ): number {
    if (min > max) return fallback;
    return clamp(value, min, max);
  }

  function centerForBounds(bounds: Bounds): Point {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
  }

  function fitPointsInside(common: CommonConfig, points: readonly Point[]): Point[] {
    const padding = 1;
    const bounds = boundsFor(points);
    const width = Math.max(0.01, bounds.maxX - bounds.minX);
    const height = Math.max(0.01, bounds.maxY - bounds.minY);
    const maxWidth = Math.max(1, common.size.width - padding * 2);
    const maxHeight = Math.max(1, common.size.height - padding * 2);
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const sourceCenter = centerForBounds(bounds);
    const scaled = points.map((point) => ({
      x: sourceCenter.x + (point.x - sourceCenter.x) * scale,
      y: sourceCenter.y + (point.y - sourceCenter.y) * scale,
    }));
    const scaledBounds = boundsFor(scaled);
    const dx = translateDelta(scaledBounds.minX, scaledBounds.maxX, padding, common.size.width - padding);
    const dy = translateDelta(scaledBounds.minY, scaledBounds.maxY, padding, common.size.height - padding);
    return scaled.map((point) => ({
      x: point.x + dx,
      y: point.y + dy,
    }));
  }

  function translateDelta(
    min: number,
    max: number,
    allowedMin: number,
    allowedMax: number,
  ): number {
    if (min < allowedMin) return allowedMin - min;
    if (max > allowedMax) return allowedMax - max;
    return 0;
  }

  function screenScale(size: RenderSize): number {
    return Math.sqrt(Math.max(1, size.width * size.height));
  }

  function renderNode(
    common: CommonConfig,
    strategies: StrategyBundle,
    node: NodeRef,
    rawRadius: number,
    radius: number,
    opacity: number,
    lifecycle: RenderNode["lifecycle"],
  ): RenderNode {
    const visibleRadius = Math.max(0.01, radius);
    const points = fitPointsInside(common, strategies.outline.points({
      common,
      node,
      radius: visibleRadius,
    }));
    const bounds = boundsFor(points);
    return {
      id: node.id,
      path: node.path,
      depth: node.depth,
      center: centerForBounds(bounds),
      radius: round3(visibleRadius),
      rawRadius: round3(rawRadius),
      opacity: round3(clamp(opacity, 0, 1)),
      lifecycle,
      points,
      bounds,
      d: cubicPathD(points),
    };
  }

  function childNodes(
    common: CommonConfig,
    layout: ChildLayoutStrategy,
    parent: NodeRef,
    childCount: number,
    childRadiusScale: number,
    parentRadius: number,
  ): NodeRef[] {
    const placements = layout.children({
      common,
      parent,
      childCount,
      childRadiusScale,
      parentRadius,
    });
    return placements.map((placement) => {
      const path = childPath(parent, placement.pathIndex);
      return {
        id: nodeId(path),
        path,
        depth: parent.depth + 1,
        center: placement.center,
        radiusScale: placement.radiusScale,
      };
    });
  }

  export function generate(
    common: CommonConfig,
    strategies: StrategyBundle,
  ): Output {
    const size = normalizeSize(common.size);
    const normalizedCommon = { ...common, size };
    const nodes: RenderNode[] = [];
    const queue: NodeRef[] = rootNodes(normalizedCommon);
    const scale = screenScale(size);
    let maxDepth = 0;
    let capped = false;

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) break;
      const rawRadius = strategies.growth.radiusForNode({
        common: normalizedCommon,
        node,
        screenScale: scale,
      });
      const split = strategies.split.stateForNode({
        common: normalizedCommon,
        node,
        rawRadius,
      });
      maxDepth = Math.max(maxDepth, node.depth);

      if (nodes.length >= normalizedCommon.maxShapeCount) {
        capped = true;
        break;
      }

      if (split.kind === "stable" || node.depth >= normalizedCommon.maxDepth) {
        nodes.push(
          renderNode(
            normalizedCommon,
            strategies,
            node,
            rawRadius,
            clamp(rawRadius, normalizedCommon.minRadiusPx, normalizedCommon.maxRadiusPx),
            1,
            "stable",
          ),
        );
        continue;
      }

      const children = childNodes(
        normalizedCommon,
        strategies.layout,
        node,
        split.childCount,
        split.childRadiusScale,
        layoutRadiusFor(normalizedCommon, rawRadius),
      );

      if (split.kind === "birthing") {
        nodes.push(
          renderNode(
            normalizedCommon,
            strategies,
            node,
            rawRadius,
            normalizedCommon.maxRadiusPx,
            split.parentOpacity,
            "birthing-parent",
          ),
        );
        for (const child of children) {
          if (nodes.length >= normalizedCommon.maxShapeCount) {
            capped = true;
            break;
          }
          const childRawRadius = strategies.growth.radiusForNode({
            common: normalizedCommon,
            node: child,
            screenScale: scale,
          });
          nodes.push(
            renderNode(
              normalizedCommon,
              strategies,
              child,
              childRawRadius,
              clamp(childRawRadius, 0, normalizedCommon.maxRadiusPx) *
                easeOutCubic(split.progress),
              split.progress,
              "birthing-child",
            ),
          );
        }
        continue;
      }

      for (const child of children) {
        if (queue.length + nodes.length >= normalizedCommon.maxShapeCount) {
          capped = true;
          break;
        }
        queue.push(child);
      }
    }

    return { size, nodes, maxDepth, capped };
  }

  export function normalizeSize(size: RenderSize): RenderSize {
    return {
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    };
  }

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  }

  function layoutRadiusFor(common: CommonConfig, rawRadius: number): number {
    const viewportCap = Math.max(
      common.maxRadiusPx,
      Math.min(common.size.width, common.size.height) * 0.56,
    );
    return clamp(rawRadius, common.maxRadiusPx, viewportCap);
  }

  export function powerGrowth(options: PowerGrowthOptions): GrowthStrategy {
    return {
      name: "power",
      radiusForNode(input: GrowthInput): number {
        const normalized = Math.max(
          0,
          input.screenScale / Math.max(1, options.referenceScalePx),
        );
        return (
          options.baseRadiusPx *
          Math.pow(normalized, input.common.growthExponent) *
          input.node.radiusScale
        );
      },
    };
  }

  export function areaThresholdSplit(options: AreaSplitOptions): SplitStrategy {
    return {
      name: "area-threshold",
      stateForNode(input: SplitInput): SplitState {
        if (input.node.depth >= input.common.maxDepth) return { kind: "stable" };

        const childCount = Math.max(2, Math.round(options.splitArity));
        const childRadiusScale =
          Math.sqrt(options.areaRetention / childCount) *
          input.node.radiusScale;
        const start = input.common.maxRadiusPx - input.common.birthBandPx;
        const end = input.common.maxRadiusPx + input.common.birthBandPx;

        if (input.rawRadius < start) return { kind: "stable" };
        if (input.rawRadius <= end) {
          const progress = clamp(
            (input.rawRadius - start) / Math.max(1, end - start),
            0,
            1,
          );
          return {
            kind: "birthing",
            progress,
            childCount,
            childRadiusScale,
            parentOpacity: 1 - progress * 0.72,
          };
        }
        return {
          kind: "decomposed",
          childCount,
          childRadiusScale,
        };
      },
    };
  }

  export function radialLayout(): ChildLayoutStrategy {
    return {
      name: "radial",
      children(input: ChildLayoutInput): ChildPlacement[] {
        const rng = rngFor(input.common, input.parent.path, 19);
        const rotation = rng() * Math.PI * 2;
        const distance = input.parentRadius * 0.62;
        const placements: ChildPlacement[] = [];
        for (let i = 0; i < input.childCount; i++) {
          const angle = rotation + (Math.PI * 2 * i) / input.childCount;
          const jitter = (rng() * 2 - 1) * input.parentRadius * 0.12;
          const center = clampCenter(input.common, {
            x: input.parent.center.x + Math.cos(angle) * (distance + jitter),
            y: input.parent.center.y + Math.sin(angle) * (distance + jitter),
          }, input.parentRadius * input.childRadiusScale);
          placements.push({
            pathIndex: i,
            center,
            radiusScale: input.childRadiusScale,
          });
        }
        return placements;
      },
    };
  }

  export function axisLayout(): ChildLayoutStrategy {
    return {
      name: "axis",
      children(input: ChildLayoutInput): ChildPlacement[] {
        const rng = rngFor(input.common, input.parent.path, 23);
        const horizontal = input.parent.depth % 2 === 0;
        const gap = input.parentRadius * 1.05 / Math.max(1, input.childCount - 1);
        const start = -gap * (input.childCount - 1) / 2;
        const placements: ChildPlacement[] = [];
        for (let i = 0; i < input.childCount; i++) {
          const offset = start + gap * i;
          const wobble = (rng() * 2 - 1) * input.parentRadius * 0.18;
          const center = clampCenter(input.common, {
            x: input.parent.center.x + (horizontal ? offset : wobble),
            y: input.parent.center.y + (horizontal ? wobble : offset),
          }, input.parentRadius * input.childRadiusScale);
          placements.push({
            pathIndex: i,
            center,
            radiusScale: input.childRadiusScale,
          });
        }
        return placements;
      },
    };
  }

  export function spiralLayout(): ChildLayoutStrategy {
    return {
      name: "spiral",
      children(input: ChildLayoutInput): ChildPlacement[] {
        const rng = rngFor(input.common, input.parent.path, 31);
        const golden = Math.PI * (3 - Math.sqrt(5));
        const rotation = rng() * Math.PI * 2;
        const placements: ChildPlacement[] = [];
        for (let i = 0; i < input.childCount; i++) {
          const t = (i + 1) / input.childCount;
          const angle = rotation + i * golden;
          const distance = input.parentRadius * (0.18 + t * 0.72);
          const center = clampCenter(input.common, {
            x: input.parent.center.x + Math.cos(angle) * distance,
            y: input.parent.center.y + Math.sin(angle) * distance,
          }, input.parentRadius * input.childRadiusScale);
          placements.push({
            pathIndex: i,
            center,
            radiusScale: input.childRadiusScale,
          });
        }
        return placements;
      },
    };
  }

  export function poissonLayout(): ChildLayoutStrategy {
    return {
      name: "poisson-layered",
      children(input: ChildLayoutInput): ChildPlacement[] {
        const rng = rngFor(input.common, input.parent.path, 43);
        const placements: ChildPlacement[] = [];
        for (let i = 0; i < input.childCount; i++) {
          const angle = rng() * Math.PI * 2;
          const distance = input.parentRadius * (0.28 + rng() * 0.72);
          const center = clampCenter(input.common, {
            x: input.parent.center.x + Math.cos(angle) * distance,
            y: input.parent.center.y + Math.sin(angle) * distance,
          }, input.parentRadius * input.childRadiusScale);
          placements.push({
            pathIndex: i,
            center,
            radiusScale: input.childRadiusScale * (0.82 + rng() * 0.28),
          });
        }
        return placements;
      },
    };
  }

  export function fieldFillLayout(options: FieldLayoutOptions): ChildLayoutStrategy {
    return {
      name: options.name,
      children(input: ChildLayoutInput): ChildPlacement[] {
        const rng = rngFor(input.common, input.parent.path, 59);
        const golden = Math.PI * (3 - Math.sqrt(5));
        const rotation = rng() * Math.PI * 2;
        const placements: ChildPlacement[] = [];
        for (let i = 0; i < input.childCount; i++) {
          const indexNoise = noiseFor(input.common, input.parent.path, 211, i);
          const ringT = input.childCount <= 1
            ? indexNoise
            : clamp((i + indexNoise * 0.85) / input.childCount, 0, 1);
          const distanceNoise = noiseFor(input.common, input.parent.path, 223, i);
          const distanceRatio = options.minDistanceRatio +
            (options.maxDistanceRatio - options.minDistanceRatio) *
              Math.sqrt(clamp(ringT * 0.64 + distanceNoise * 0.36, 0, 1));
          const angle = rotation + i * golden +
            noiseRange(
              input.common,
              input.parent.path,
              227,
              i,
              -options.angleJitter,
              options.angleJitter,
            );
          const distance = input.parentRadius * distanceRatio;
          const radiusScale = input.childRadiusScale *
            noiseRange(
              input.common,
              input.parent.path,
              229,
              i,
              options.scaleMin,
              options.scaleMax,
            );
          const center = clampCenter(input.common, {
            x: input.parent.center.x + Math.cos(angle) * distance,
            y: input.parent.center.y + Math.sin(angle) * distance,
          }, input.common.maxRadiusPx * radiusScale);
          placements.push({
            pathIndex: i,
            center,
            radiusScale,
          });
        }
        return placements;
      },
    };
  }

  export function jitteredOutline(): OutlineStrategy {
    return smoothBlobOutline({
      name: "smooth-jittered",
      minAspect: 0.76,
      maxAspect: 1.28,
      waveAmplitude: 0.24,
      secondaryWaveAmplitude: 0.10,
      randomAmplitude: 0.04,
    });
  }

  export function contourOutline(): OutlineStrategy {
    return smoothBlobOutline({
      name: "smooth-contour",
      minAspect: 0.70,
      maxAspect: 1.36,
      waveAmplitude: 0.34,
      secondaryWaveAmplitude: 0.18,
      randomAmplitude: 0.06,
    });
  }

  export function smoothBlobOutline(options: SmoothOutlineOptions): OutlineStrategy {
    return {
      name: options.name,
      points(input: OutlineInput): Point[] {
        const count = Math.max(14, Math.round(input.common.shapePoints));
        const rng = rngFor(input.common, input.node.path, 137);
        const rotation = rng() * Math.PI * 2;
        const tilt = rng() * Math.PI * 2;
        const aspect = options.minAspect + rng() * (options.maxAspect - options.minAspect);
        const frequency = 2 + Math.floor(rng() * 3);
        const phase = rng() * Math.PI * 2;
        const secondaryPhase = rng() * Math.PI * 2;
        const points: Point[] = [];
        for (let i = 0; i < count; i++) {
          const angle = rotation + (Math.PI * 2 * i) / count;
          const wave = Math.sin(angle * frequency + phase) *
            input.common.jitter *
            options.waveAmplitude;
          const secondary = Math.sin(angle * (frequency + 1) + secondaryPhase) *
            input.common.jitter *
            options.secondaryWaveAmplitude;
          const random = (rng() * 2 - 1) *
            input.common.jitter *
            options.randomAmplitude;
          const radius = input.radius * Math.max(0.42, 1 + wave + secondary + random);
          const localX = Math.cos(angle) * radius;
          const localY = Math.sin(angle) * radius * aspect;
          points.push({
            x: input.node.center.x + localX * Math.cos(tilt) -
              localY * Math.sin(tilt),
            y: input.node.center.y + localX * Math.sin(tilt) +
              localY * Math.cos(tilt),
          });
        }
        return points;
      },
    };
  }

  export namespace Presets {
    export const DEFAULT_OPTIONS: PresetOptions = {
      splitArity: 3,
      areaRetention: 1.22,
      referenceScalePx: 208,
      baseRadiusPx: 50,
    };

    export function smoothFieldFill(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth(options),
        split: areaThresholdSplit({
          splitArity: Math.max(3, options.splitArity),
          areaRetention: Math.max(1.24, options.areaRetention * 1.04),
        }),
        layout: fieldFillLayout({
          name: "smooth-field-fill",
          minDistanceRatio: 0.10,
          maxDistanceRatio: 1.24,
          angleJitter: 0.96,
          scaleMin: 0.90,
          scaleMax: 1.36,
        }),
        outline: smoothBlobOutline({
          name: "smooth-field",
          minAspect: 0.78,
          maxAspect: 1.30,
          waveAmplitude: 0.20,
          secondaryWaveAmplitude: 0.10,
          randomAmplitude: 0.03,
        }),
      };
    }

    export function parentFootprintFill(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth({
          ...options,
          baseRadiusPx: options.baseRadiusPx * 1.08,
        }),
        split: areaThresholdSplit({
          splitArity: Math.max(3, options.splitArity),
          areaRetention: Math.max(1.0, options.areaRetention * 0.96),
        }),
        layout: fieldFillLayout({
          name: "parent-footprint-fill",
          minDistanceRatio: 0.02,
          maxDistanceRatio: 0.76,
          angleJitter: 0.38,
          scaleMin: 0.98,
          scaleMax: 1.18,
        }),
        outline: smoothBlobOutline({
          name: "parent-footprint-smooth",
          minAspect: 0.84,
          maxAspect: 1.18,
          waveAmplitude: 0.16,
          secondaryWaveAmplitude: 0.07,
          randomAmplitude: 0.02,
        }),
      };
    }

    export function largeIslandField(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth({
          ...options,
          baseRadiusPx: options.baseRadiusPx * 1.22,
        }),
        split: areaThresholdSplit({
          splitArity: Math.max(2, Math.round(options.splitArity * 0.72)),
          areaRetention: Math.max(1.08, options.areaRetention * 1.04),
        }),
        layout: fieldFillLayout({
          name: "large-island-field",
          minDistanceRatio: 0.12,
          maxDistanceRatio: 0.96,
          angleJitter: 0.54,
          scaleMin: 1.02,
          scaleMax: 1.42,
        }),
        outline: smoothBlobOutline({
          name: "large-island-smooth",
          minAspect: 0.74,
          maxAspect: 1.42,
          waveAmplitude: 0.18,
          secondaryWaveAmplitude: 0.08,
          randomAmplitude: 0.02,
        }),
      };
    }

    export function variedFieldFill(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth({
          ...options,
          baseRadiusPx: options.baseRadiusPx * 1.02,
        }),
        split: areaThresholdSplit({
          splitArity: Math.max(4, options.splitArity + 1),
          areaRetention: Math.max(1.08, options.areaRetention * 1.02),
        }),
        layout: fieldFillLayout({
          name: "varied-field-fill",
          minDistanceRatio: 0.05,
          maxDistanceRatio: 1.26,
          angleJitter: 1.26,
          scaleMin: 0.72,
          scaleMax: 1.64,
        }),
        outline: smoothBlobOutline({
          name: "varied-smooth",
          minAspect: 0.64,
          maxAspect: 1.52,
          waveAmplitude: 0.28,
          secondaryWaveAmplitude: 0.18,
          randomAmplitude: 0.05,
        }),
      };
    }

    export function areaSplitRadial(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth(options),
        split: areaThresholdSplit(options),
        layout: radialLayout(),
        outline: smoothBlobOutline({
          name: "radial-smooth",
          minAspect: 0.80,
          maxAspect: 1.24,
          waveAmplitude: 0.18,
          secondaryWaveAmplitude: 0.08,
          randomAmplitude: 0.02,
        }),
      };
    }

    export function areaSplitAxis(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth(options),
        split: areaThresholdSplit(options),
        layout: axisLayout(),
        outline: smoothBlobOutline({
          name: "axis-smooth",
          minAspect: 0.82,
          maxAspect: 1.20,
          waveAmplitude: 0.14,
          secondaryWaveAmplitude: 0.06,
          randomAmplitude: 0.02,
        }),
      };
    }

    export function areaSplitSpiral(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth(options),
        split: areaThresholdSplit(options),
        layout: spiralLayout(),
        outline: smoothBlobOutline({
          name: "spiral-smooth",
          minAspect: 0.78,
          maxAspect: 1.32,
          waveAmplitude: 0.20,
          secondaryWaveAmplitude: 0.10,
          randomAmplitude: 0.03,
        }),
      };
    }

    export function poissonLayered(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth({
          ...options,
          baseRadiusPx: options.baseRadiusPx * 0.92,
        }),
        split: areaThresholdSplit({
          splitArity: Math.max(5, options.splitArity + 1),
          areaRetention: options.areaRetention * 0.96,
        }),
        layout: poissonLayout(),
        outline: smoothBlobOutline({
          name: "poisson-smooth",
          minAspect: 0.72,
          maxAspect: 1.38,
          waveAmplitude: 0.22,
          secondaryWaveAmplitude: 0.12,
          randomAmplitude: 0.04,
        }),
      };
    }

    export function fieldContourSketch(options: PresetOptions): StrategyBundle {
      return {
        growth: powerGrowth({
          ...options,
          baseRadiusPx: options.baseRadiusPx * 1.08,
        }),
        split: areaThresholdSplit(options),
        layout: spiralLayout(),
        outline: contourOutline(),
      };
    }
  }
}
