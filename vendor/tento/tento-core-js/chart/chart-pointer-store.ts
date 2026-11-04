/**
 * Per-chart pointer state, tracked across every chart visible on a
 * page. The store picks one active chart at a time (the most
 * recently-updated one) and fans that state out to subscribers —
 * the canvas overlay, the crosshair, the value readout, etc.
 *
 * A pure data-layer chart primitive, with `GraphData` and
 * `DiscreteConvolution`: it lives in `@tento-core/chart` so the SDK and the
 * UI kit both import it downward.
 */

import { LiveData } from "@tento-core/livedata";
import type { Point } from "@tento-core/point";

export type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The pointer state of every chart on a page: which chart is hovered and
 * where.
 */
export class ChartPointerStore {
  private pointerStates = new Map<string, ChartPointerStore.PointerState>();
  private activePointerState = new LiveData<
    Option<ChartPointerStore.PointerState>
  >(null);
  private updateOrder: string[] = [];

  /** `target` is the listener's identity: `unsubscribe(target)` removes it. */
  subscribe(
    target: object,
    callback: (state: Option<ChartPointerStore.PointerState>) => void,
  ): void {
    this.activePointerState.addListener(
      target,
      callback,
      LiveData.TriggerImmediately,
    );
  }

  unsubscribe(target: object): void {
    this.activePointerState.removeListener(target);
  }

  updatePointer(state: ChartPointerStore.PointerState): void {
    this.pointerStates.set(state.chartId, state);
    const index = this.updateOrder.indexOf(state.chartId);
    if (index > -1) this.updateOrder.splice(index, 1);
    this.updateOrder.unshift(state.chartId);
    this.updateActiveState();
  }

  clearPointer(chartId: string): void {
    this.pointerStates.delete(chartId);
    const index = this.updateOrder.indexOf(chartId);
    if (index > -1) this.updateOrder.splice(index, 1);
    this.updateActiveState();
  }

  getCurrentState(): Option<ChartPointerStore.PointerState> {
    return this.activePointerState.get();
  }

  getChartState(chartId: string): Option<ChartPointerStore.PointerState> {
    return this.pointerStates.get(chartId) ?? null;
  }

  private updateActiveState(): void {
    if (this.updateOrder.length === 0) {
      this.activePointerState.update(null);
      return;
    }
    for (const chartId of this.updateOrder) {
      const state = this.pointerStates.get(chartId);
      if (state) {
        this.activePointerState.update(state);
        return;
      }
    }
    this.activePointerState.update(null);
  }
}

export namespace ChartPointerStore {
  export interface PointerState {
    chartId: string;
    global: Point;
    data: Point;
    chartBounds: Bounds;
    hovered?: Option<{
      point: Point;
      canvas: Point;
    }>;
    xDisplay?: Option<(x: number) => string>;
  }
}
