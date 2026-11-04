/**
 * Graph-data rows — the data-side container a chart reads from.
 *
 * A `GraphData` holds the raw `[x, y]` points plus (optionally) a
 * regression curve derived via `DiscreteConvolution`. Multiple
 * `GraphData` rows compose into a `GraphData.Collection` that a
 * canvas views; each row keeps its own y-scaler so dual-axis
 * overlays are a matter of looking up the right entry.
 */

import { nonnull } from "@tento-core/assert";
import { ProceduralSignal } from "@tento-core/procedural-signal";
import type { NumRangeLike } from "@tento-core/range";
import { SparseArray } from "@tento-core/sparse-array";

import type { AxisRange, YConfig, YScaler } from "./chart-types";
import { LinearYScaler } from "./chart-types";
import { DiscreteConvolution } from "./discrete-convolution";

/** A series' smoothed regression curve and its confidence, per x, which the chart painters draw. */
export interface RegressionData {
  readonly data: SparseArray<number>;
  readonly confidence: SparseArray<number>;
  readonly range: Option<NumRangeLike>;
  readonly padding: number;
  readonly dataDensity?: SparseArray<number>;
  /** Unified support signal (Phase 3). Renderers consume this
   *  as the single input for opacity/width/clipping. */
  readonly trust?: SparseArray<number>;

  generatePoints(
    range: NumRangeLike,
    samples: SparseArray<number>,
    padding: number,
    maxGap: Option<number>,
  ): void;
}

/** What a chart plots: its data, range and regressions. */
export interface GraphData<Y = number> {
  readonly regressions: Map<string, RegressionData>;
  readonly data: SparseArray<Y>;
  readonly range: Option<NumRangeLike>;

  populate(
    range: NumRangeLike,
    paddedRange: NumRangeLike,
    points: [number, Y][],
    loggingId: string,
    regressionCurve: Option<GraphData.RegressionCurve>,
  ): Promise<GraphData>;
}

export namespace GraphData {
  /** A precomputed regression curve (`RegressionIndex` output) that
   *  `WithRegression.populate` installs instead of convolving `points`. */
  export type RegressionCurve = readonly {
    x: number;
    y: number;
    confidence: number;
    density: number;
  }[];

  export type Row = {
    data: GraphData;
    yScaler?: Option<YScaler>;
  };

  export class Collection {
    readonly range: Option<NumRangeLike>;

    constructor(
      public readonly rows: Map<string, GraphData.Row>,
      private readonly defaultRowData: GraphData.Row,
      public readonly defaultYScaler: YScaler,
    ) {}

    static makeFromSpec(
      specs: Collection.Spec[],
      defaultYAxis: AxisRange,
    ): Collection {
      const defaultYScaler = new LinearYScaler({
        range: defaultYAxis,
      }, null);
      let defaultData: Option<GraphData.Row>;
      const dataMap = new Map<string, GraphData.Row>();
      for (const spec of specs) {
        const data = Collection.build(spec);
        const conf: GraphData.Row = {
          data,
          yScaler: spec.yRange
            ? new LinearYScaler({ range: spec.yRange }, null)
            : null,
        };
        if (!defaultData) defaultData = conf;
        dataMap.set(spec.key, conf);
      }
      return new Collection(
        dataMap,
        nonnull(
          defaultData,
          "GraphData.Collection.makeFromSpec: needs at least one spec (the first is the default row)",
        ),
        defaultYScaler,
      );
    }

    get defaultData(): {
      data: GraphData;
      yScaler: YScaler;
    } {
      return {
        data: this.defaultRowData.data,
        yScaler: this.defaultRowData.yScaler ?? this.defaultYScaler,
      };
    }

    /**
     * Rows are heterogeneous (scalar series, `[height, width]` bar tuples,
     * …), so the caller names the point type its renderer populated.
     */
    get<Y = number>(
      key: string,
    ): Option<{
      data: GraphData<Y>;
      yScaler: YScaler;
    }> {
      const dd = this.rows.get(key);
      if (!dd) return null;
      dd.yScaler = dd.yScaler ?? this.defaultYScaler;
      return {
        data: dd.data as GraphData<Y>,
        yScaler: dd.yScaler ?? this.defaultYScaler,
      };
    }

    getRegression(key: string): Option<{
      data: GraphData;
      conv: DiscreteConvolution;
      yScaler: YScaler;
    }> {
      const conf = this.rows.get(key);
      if (!conf) return null;
      if (conf?.data instanceof GraphData.WithRegression) {
        return {
          data: conf.data,
          conv: conf.data.conv,
          yScaler: conf.yScaler ?? this.defaultYScaler,
        };
      }
      if (conf?.data instanceof GraphData.Generated) {
        return {
          data: conf.data,
          conv: conf.data.conv,
          yScaler: conf.yScaler ?? this.defaultYScaler,
        };
      }
      return null;
    }

    private static build(spec: Collection.Spec): GraphData {
      switch (spec.type) {
        case "regression": {
          const halfWidth = spec.convHalfWidth ?? 10;
          return new GraphData.WithRegression(
            new DiscreteConvolution(
              halfWidth,
              DiscreteConvolution.gaussianKernel(halfWidth),
              1.96,
            ),
            spec.maxGap,
          );
        }
        case "default":
          return new GraphData.Default();
        case "debug":
          return new GraphData.Generated({ seed: spec.seed });
      }
    }
  }

  export namespace Collection {
    export type Spec = {
      key: string;
      yRange?: Option<AxisRange>;
    } & (
      | {
          type: "regression";
          convHalfWidth?: Option<number>;
          maxGap?: Option<number>;
        }
      | { type: "default" }
      | { type: "debug"; seed: number }
    );
  }

