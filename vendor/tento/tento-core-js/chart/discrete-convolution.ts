/**
 * Discrete kernel-smooth convolution — the math behind the
 * `regression` graph-data type. Pure (no DOM), shared by the chart view
 * model and the SDK's regression index.
 */

import { type KernelFunction, Kernels } from "@tento-core/convolution/kernels";
import type { NumRangeLike } from "@tento-core/range";
import { iterateSparseRange, SparseArray } from "@tento-core/sparse-array";

import type { RegressionData } from "./graph-data";

/**
 * Checked indexed read: the element at `index`, or a `RangeError` naming the
 * collection, index and length when the slot is `undefined`.
 */
function elementAt<T>(xs: ArrayLike<T>, index: number, what: string): T {
  const value = xs[index];
  if (value === undefined) {
    throw new RangeError(`${what}: index ${index} out of range (length ${xs.length})`);
  }
  return value;
}

/**
 * A regression over sparse data computed by discrete convolution with a
 * kernel.
 */
export class DiscreteConvolution implements RegressionData {
  data: SparseArray<number> = new SparseArray<number>();
  confidence: SparseArray<number> = new SparseArray<number>();
  range: Option<NumRangeLike>;
  padding: number = 0;
  // Track data support density for fading
  dataDensity: SparseArray<number> = new SparseArray<number>();
  // Unified trust signal (Phase 3)
  trust: SparseArray<number> = new SparseArray<number>();

  // Cache for kernel weights to avoid recomputation
  private kernelWeightCache: Map<number, number> = new Map();

  constructor(
    readonly halfWidth: number,
    private readonly kernelFunc: (dt: number) => number,
    private readonly confFactor = 1,
  ) {
    if (halfWidth <= 0) {
      throw new Error(`halfWidth must be positive, got ${halfWidth}`);
    }
    this.precomputeKernelWeights();
  }

  private precomputeKernelWeights(): void {
    // Pre-compute weights for integer offsets within the kernel window
    // Limit pre-computation to reasonable range to avoid memory issues
    const maxPrecompute = Math.min(this.halfWidth, 50);
    for (let dt = -maxPrecompute; dt <= maxPrecompute; dt++) {
      this.kernelWeightCache.set(dt, this.kernelFunc(dt));
    }
  }

  private getKernelWeight(dt: number): number {
    // Use cached value if available, otherwise compute
    const cached = this.kernelWeightCache.get(dt);
    if (cached !== undefined) return cached;

    const weight = this.kernelFunc(dt);
    // Cache for future use (only cache reasonable range to avoid memory issues)
    if (Math.abs(dt) <= this.halfWidth * 2) {
      this.kernelWeightCache.set(dt, weight);
    }
    return weight;
  }

  /**
   * Populate from pre-computed regression curve (from RegressionIndex).
   * Replaces independent computation — single source of truth.
   */
  populateFromCurve(
    curve: readonly {
      x: number;
      y: number;
      confidence: number;
      density: number;
      trust?: number;
    }[],
  ): void {
    if (curve.length === 0) return;

    // Derive range from the curve itself — NOT from the column's paddedRange.
    // The curve spans the full data range, which may differ from any single
    // column's viewport.
    const curveRange: NumRangeLike = {
      start: elementAt(curve, 0, "discrete-convolution: curve").x,
      end: elementAt(curve, curve.length - 1, "discrete-convolution: curve").x,
    };

    this.range = this.range
      ? {
          start: Math.min(this.range.start, curveRange.start),
          end: Math.max(this.range.end, curveRange.end),
        }
      : { ...curveRange };

    const dataPoints: Array<[number, number]> = [];
    const confPoints: Array<[number, number]> = [];
    const densityPoints: Array<[number, number]> = [];
    const trustPoints: Array<[number, number]> = [];
    for (const p of curve) {
      dataPoints.push([p.x, p.y]);
      confPoints.push([p.x, p.confidence]);
      densityPoints.push([p.x, p.density]);
      trustPoints.push([p.x, p.trust ?? p.density]);
    }
    this.data.append(curveRange, dataPoints);
    this.confidence.append(curveRange, confPoints);
    this.dataDensity.append(curveRange, densityPoints);
    this.trust.append(curveRange, trustPoints);
  }

