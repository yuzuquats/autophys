/**
 * Pure chart types — the DOM-free vocabulary `GraphData`,
 * `ChartPointerStore`, `DiscreteConvolution` and `ChartViewModel` share:
 * `DataValue`, `CanvasValue`, `YConfig`, `Tick`, `AxisRange`, `YScaler`,
 * `LinearYScaler`, `DragState`, `castData`, `formatValue`.
 */

import { iterateSparseRange, SparseArray } from "@tento-core/sparse-array";
import type { NumRangeLike } from "@tento-core/range";

/** Data-space y value (range-scaled). Branded to prevent accidental swap. */
export type DataValue = number & { space: "data" };

/** Canvas-space y value (pixels). Branded to prevent accidental swap. */
export type CanvasValue = number & { space: "canvas" };

export interface YConfig {
  range: AxisRange;
}

export interface Tick {
  value: number;
  resolved: number;
  label: string;
}

/** A chart axis's minimum, maximum and center. */
export interface AxisRange {
  min: DataValue;
  max: DataValue;
  center: DataValue;
}

export namespace AxisRange {
  export const HALF_UNIT: AxisRange = Object.freeze({
    min: -0.5 as DataValue,
    center: 0 as DataValue,
    max: 0.5 as DataValue,
  });

  export const UNIT: AxisRange = Object.freeze({
    min: -1 as DataValue,
    center: 0 as DataValue,
    max: 1 as DataValue,
  });

  /**
   * Compute a sensible `AxisRange` from the observed data over
   * `xRange`. Degenerate cases (no data or all values equal)
   * collapse to `[-1, 1]` with center=0 so downstream rendering
   * doesn't divide by zero.
   */
  export function makeFromData(
    data: SparseArray<number>,
    xRange: NumRangeLike,
  ): AxisRange {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const [_time, value] of iterateSparseRange(
      data,
      xRange.start,
      xRange.end,
    )) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      count++;
    }
    if (count === 0 || min === max) {
      min = -1;
      max = 1;
    }
    const center = (min + max) / 2;
    return {
      min: castData(min),
      max: castData(max),
      center: castData(center),
    };
  }
}

export interface DragState {
  originalRange: AxisRange;
}

/**
 * Canvas ↔ data conversion + drag/tick behaviour. The `LinearYScaler`
 * below is the only built-in implementation; renderers may
 * substitute their own for log-scale / power-scale axes.
 */
export interface YScaler {
  yConfig: YConfig;
  c2d(y: CanvasValue, height: number, paddingBlock: number): DataValue;
  d2c(y: DataValue, height: number, paddingBlock: number): CanvasValue;
  handleDrag(
    dragState: DragState,
    progressY: number,
    height: number,
    paddingBlock: number,
  ): AxisRange;
  getTicks(): DataValue[];
}

/** Cast a raw number into the branded `DataValue`. */
export function castData(n: number): DataValue {
  return n as DataValue;
}

/**
 * Short-form display for axis ticks. Scientific notation for
 * very large or very small magnitudes; "1.2k" for thousands.
 */