  export class Base implements GraphData {
    readonly data: SparseArray<number> = new SparseArray<number>();
    readonly regressions: Map<string, RegressionData> = new Map();

    get range(): Option<NumRangeLike> {
      return this.loadedRange;
    }
    protected loadedRange: Option<NumRangeLike>;

    protected resetIfDisjoint(paddedRange: NumRangeLike): void {
      const vr = this.data.validRange;
      if (!vr) return;
      if (paddedRange.start >= vr.end || paddedRange.end <= vr.start) {
        this.data.reset();
        this.loadedRange = null;
      }
    }

    async populate(
      _range: NumRangeLike,
      _paddedRange: NumRangeLike,
      _points: [number, number][],
      _loggingId: string,
      _regressionCurve: Option<GraphData.RegressionCurve>,
    ): Promise<this> {
      return this;
    }

    toCollection(yConfig: YConfig): GraphData.Collection {
      const yScaler = new LinearYScaler(yConfig, null);
      const dd: GraphData.Row = { data: this, yScaler };
      return new GraphData.Collection(
        new Map([["default", dd]]),
        dd,
        yScaler,
      );
    }
  }

  export class WithRegression extends Base {
    readonly conv: DiscreteConvolution;
    private convolutionPadding: number;
    private maxGap: number;
    /**
     * `conv` the kernel (null ⇒ the default: a width-10 gaussian at 1.96
     * sigma); `maxGap` the widest sample gap bridged (null ⇒ the kernel's
     * half width).
     */
    constructor(conv: Option<DiscreteConvolution>, maxGap: Option<number>) {
      super();
      conv ??= new DiscreteConvolution(
        10,
        DiscreteConvolution.gaussianKernel(10),
        1.96,
      );
      this.conv = conv;
      this.convolutionPadding = conv.halfWidth * 3;
      this.maxGap = maxGap ?? conv.halfWidth;
      this.regressions.set("discrete", this.conv);
    }

    async populate(
      range: NumRangeLike,
      paddedRange: NumRangeLike,
      points: [number, number][],
      loggingId: string,
      regressionCurve: Option<GraphData.RegressionCurve>,
    ): Promise<this> {
      this.resetIfDisjoint(paddedRange);
      await this.data.append(paddedRange, points, loggingId);
      if (!this.loadedRange) {
        this.loadedRange = { ...range };
      } else {
        this.loadedRange.start = Math.min(this.loadedRange.start, range.start);
        this.loadedRange.end = Math.max(this.loadedRange.end, range.end);
      }
      if (regressionCurve != null) {
        // Reset conv — the regression is recomputed from scratch by
        // RegressionIndex whenever data changes, so stale conv values
        // must be replaced entirely, not appended incrementally.
        this.conv.data.reset();
        this.conv.confidence.reset();
        this.conv.dataDensity.reset();
        this.conv.trust.reset();
        this.conv.range = null;
        this.conv.populateFromCurve(regressionCurve);
      } else {
        this.conv.generatePoints(
          paddedRange,
          this.data,
          this.convolutionPadding,
          this.maxGap,
        );
      }
      return this;
    }
  }

  export class Default extends Base {
    async populate(
      range: NumRangeLike,
      paddedRange: NumRangeLike,
      points: [number, number][],
      loggingId: string,
    ): Promise<this> {
      this.resetIfDisjoint(paddedRange);
      await this.data.append(paddedRange, points, loggingId);
      if (!this.loadedRange) {
        this.loadedRange = { ...range };
      } else {
        this.loadedRange.start = Math.min(this.loadedRange.start, range.start);
        this.loadedRange.end = Math.max(this.loadedRange.end, range.end);
      }
      return this;
    }
  }

  export class Generated extends GraphData.Base {
    private halfWidth: number = 10;
    private readonly signal: ProceduralSignal;
    readonly conv = new DiscreteConvolution(
      this.halfWidth,
      DiscreteConvolution.gaussianKernel(this.halfWidth),
      1.96,
    );

    constructor(opts: ProceduralSignal.Options = {}) {
      super();
      this.signal = new ProceduralSignal(opts);
      this.regressions.set("discrete", this.conv);
    }

    private async generateFakeData(
      range: NumRangeLike,
      loggingId: string,
    ): Promise<void> {
      const variance = 0.1;
      const varianceHalf = variance / 2;
      const newPoints: Array<[number, number]> = [];
      for (let x = range.start; x <= range.end; x++) {
        if (this.data.get(x) != null) continue;
        const value =
          this.signal.eval(x) + (Math.random() * variance - varianceHalf);
        newPoints.push([x, value]);
      }
      if (newPoints.length > 0) {
        await this.data.append(range, newPoints, loggingId);
      }
    }

    private async populateRange(
      range: NumRangeLike,
      loggingId: string,
    ): Promise<this> {
      if (range.start > range.end) {
        [range.start, range.end] = [range.end, range.start];
      }
      const convolutionPadding = this.halfWidth * 3;
      const scrollBuffer = 100;
      const totalPadding = convolutionPadding + scrollBuffer;
      const paddedRange = {
        start: range.start - totalPadding,
        end: range.end + totalPadding,
      };
      this.resetIfDisjoint(paddedRange);
      await this.generateFakeData(paddedRange, loggingId);
      this.conv.generatePoints(paddedRange, this.data, convolutionPadding, null);
      this.loadedRange = range;
      return this;
    }

    async populate(
      range: NumRangeLike,
      _paddedRange: NumRangeLike = range,
      _points: [number, number][] = [],
      loggingId: string = "generated",
    ): Promise<this> {
      await this.populateRange(range, loggingId);
      return this;
    }
  }
}