  generatePoints(
    range: NumRangeLike,
    samples: SparseArray<number>,
    padding: number,
    maxGap: Option<number>,
  ): void {
    // Determine which points need to be computed before doing any work
    const pointsToCompute = this.getPointsToCompute(range, samples);

    // Early return if no new points need computation
    let hasNewPoints = false;
    for (const x of pointsToCompute) {
      if (this.data.get(x) == null) {
        hasNewPoints = true;
        break;
      }
    }
    if (!hasNewPoints) {
      return; // All points already computed
    }

    // Build a gap map for fast "is this x in a gap?" checks.
    // Collect all sample x-positions, then check if the nearest sample
    // is further than maxGap.
    const effectiveMaxGap = maxGap ?? this.halfWidth;
    const sampleXs: number[] = [];
    samples.iter(range, ([x]) => sampleXs.push(x));
    sampleXs.sort((a, b) => a - b);

    // Update range to be the union of existing range and new range
    this.range = this.range
      ? {
          start: Math.min(this.range.start, range.start),
          end: Math.max(this.range.end, range.end),
        }
      : { ...range };

    // Use larger padding to ensure stability across boundaries
    const effectivePadding = Math.max(padding, this.halfWidth * 3);
    this.padding = effectivePadding;

    // Generate convolution data and confidence values
    const dataPoints: Array<[number, number]> = [];
    const confidencePoints: Array<[number, number]> = [];
    const densityPoints: Array<[number, number]> = [];

    // Compute convolution only at necessary points, skipping gap regions
    for (const x of pointsToCompute) {
      if (this.data.get(x) != null) continue;

      // Skip points that fall in a gap between segments
      if (sampleXs.length > 0 && isInGap(x, sampleXs, effectiveMaxGap)) continue;

      const result = this.computeConvolutionAt(x, samples);
      dataPoints.push([x, result.value]);
      confidencePoints.push([x, result.confidence]);
      densityPoints.push([x, result.density]);
    }

    // Append all points at once for efficiency
    if (dataPoints.length > 0) {
      this.data.append(range, dataPoints);
      this.confidence.append(range, confidencePoints);
      this.dataDensity.append(range, densityPoints);
    }
  }

