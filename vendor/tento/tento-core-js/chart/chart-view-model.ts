/**
 * `ChartViewModel` — a chart's view state over its `GraphData` collection:
 * size, pointer, y-scaling and drag. No DOM (sizes are plain numbers), so it
 * lives in `@tento-core/chart` below both the SDK (`@tento-lona/platform`
 * re-exports it) and the UI kit's line chart.
 */

/** A chart's pixel size — structurally the UI kit's ambient `Size`. */
export type ChartSize = { height: number; width: number };

import { LiveData } from "@tento-core/livedata";
import { GraphData } from "./graph-data";
import { ChartPointerStore } from "./chart-pointer-store";
import * as ChartTypes from "./chart-types";

/**
 * The view model a chart renderer draws from: its size, the series data and
 * the pointer state.
 */
export class ChartViewModel {
  private size: Option<ChartSize>;

  readonly invalidates = new LiveData(null);

  get domSize(): Option<ChartSize> {
    return this.size;
  }
  get graphSize(): Option<ChartSize> {
    if (!this.size) return null;
    if (this.swapAxes) {
      return { width: this.size.height, height: this.size.width };
    }
    return this.size;
  }

  constructor(
    public pointer: ChartPointerStore,
    public graphData: GraphData.Collection,
    public swapAxes: boolean = false,
    public xDisplay: Option<(x: number) => string> = null,
  ) {}

  bindSize(size: ChartSize, invalidates: boolean) {
    if (size.height === this.size?.height && size.width === this.size.width)
      return;
    if (size.width === 0 && size.height === 0) return;
    this.size = size;
    invalidates && this.invalidates.update(null);
  }

  notifyInvalidates() {
    this.invalidates.update(null);
  }
}

/**
 * The chart vocabulary under the view model's name. One declaration each:
 * every member is `./chart-types`' own (`AxisRange`, `LinearYScaler`, …),
 * re-exported here — `ChartViewModel.LinearYScaler` IS `LinearYScaler`
 * (`@tento/lona/sheets`), so the two spellings cannot drift apart.
 */
export namespace ChartViewModel {
  export type CanvasValue = ChartTypes.CanvasValue;
  export type DataValue = ChartTypes.DataValue;
  export type YConfig = ChartTypes.YConfig;
  export type Tick = ChartTypes.Tick;
  export import AxisRange = ChartTypes.AxisRange;
  export type YScaler = ChartTypes.YScaler;
  export type DragState = ChartTypes.DragState;
  export import LinearYScaler = ChartTypes.LinearYScaler;
}

export { castData, formatValue } from "./chart-types";
