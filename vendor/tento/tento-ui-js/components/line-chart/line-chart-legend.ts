import "../round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LazySync } from "../../lazy";
import { Point } from "@tento-core/point";
import { ChartViewModel, formatValue } from "./chart-view-model";
import { ChartPointerStore } from "./chart-pointer-store";
import { ChartTickMark } from "./chart-tick-mark";
import { Round } from "../round";

@component({
  name: "std-line-chart-legend",
})
export class LineChartLegend extends LonaWebComponent {
  private vm: Option<ChartViewModel>;
  private yScaler: Option<ChartViewModel.YScaler>;
  private yPadding: Option<number>;

  private dragState: Option<{
    startPoint: Point;
    startDataY: number;
    originalRange: {
      min: ChartViewModel.DataValue;
      max: ChartViewModel.DataValue;
      center: ChartViewModel.DataValue;
    };
  }>;
  private $bg = this.hydrate<Round>("bg")
    .bind({
      ...Round.Props.FLAT_CARD,
      bg: "var(--std-line-chart-legend-bg)",
      shadow: "0 0px 1px rgba(0,0,0,0.35)",
      radius: 16,
    });

  private $cursorTick: LazySync<ChartTickMark> = new LazySync(() => {
    const $tick = ChartTickMark.make();
    $tick.style.display = "none";
    $tick.style.zIndex = "10";

    const $cursor = this.$("cursor");
    $cursor.appendChild($tick);
    return $tick;
  });

  private size: Option<Size>;
  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    this.size = size;
    if (this.size.width === 0 && this.size.height === 0) return;
    if (!this.vm || !this.yScaler) return;

    this.bindTicks(this.yScaler.getTicks());
  };

  constructor() {
    super();
    GESTURE_MANAGER.addDragGesture(this.$("root"), "line-chart-legend-scale", {
      onPointerDown: (e) => this.handleDragStart(e),
      onPointerMove: ({ progress }) => this.handleDragMove(progress),
      onPointerUp: () => this.handleDragEnd(),
    });
  }

  disconnectedCallback() {
    this.vm?.pointer.unsubscribe(this);
  }

  bind(props: LineChartLegend.Props) {
    this.vm = props.vm;
    this.yScaler = props.yScaler;
    this.yPadding = props.yPadding;

    // Render against whatever height is known now (the canvas's shared
    // `vm.domSize`, or our own measured size). On initial load both can be
    // unset — `bindTicks` no-ops, and `onSizeChange` re-runs it the moment the
    // ResizeObserver delivers our height, so the axis no longer waits for the
    // canvas to populate `vm.domSize` before the ticks appear.
    this.bindTicks(props.yScaler.getTicks());
    props.vm.pointer.subscribe(this, (state) => {
      const height = this.resolvedHeight();
      if (height != null) this.bindCursorTick(state, height);
    });
  }

  /**
   * Chart height for tick math, most-authoritative first: the canvas's shared
   * `vm.domSize` (keeps the axis on the same scale as the body), then our last
   * ResizeObserver size, then a live `offsetHeight` read. The `offsetHeight`
   * fallback is what survives a reopen: when the axis re-binds, `vm.domSize`
   * can be unset and the RO size can still read 0 (the observer hasn't fired
   * for the recycled element yet) — but the element is already laid out, so a
   * direct measure paints the ticks immediately instead of leaving the axis
   * blank until some later resize. Zero/absent values are skipped, not returned
   * (a `0` height must NOT win the `??` chain).
   */
  private resolvedHeight(): Option<number> {
    const vmHeight = this.vm?.domSize?.height;
    if (vmHeight != null && vmHeight > 0) return vmHeight;
    const observedHeight = this.size?.height;
    if (observedHeight != null && observedHeight > 0) return observedHeight;
    return this.offsetHeight > 0 ? this.offsetHeight : null;
  }

  bindTicks(ticks: ChartViewModel.DataValue[]) {
    const $base = this.$("base");
    DomUtils.clearChildren($base);

    const domHeight = this.resolvedHeight();
    if (!domHeight) return;

    for (const tick of ticks) {
      const resolved = this.yScaler!.d2c(tick, domHeight, this.yPadding!);
      const $tickElement = ChartTickMark.make();
      $tickElement.bind({
        label: formatValue(tick),
        positionPx: resolved,
      });
      $base.appendChild($tickElement);
    }
  }

  private rescaleTicks() {
    if (!this.vm || !this.yScaler) return;
    this.bindTicks(this.yScaler.getTicks());
  }

  private bindCursorTick(
    state: Option<ChartPointerStore.PointerState>,
    height: number,
  ) {
    const $tick = this.$cursorTick.get();

    if (!state || !this.vm || !this.yScaler) {
      $tick.style.display = "none";
      return;
    }

    $tick.bind({
      label: state.data.y.toFixed(2),
      positionPx: this.yScaler.d2c(
        state.data.y as ChartViewModel.DataValue,
        height,
        this.yPadding!,
      ),
    });
    $tick.style.display = "flex";
  }

  private handleDragStart(e: PointerEvent) {
    if (!this.vm || !this.yScaler) return;

    const $root = this.$("root");
    this.dragState = {
      startPoint: { x: 0, y: e.clientY - $root.getBoundingClientRect().top },
      startDataY: 0, // Not used
      originalRange: { ...this.yScaler.yConfig.range },
    };

    $root.classList.add("dragging");
  }

  private handleDragMove(progress: Point) {
    const domHeight = this.resolvedHeight();
    if (!this.dragState || !this.vm || !this.yScaler || !domHeight) return;

    this.yScaler.handleDrag(
      { originalRange: this.dragState.originalRange },
      progress.y,
      domHeight,
      this.yPadding!,
    );
    this.vm.notifyInvalidates();

    this.rescaleTicks();
  }

  private handleDragEnd(): void {
    this.dragState = undefined;
    this.$("root").classList.remove("dragging");
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        width: 64px;
        --std-line-chart-legend-bg: var(--bg);
      }

      #root {
        width: inherit;
        height: 100%;
        position: relative;
        cursor: ns-resize;
      }

      #base, #cursor {
        position: absolute;
        inset: 0;
        top: 0px;
        bottom: 0px;
        overflow: hidden;
        border-radius: 16px;
      }

      #bg {
        top: 2px;
        bottom: 2px;
        height: calc(100% - 4px);
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-round id=bg floating></std-round>
      <div id=base></div>
      <div id=cursor></div>
    </std-col>
  `;
}

export namespace LineChartLegend {
  export type Props = {
    vm: ChartViewModel;
    yScaler: ChartViewModel.YScaler;
    yPadding: number;
  };
}