  /**
   * Determines which points need convolution computation based on:
   * 1. Computing at actual sample positions
   * 2. Filling gaps between samples for smooth visualization
   */
  private getPointsToCompute(
    range: NumRangeLike,
    samples: SparseArray<number>,
  ): Set<number> {
    const pointsToCompute = new Set<number>();

    // Strategy: Compute convolution at actual data points and intelligently fill gaps
    // This works better for millisecond-scale data where we can't compute at every integer

    // For proper confidence intervals, we need to look at data beyond the visible range
    // Extend the range by 2x halfWidth to ensure we have enough context
    const extendedRange = {
      start: range.start - this.halfWidth * 2,
      end: range.end + this.halfWidth * 2,
    };

    // Collect ALL sample positions in the extended range for context
    const allSamplePositions: number[] = [];
    samples.iter(extendedRange, ([x]) => {
      allSamplePositions.push(x);
    });

    // Filter positions for computation (within the requested range)
    const samplePositions: number[] = [];
    for (const x of allSamplePositions) {
      if (x >= range.start && x <= range.end) {
        samplePositions.push(x);
        pointsToCompute.add(x); // Always compute at actual data points
      }
    }

    // Even if no samples in visible range, compute some points if we have nearby data
    if (samplePositions.length === 0 && allSamplePositions.length > 0) {
      // Find the closest samples to our range
      const closestBefore = allSamplePositions
        .filter((x) => x < range.start)
        .sort((a, b) => b - a)[0];
      const closestAfter = allSamplePositions
        .filter((x) => x > range.end)
        .sort((a, b) => a - b)[0];

      // Ensure we create enough points for smooth visualization
      // Calculate appropriate density based on range size
      const rangeSize = range.end - range.start;
      const minPointsForSmooth = 50; // Minimum points needed for smooth curves
      const numInterpolationPoints = Math.max(
        minPointsForSmooth,
        Math.min(200, Math.floor(rangeSize / 1000)),
      );

      const step = rangeSize / (numInterpolationPoints - 1);
      for (let i = 0; i < numInterpolationPoints; i++) {
        pointsToCompute.add(Math.floor(range.start + i * step));
      }

      // If we have boundary samples close enough, include them in samplePositions for gap filling
      if (
        closestBefore !== undefined &&
        range.start - closestBefore <= this.halfWidth * 2
      ) {
        samplePositions.push(closestBefore);
      }
      if (
        closestAfter !== undefined &&
        closestAfter - range.end <= this.halfWidth * 2
      ) {
        samplePositions.push(closestAfter);
      }
    }

    if (samplePositions.length === 0 && allSamplePositions.length === 0) {
      // No samples at all - still compute points in range for max confidence values
      const rangeSize = range.end - range.start;
      const numPoints = Math.min(50, rangeSize + 1);
      const step = rangeSize / Math.max(numPoints - 1, 1);
      for (let i = 0; i < numPoints; i++) {
        pointsToCompute.add(Math.floor(range.start + i * step));
      }
      return pointsToCompute;
    }

    if (samplePositions.length === 0) {
      return pointsToCompute;
    }

    // Sort positions for gap analysis
    samplePositions.sort((a, b) => a - b);

    // Determine minimum points needed for smooth curves
    const minPointsBetweenSamples = 20; // Ensure smooth curves between data points

    // Fill gaps between consecutive samples
    for (let i = 0; i < samplePositions.length - 1; i++) {
      const current = elementAt(samplePositions, i, "discrete-convolution: samplePositions");
      const next = elementAt(samplePositions, i + 1, "discrete-convolution: samplePositions");
      const gap = next - current;

      // Skip filling gaps that are likely between separate visible ranges
      // rather than gaps within continuous data
      if (gap >= this.halfWidth) {
        continue;
      }

      if (gap > 1) {
        // Calculate how many interpolation points we need
        let numPoints: number;

        if (gap > 1000000) {
          // Millisecond scale - ensure minimum density
          numPoints = Math.max(
            minPointsBetweenSamples,
            Math.min(100, Math.floor(gap / 60000)),
          );
        } else if (gap > 1000) {
          // Second/minute scale
          numPoints = Math.max(
            minPointsBetweenSamples,
            Math.min(50, Math.floor(gap / 100)),
          );
        } else {
          // Small gaps - fill densely for smoothness
          numPoints = Math.min(gap - 1, minPointsBetweenSamples);
        }

        const step = gap / (numPoints + 1);
        for (let j = 1; j <= numPoints; j++) {
          pointsToCompute.add(Math.floor(current + step * j));
        }
      }
    }

    // Ensure we have points before the first sample and after the last sample
    // This prevents triangular artifacts at the edges
    if (samplePositions.length > 0) {
      const firstSample = elementAt(samplePositions, 0, "discrete-convolution: samplePositions");
      const lastSample = elementAt(samplePositions, samplePositions.length - 1, "discrete-convolution: samplePositions");

      // Add points before first sample if in range
      if (firstSample > range.start) {
        const gap = firstSample - range.start;
        const numPoints = Math.min(20, Math.max(5, Math.floor(gap / 10000)));
        const step = gap / (numPoints + 1);
        for (let j = 1; j <= numPoints; j++) {
          pointsToCompute.add(Math.floor(range.start + step * j));
        }
      }

      // Add points after last sample if in range
      if (lastSample < range.end) {
        const gap = range.end - lastSample;
        const numPoints = Math.min(20, Math.max(5, Math.floor(gap / 10000)));
        const step = gap / (numPoints + 1);
        for (let j = 1; j <= numPoints; j++) {
          pointsToCompute.add(Math.floor(lastSample + step * j));
        }
      }
    }

    // For very large scale data (like milliseconds), limit total points
    const maxTotalPoints = 1000;
    if (pointsToCompute.size > maxTotalPoints) {
      // Downsample to reasonable number
      const pointArray = Array.from(pointsToCompute).sort((a, b) => a - b);
      const keepEvery = Math.ceil(pointArray.length / maxTotalPoints);
      const downsampled = new Set<number>();

      for (let i = 0; i < pointArray.length; i += keepEvery) {
        downsampled.add(elementAt(pointArray, i, "discrete-convolution: pointArray"));
      }

      // Always keep first and last points
      downsampled.add(elementAt(pointArray, 0, "discrete-convolution: pointArray"));
      downsampled.add(elementAt(pointArray, pointArray.length - 1, "discrete-convolution: pointArray"));

      return downsampled;
    }

    return pointsToCompute;
  }