export function formatValue(value: number): string {
  if (Math.abs(value) >= 1e6) return value.toExponential(1);
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + "k";
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * A chart's linear y-axis scaler, mapping values between data space and
 * canvas space through the stored `YConfig.range`. Supports drag-to-adjust: dragging
 * extends / contracts the range symmetrically around `center`
 * (or anchored at `center === min` for half-open ranges).
 *
 * The one declaration: `ChartViewModel.LinearYScaler` (`./chart-view-model`)
 * re-exports this class. `initialRange` (`null`: the config's range) anchors
 * the interval ticks.
 */
export class LinearYScaler implements YScaler {
  private initialAxisRange: Option<AxisRange>;
  private tickValues: Option<DataValue[]> = null;

  constructor(
    readonly yConfig: YConfig,
    initialRange: Option<AxisRange>,
  ) {
    this.initialAxisRange = initialRange ?? { ...yConfig.range };
  }

  c2d(y: CanvasValue, height: number, paddingBlock: number): DataValue {
    const adjustedY = y - paddingBlock;
    const canvasRange = height - 2 * paddingBlock;
    const normalized = 1 - adjustedY / canvasRange;
    const yRangeHeight = this.yConfig.range.max - this.yConfig.range.min;
    return (this.yConfig.range.min + normalized * yRangeHeight) as DataValue;
  }

  d2c(y: DataValue, height: number, paddingBlock: number): CanvasValue {
    const yRangeHeight = this.yConfig.range.max - this.yConfig.range.min;
    const mappedValue =
      ((y - this.yConfig.range.min) / yRangeHeight) *
        (height - 2 * paddingBlock) +
      paddingBlock;
    return mappedValue as CanvasValue;
  }

  private buildNewRange(
    dragState: DragState,
    progressY: number,
    height: number,
    paddingBlock: number,
  ): AxisRange {
    const originalRange =
      dragState.originalRange.max - dragState.originalRange.min;
    const availableHeight = height - 2 * paddingBlock;
    if (dragState.originalRange.min === dragState.originalRange.center) {
      const dataDelta = progressY / (availableHeight / originalRange);
      const newMax = Math.max(
        0.01,
        dragState.originalRange.max - dataDelta * 2,
      );
      return {
        min: dragState.originalRange.center,
        max: castData(newMax),
        center: dragState.originalRange.center,
      };
    }
    const dataDelta = progressY / (availableHeight / originalRange);
    const newHalfRange = Math.max(0.01, originalRange / 2 - dataDelta);
    return {
      min: castData(dragState.originalRange.center - newHalfRange),
      max: castData(dragState.originalRange.center + newHalfRange),
      center: dragState.originalRange.center,
    };
  }

  handleDrag(
    dragState: DragState,
    progressY: number,
    height: number,
    paddingBlock: number,
  ): AxisRange {
    const r = this.buildNewRange(dragState, progressY, height, paddingBlock);
    this.yConfig.range.min = r.min;
    this.yConfig.range.max = r.max;
    this.yConfig.range.center = r.center;
    this.tickValues = this.computeTickValues();
    return r;
  }

  getTicks(): DataValue[] {
    if (!this.tickValues) this.tickValues = this.computeTickValues();
    return this.tickValues;
  }

  updateYRange(range: AxisRange): void {
    this.yConfig.range = range;
    this.tickValues = null;
  }

  private computeTickValues(): DataValue[] {
    const tickSet = new Set<number>();
    const { min, max, center } = this.yConfig.range;
    tickSet.add(min);
    tickSet.add(max);
    tickSet.add(center);
    if (this.initialAxisRange) {
      const interval =
        (this.initialAxisRange.max - this.initialAxisRange.min) * 0.25;
      this.addIntervalTicks(tickSet, this.initialAxisRange.center, interval);
    }
    const sortedTicks = Array.from(tickSet)
      .map((v) => Math.round(v * 1000) / 1000)
      .sort((a, b) => a - b);
    return this.cullTicks(sortedTicks) as DataValue[];
  }

  private addIntervalTicks(
    tickSet: Set<number>,
    center: number,
    interval: number,
  ): void {
    const { min, max } = this.yConfig.range;
    for (let value = center; value <= max; value += interval) {
      if (value >= min) tickSet.add(value);
    }
    for (let value = center - interval; value >= min; value -= interval) {
      if (value <= max) tickSet.add(value);
    }
  }

  private cullTicks(ticks: number[]): number[] {
    if (ticks.length <= 8) return ticks;
    const { min, max, center } = this.yConfig.range;
    const anchors = new Set(
      [min, max, center].map((v) => Math.round(v * 1000) / 1000),
    );
    const others = ticks.filter((v) => !anchors.has(v));
    const targetOthers = 5;
    const keepEvery = Math.ceil(others.length / targetOthers);
    const kept = others.filter((_, idx) => idx % keepEvery === 0);
    return [min, max, center, ...kept]
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort((a, b) => a - b);
  }
}