  private computeConvolutionAt(
    x: number,
    samples: SparseArray<number>,
  ): { value: number; confidence: number; density: number } {
    let weightedSum = 0;
    let weightSum = 0;
    let weightedSumSquared = 0;
    let sampleCount = 0;

    const minT = x - this.halfWidth;
    const maxT = x + this.halfWidth;

    // Use efficient iteration over the sample range
    for (const [t, sampleValue] of iterateSparseRange(samples, minT, maxT)) {
      const dt = t - x;
      const weight = this.getKernelWeight(dt); // Use cached weights

      if (weight <= 0) continue;

      weightedSum += weight * sampleValue;
      weightedSumSquared += weight * sampleValue * sampleValue;
      weightSum += weight;
      sampleCount++;
    }

    // Density measures spatial coverage within the kernel window.
    // Count-based density is blind to gaps — 8 points clustered at the
    // window edges produce the same count as 8 evenly-spaced points.
    // Instead, measure 1 - (maxGap / windowSize). A 13-day gap in a
    // 20-day window → density 0.35, not 1.0.
    let density: number;
    if (sampleCount <= 1) {
      density = sampleCount === 0 ? 0 : 0.3;
    } else {
      // Collect x-positions of samples in the kernel window
      const xs: number[] = [];
      for (const [t] of iterateSparseRange(samples, minT, maxT)) {
        xs.push(t);
      }
      // Find largest gap between consecutive samples (already sorted)
      let maxGap = elementAt(xs, 0, "discrete-convolution: xs") - minT; // gap from window start to first point
      for (let i = 1; i < xs.length; i++) {
        maxGap = Math.max(maxGap, elementAt(xs, i, "discrete-convolution: xs") - elementAt(xs, i - 1, "discrete-convolution: xs"));
      }
      maxGap = Math.max(maxGap, maxT - elementAt(xs, xs.length - 1, "discrete-convolution: xs")); // gap from last point to window end
      const windowSize = maxT - minT;
      density = windowSize > 0
        ? Math.max(0, 1 - maxGap / windowSize)
        : 0;
    }

    if (weightSum === 0) {
      // No data within kernel window - high uncertainty, zero density
      // Return 0 value but with maximum confidence interval
      return { value: 0, confidence: Number.MAX_SAFE_INTEGER, density: 0 };
    }

    const mean = weightedSum / weightSum;
    const variance = weightedSumSquared / weightSum - mean * mean;
    const stdev = Math.sqrt(Math.max(0, variance));

    // Handle confidence based on number of samples and variance
    let confidence: number;

    if (sampleCount === 1) {
      // Single sample: use minimal confidence (no variance to calculate)
      confidence = this.confFactor * 0.001;
    } else if (variance === 0) {
      // Multiple identical samples: use minimal confidence (zero variance)
      confidence = this.confFactor * 0.001;
    } else {
      // Normal case: use calculated standard deviation
      confidence = this.confFactor * stdev;

      // For very sparse data (2-3 points), increase confidence slightly
      if (sampleCount <= 3) {
        confidence *= 1.5;
      }
    }

    return { value: mean, confidence, density };
  }

  static gaussianKernel: (halfWidth: number) => KernelFunction = Kernels.gaussian;
  static hammingKernel: (halfWidth: number) => KernelFunction = Kernels.hamming;
  static epanechnikovKernel: (halfWidth: number) => KernelFunction = Kernels.epanechnikov;
}

/**
 * Check if x falls in a gap between data segments.
 * A gap exists when consecutive samples are further apart than maxGap.
 * Uses binary search to find the nearest sample efficiently.
 */
function isInGap(x: number, sortedSampleXs: number[], maxGap: number): boolean {
  const xs = sortedSampleXs;
  // Binary search for insertion point
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (elementAt(xs, mid, "discrete-convolution: xs") < x) lo = mid + 1;
    else hi = mid;
  }
  // Check distance to nearest sample on either side
  const distLeft = lo > 0 ? x - elementAt(xs, lo - 1, "discrete-convolution: xs") : Infinity;
  const distRight = lo < xs.length ? elementAt(xs, lo, "discrete-convolution: xs") - x : Infinity;
  const nearest = Math.min(distLeft, distRight);
  // In a gap if nearest sample is further than maxGap
  // AND the gap between the flanking samples exceeds maxGap
  if (nearest <= maxGap) return false;
  if (lo > 0 && lo < xs.length && elementAt(xs, lo, "discrete-convolution: xs") - elementAt(xs, lo - 1, "discrete-convolution: xs") > maxGap) return true;
  // Also skip if we're past the edge of data by more than maxGap
  return nearest > maxGap;
}
