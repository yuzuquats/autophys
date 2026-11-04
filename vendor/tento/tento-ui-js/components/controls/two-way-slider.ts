import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { DomEventUtils } from "../../dom-event-utils";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { MathUtils } from "@tento-core/math";
import { Typography } from "../../ui/typography";

const DEFAULT_SLIDER_MIN_WIDTH = 180;
const THICK_SLIDER_MIN_WIDTH = 200;
const MIN_THUMB_SPACING = 24;
const TOOLTIP_TIMEOUT_MS = 2000;
const REGULAR_SLIDER_MIN_DISPLAY_WIDTH = 2;
const THICK_SLIDER_MIN_DISPLAY_WIDTH = 4;

namespace SliderUtils {
  export function findClosestSnap(
    value: number,
    snap: Option<number[]>,
  ): number {
    if (snap == null || snap.length === 0) return value;

    let closestSnap = snap[0];
    let minDelta = Number.MAX_SAFE_INTEGER;
    for (const notch of snap) {
      const delta = Math.abs(notch - value);
      if (delta < minDelta) {
        closestSnap = notch;
        minDelta = delta;
      }
    }

    return closestSnap;
  }

  export function wireKeyboard(
    left: HTMLElement, right: HTMLElement,
    current: () => TwoWaySliderState,
    render: (state: TwoWaySliderState) => void,
    emit: EmptyFunction,
    disabled: () => boolean,
  ): void {
    for (const [handle, isStart] of [[left, true], [right, false]] as const) {
      handle.addEventListener("keydown", (event) => {
        if (disabled()) return;
        const state = current();
        const value = isStart ? state.rangeStart : state.rangeEnd;
        const lower = isStart ? state.min : state.rangeStart + state.minWidth;
        const upper = isStart ? state.rangeEnd - state.minWidth : state.max;
        let next: number;
        const direction = ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 :
          ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key) ? -1 : 0;
        if (event.key === "Home") next = lower;
        else if (event.key === "End") next = upper;
        else if (direction !== 0) {
          const snaps = state.snap?.filter(v => Number.isFinite(v) && v >= lower && v <= upper && (direction > 0 ? v > value : v < value));
          if (snaps != null && snaps.length > 0) next = direction > 0 ? Math.min(...snaps) : Math.max(...snaps);
          else next = value + direction * (state.max - state.min) / (event.key.startsWith("Page") ? 10 : 100);
        } else return;
        event.preventDefault();
        event.stopPropagation();
        const updated = isStart ? state.withRangeStart(next) : state.withRangeEnd(next);
        if (updated.rangeStart === state.rangeStart && updated.rangeEnd === state.rangeEnd) return;
        render(updated);
        emit();
      });
    }
  }

  export function updateSemantics(left: HTMLElement, right: HTMLElement, state: TwoWaySliderState, disabled: boolean): void {
    for (const [handle, isStart] of [[left, true], [right, false]] as const) {
      handle.setAttribute("role", "slider");
      handle.tabIndex = disabled ? -1 : 0;
      handle.setAttribute("aria-orientation", "horizontal");
      handle.setAttribute("aria-valuemin", String(isStart ? state.min : state.rangeStart + state.minWidth));
      handle.setAttribute("aria-valuemax", String(isStart ? state.rangeEnd - state.minWidth : state.max));
      handle.setAttribute("aria-valuenow", String(isStart ? state.rangeStart : state.rangeEnd));
      handle.setAttribute("aria-disabled", String(disabled));
    }
  }

  export function createResizeObserver(
    minWidth: number,
    onResize: (width: number) => void,
    getCurrentWidth: () => number,
  ): ResizeObserver {
    return new ResizeObserver(([entry]) => {
      const observedWidth =
        entry.contentRect.width || (entry.target as HTMLElement).offsetWidth;
      const newWidth = Math.max(minWidth, observedWidth);
      if (newWidth > 0 && newWidth !== getCurrentWidth()) {
        onResize(newWidth);
      }
    });
  }

  export function setInitialWidth(
    element: HTMLElement,
    minWidth: number,
    onResize: (width: number) => void,
    getCurrentWidth: () => number,
  ): void {
    $$.measure(() => {
      const computedWidth = Math.max(
        minWidth,
        element.offsetWidth || element.getBoundingClientRect().width,
      );
      if (computedWidth > 0 && computedWidth !== getCurrentWidth()) {
        onResize(computedWidth);
      }
    });
  }
}

const $sliderVariables = css`
  :host {
    --std-slider-track-color: var(--bg-hover, rgba(0, 0, 0, 0.03));
    --std-slider-progress-color: var(--accent-color, #007AFF);
    --std-slider-thumb-color: var(--background-color, white);
    --std-slider-thumb-border-color: var(--divider, rgba(0, 0, 0, 0.12));
  }
`;

const $sliderThumbStyles = css`
  .thumb {
    position: absolute;
    height: 20px;
    width: 20px;
    margin: -1px;
    border-radius: 10px;
    background: var(--std-slider-thumb-color);
    z-index: 999;
    cursor: pointer;
    transition: left 0.3s ease, right 0.3s ease;
  }

  .thumb::before {
    position: absolute;
    content: "";
    top: 0px;
    left: 0px;
    height: 18px;
    width: 18px;
    border-radius: 10px;
    background: var(--std-slider-thumb-color);
    border: 1px solid var(--std-slider-thumb-border-color);
    pointer-events: none;
    opacity: 0.8;
  }

  .thumb.dragging {
    transition: none !important;
  }
`;

export class TwoWaySliderState {
  readonly min: number;
  readonly max: number;
  readonly minWidth: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly widthPx: number;
  readonly trackPaddingPx: number;
  readonly snap: Option<number[]>;

  constructor(
    min: number,
    max: number,
    minWidth: number,
    rangeStart: number,
    rangeEnd: number,
    widthPx: number,
    trackPaddingPx: number = 10,
    snap: Option<number[]> = null,
  ) {
    this.min = min;
    this.max = max;
    this.minWidth = minWidth;
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
    this.widthPx = widthPx;
    this.trackPaddingPx = trackPaddingPx;
    this.snap = snap;
  }

  isValidRange(start: number, end: number): boolean {
    return start >= this.min && end <= this.max && end - start >= this.minWidth;
  }

  findClosestSnap(value: number): number {
    return SliderUtils.findClosestSnap(value, this.snap);
  }

  pixelToValue(px: number): number {
    const effectiveWidthPx = this.widthPx - this.trackPaddingPx * 2;
    const pct = px / effectiveWidthPx;
    return MathUtils.lerp(this.min, this.max, pct);
  }

  valueToPixel(value: number): number {
    const effectiveWidthPx = this.widthPx - this.trackPaddingPx * 2;
    const rangeWidth = this.max - this.min;
    const pct = (value - this.min) / rangeWidth;
    return pct * effectiveWidthPx;
  }

  layoutRange(): { startPx: number; endPx: number; widthPx: number } {
    const startPx = this.valueToPixel(this.rangeStart);
    const endPx = this.valueToPixel(this.rangeEnd);
    return {
      startPx,
      endPx,
      widthPx: endPx - startPx,
    };
  }

  withRangeStart(value: number): TwoWaySliderState {
    const clampedValue = MathUtils.clampInc(
      value,
      this.min,
      this.rangeEnd - this.minWidth,
    );
    return new TwoWaySliderState(
      this.min,
      this.max,
      this.minWidth,
      clampedValue,
      this.rangeEnd,
      this.widthPx,
      this.trackPaddingPx,
      this.snap,
    );
  }

  withRangeEnd(value: number): TwoWaySliderState {
    const clampedValue = MathUtils.clampInc(
      value,
      this.rangeStart + this.minWidth,
      this.max,
    );
    return new TwoWaySliderState(
      this.min,
      this.max,
      this.minWidth,
      this.rangeStart,
      clampedValue,
      this.widthPx,
      this.trackPaddingPx,
      this.snap,
    );
  }

  withRangeShift(deltaPx: number): TwoWaySliderState {
    const deltaValue = this.pixelToValue(deltaPx) - this.min;
    const currentWidth = this.rangeEnd - this.rangeStart;

    let newStart = this.rangeStart + deltaValue;
    let newEnd = this.rangeEnd + deltaValue;

    if (newStart < this.min) {
      newStart = this.min;
      newEnd = this.min + currentWidth;
    } else if (newEnd > this.max) {
      newEnd = this.max;
      newStart = this.max - currentWidth;
    }

    return new TwoWaySliderState(
      this.min,
      this.max,
      this.minWidth,
      newStart,
      newEnd,
      this.widthPx,
      this.trackPaddingPx,
      this.snap,
    );
  }

  withWidthPx(widthPx: number): TwoWaySliderState {
    return new TwoWaySliderState(
      this.min,
      this.max,
      this.minWidth,
      this.rangeStart,
      this.rangeEnd,
      widthPx,
      this.trackPaddingPx,
      this.snap,
    );
  }

  withSnap(snap: number[]): TwoWaySliderState {
    return new TwoWaySliderState(
      this.min,
      this.max,
      this.minWidth,
      this.rangeStart,
      this.rangeEnd,
      this.widthPx,
      this.trackPaddingPx,
      snap,
    );
  }
}

const $defaultSliderStyles = css`
  :host {
    position: relative;
    display: block;
    min-width: 180px;
  }

  #track {
    position: relative;
    height: 20px;
    width: 100%;
    background: var(--std-slider-track-color);
    border-radius: 11px;
    overflow: hidden;
    border: 1px solid var(--divider);
    padding: 0 10px;
    box-sizing: border-box;
  }

  #selected-range {
    position: absolute;
    top: 0;
    height: 100%;
    background: var(--std-slider-progress-color);
    cursor: grab;
  }

  #selected-range:active {
    cursor: grabbing;
  }

  #left-handle {
    left: -9px;
  }

  #right-handle {
    right: -9px;
  }

  #label-row {
    position: relative;
    width: 100%;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 0.7125rem;
    padding-left: 4px;
    padding-right: 4px;
    color: var(--text-ter);
  }

  #range-labels {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    color: var(--text-sec);
  }

  /* Disable all transitions during initial render */
  :host(.no-transition) * {
    transition: none !important;
  }
`;

const $thickSliderStyles = css`
  :host {
    position: relative;
    --std-slider-selected-color: var(--black12);
    --std-slider-thumb-color: var(--black33);
    min-width: 200px;
    display: block;
  }

  #track {
    height: 48px;
    width: 100%;
    background: var(--bg-elevated);
    border-radius: 8px;
    padding: 1px;
    position: relative;
  }

  #selected-range {
    position: absolute;
    top: 1px;
    bottom: 1px;
    left: 0; /* Start at origin */
    min-width: 4px; /* Ensure minimum visual width */
    background-color: var(--std-slider-selected-color);
    border-radius: 8px;
    transition: background-color 0.3s ease;
    cursor: grab;
    z-index: 1;
    will-change: transform, width; /* Optimize for transform and width changes */
  }


  #selected-range:active {
    cursor: grabbing;
  }

  .thumb {
    width: 12px;
    height: calc(100% - 2px);
    cursor: ew-resize;
    position: absolute;
    top: 1px;
    left: 0; /* Start at origin, use transform for positioning */
    z-index: 2;
    will-change: transform; /* Optimize for transform changes */
    transition: transform 0.3s ease;
  }

  .thumb.dragging {
    transition: none; /* Disable transition while dragging */
  }

  /* Disable all transitions during initial render */
  :host(.no-transition) * {
    transition: none !important;
  }

  .thumb::after {
    position: absolute;
    content: "";
    top: 8px;
    bottom: 8px;
    left: 4px;
    width: 4px;
    border-radius: 2px;
    background: var(--std-slider-thumb-color);
  }

  #label-tooltip {
    pointer-events: none;
    position: absolute;
    left: 0;
    top: 0;
    padding: 4px 8px;
    background: var(--red);
    border-radius: 8px;
    transition: opacity 0.15s ease;
    opacity: 0;
  }

  #range-tooltip {
    color: white;
    font-size: var(--h6-size);
  }

  #label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    left: 16px;
  }

  #snap * {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 4px;
    height: 4px;
    background: var(--black12);
    border-radius: 2px;
    left: calc(var(--position) * 1px - 2px); /* Center the 4px circle */
    z-index: 0;
  }
`;

@component({
  name: "std-two-way-slider",
})
export class TwoWaySlider extends LonaWebComponent {
  onRangeChanged: Option<(start: number, end: number) => void>;

  private state = new TwoWaySliderState(0, 100, 10, 20, 60, 300);
  private resizeObserver: ResizeObserver;

  constructor() {
    super();

    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;

    this.setupLeftHandleDrag();
    this.setupRightHandleDrag();
    this.setupMiddleDrag();
    SliderUtils.wireKeyboard(this.$("left-handle"), this.$("right-handle"), () => this.state,
      state => this.render(state), () => this.emitRangeChanged(), () => this.hasAttribute("disabled"));

    this.resizeObserver = SliderUtils.createResizeObserver(
      DEFAULT_SLIDER_MIN_WIDTH,
      (newWidth) => this.render(this.state.withWidthPx(newWidth)),
      () => this.state.widthPx,
    );
  }

  private setupLeftHandleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $leftHandle = this.$("left-handle");
    
    GESTURE_MANAGER.addDragGesture(
      $leftHandle,
      "two-way-slider-left",
      {
        onPointerDown: () => {
          if (this.hasAttribute("disabled")) { baseState = null; return; }
          baseState = this.state;
          $leftHandle.classList.add("dragging");
        },
        onPointerMove: ({ progress }) => {
          if (baseState == null || this.hasAttribute("disabled")) return;
          const newPx = baseState!.layoutRange().startPx - progress.x;
          const newValue = baseState!.pixelToValue(newPx);
          this.render(baseState!.withRangeStart(newValue));
          this.emitRangeChanged();
        },
        onPointerUp: () => {
          $leftHandle.classList.remove("dragging");
        },
      },
    );
  }

  private setupRightHandleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $rightHandle = this.$("right-handle");
    
    GESTURE_MANAGER.addDragGesture(
      $rightHandle,
      "two-way-slider-right",
      {
        onPointerDown: () => {
          if (this.hasAttribute("disabled")) { baseState = null; return; }
          baseState = this.state;
          $rightHandle.classList.add("dragging");
        },
        onPointerMove: ({ progress }) => {
          if (baseState == null || this.hasAttribute("disabled")) return;
          const newPx = baseState!.layoutRange().endPx - progress.x;
          const newValue = baseState!.pixelToValue(newPx);
          this.render(baseState!.withRangeEnd(newValue));
          this.emitRangeChanged();
        },
        onPointerUp: () => {
          $rightHandle.classList.remove("dragging");
        },
      },
    );
  }

  private setupMiddleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $leftHandle = this.$("left-handle");
    const $rightHandle = this.$("right-handle");
    
    GESTURE_MANAGER.addDragGesture(
      this.$("selected-range"),
      "two-way-slider-middle",
      {
        onPointerDown: () => {
          if (this.hasAttribute("disabled")) { baseState = null; return; }
          baseState = this.state;
          // Disable transitions on both handles when dragging the range
          $leftHandle.classList.add("dragging");
          $rightHandle.classList.add("dragging");
        },
        onPointerMove: ({ progress }) => {
          if (baseState == null || this.hasAttribute("disabled")) return;
          this.render(baseState!.withRangeShift(-progress.x));
          this.emitRangeChanged();
        },
        onPointerUp: () => {
          // Re-enable transitions after drag completes
          $leftHandle.classList.remove("dragging");
          $rightHandle.classList.remove("dragging");
        },
      },
    );
  }

  connectedCallback() {
    super.connectedCallback();
    this.resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
  }

  bind(props: {
    min: number;
    max: number;
    minWidth: number;
    rangeStart: number;
    rangeEnd: number;
    startLabel?: Option<string>;
    endLabel?: Option<string>;
    disabled?: Option<boolean>;
    showTooltip?: boolean;
    onRangeChanged?: Option<(start: number, end: number) => void>;
  }) {
    const state = new TwoWaySliderState(
      props.min,
      props.max,
      props.minWidth,
      props.rangeStart,
      props.rangeEnd,
      this.state.widthPx,
    );
    this.onRangeChanged = props.onRangeChanged;
    this.toggleAttribute("disabled", props.disabled ?? false);
    this.$("left-handle").setAttribute("aria-label", props.startLabel ?? "Range start");
    this.$("right-handle").setAttribute("aria-label", props.endLabel ?? "Range end");
    this.render(state);
  }

  private render(state: TwoWaySliderState) {
    this.state = state;
    SliderUtils.updateSemantics(this.$("left-handle"), this.$("right-handle"), state, this.hasAttribute("disabled"));
    const layout = state.layoutRange();

    // Ensure minimum width when start=end for visibility
    const displayWidth = Math.max(
      layout.widthPx,
      REGULAR_SLIDER_MIN_DISPLAY_WIDTH,
    );
    const centerOffset =
      layout.widthPx === 0 ? -REGULAR_SLIDER_MIN_DISPLAY_WIDTH / 2 : 0;

    // Add trackPaddingPx - 1px to shift left for proper alignment
    this.$("selected-range").style.left =
      `${layout.startPx + state.trackPaddingPx - 1 + centerOffset}px`;
    this.$("selected-range").style.width = `${displayWidth}px`;

    // Thumbs are positioned relative to the selected-range container
    this.$("left-handle").style.left = "-9px";
    this.$("right-handle").style.right = "-9px";

    this.$("min-label").textContent = String(Math.round(state.min));
    this.$("max-label").textContent = String(Math.round(state.max));

    this.$("range-start-label").textContent = String(
      Math.round(state.rangeStart),
    );
    this.$("range-end-label").textContent = String(Math.round(state.rangeEnd));
  }

  emitRangeChanged() {
    this.onRangeChanged?.(this.state.rangeStart, this.state.rangeEnd);
  }

  static makeWith(props: {
    min: number;
    max: number;
    minWidth: number;
    rangeStart: number;
    rangeEnd: number;
    startLabel?: Option<string>;
    endLabel?: Option<string>;
    disabled?: Option<boolean>;
    showTooltip?: boolean;
    onRangeChanged?: Option<(start: number, end: number) => void>;
  }): TwoWaySlider {
    const slider = TwoWaySlider.make() as TwoWaySlider;
    slider.bind(props);
    return slider;
  }

  onRecycle(): void {
    this.onRangeChanged = null;
    super.onRecycle();
  }

  static $styles = [$sliderVariables, $sliderThumbStyles, $defaultSliderStyles, css`
    .thumb:focus-visible { outline: 2px solid var(--accent-color, #007aff); outline-offset: 3px; }
  `];

  static $html = html`
    <div id="track">
      <div id="selected-range">
        <div id="left-handle" class="thumb"></div>
        <div id="right-handle" class="thumb"></div>
      </div>
    </div>
    <std-row id="label-row">
      <div id="min-label">0</div>
      <std-row id="range-labels">
        <div id="range-start-label">20</div>
        <span>&nbsp;-&nbsp;</span>
        <div id="range-end-label">60</div>
      </std-row>
      <div id="max-label">100</div>
    </std-row>
  `;
}

@component({
  name: "std-thick-two-way-slider",
})
export class ThickTwoWaySlider extends LonaWebComponent {
  onRangeChanged: Option<(start: number, end: number) => void>;

  private state = new TwoWaySliderState(0, 100, 10, 20, 60, 200, 1);
  private config: {
    renderSnaps: boolean;
    renderSnapIndicators?: (
      value: number,
      index: number,
      allSnaps: number[],
    ) => boolean;
    showTooltip: boolean;
  } = {
    renderSnaps: true,
    showTooltip: true,
  };
  private labelTimeout: Option<number>;
  private init: boolean = true;
  private resizeObserver: ResizeObserver;
  private isInitialRender: boolean = true;

  constructor() {
    super();

    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;

    this.setupLeftHandleDrag();
    this.setupRightHandleDrag();
    this.setupMiddleDrag();
    SliderUtils.wireKeyboard(this.$("left-thumb"), this.$("right-thumb"), () => this.state,
      state => this.renderImmediate(state), () => this.emitRangeChanged(), () => this.hasAttribute("disabled"));

    this.resizeObserver = SliderUtils.createResizeObserver(
      THICK_SLIDER_MIN_WIDTH,
      (newWidth) => this.render(this.state.withWidthPx(newWidth)),
      () => this.state.widthPx,
    );
  }

  connectedCallback() {
    super.connectedCallback();
    this.init = true;
    this.classList.add("no-transition");
    this.resizeObserver.observe(this);

    $$.measure(() => this.render(this.state.withWidthPx(this.offsetWidth)));

    SliderUtils.setInitialWidth(
      this,
      THICK_SLIDER_MIN_WIDTH,
      (newWidth) => this.render(this.state.withWidthPx(newWidth)),
      () => this.state.widthPx,
    );

    if (this.isInitialRender) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.classList.remove("no-transition");
          this.isInitialRender = false;
        });
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    if (this.labelTimeout) {
      clearTimeout(this.labelTimeout);
      this.labelTimeout = null;
    }
  }

  private setupLeftHandleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $leftThumb = this.$("left-thumb");

    GESTURE_MANAGER.addDragGesture($leftThumb, "thick-two-way-slider-left", {
      onPointerDown: () => {
        if (this.hasAttribute("disabled")) { baseState = null; return; }
        baseState = this.state;
        $leftThumb.classList.add("dragging");
      },
      onPointerMove: ({ progress }) => {
        if (baseState == null || this.hasAttribute("disabled")) return;
        const baseLayout = baseState!.layoutRange();
        const newPx = baseLayout.startPx - progress.x;
        const newValue = baseState!.pixelToValue(newPx);

        this.renderImmediate(baseState!.withRangeStart(newValue));
        this.emitRangeChanged();
      },
      onPointerUp: () => {
        $leftThumb.classList.remove("dragging");
        this.render(this.state);
      },
    });
  }

  private setupRightHandleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $rightThumb = this.$("right-thumb");

    GESTURE_MANAGER.addDragGesture($rightThumb, "thick-two-way-slider-right", {
      onPointerDown: () => {
        if (this.hasAttribute("disabled")) { baseState = null; return; }
        baseState = this.state;
        $rightThumb.classList.add("dragging");
      },
      onPointerMove: ({ progress }) => {
        if (baseState == null || this.hasAttribute("disabled")) return;
        const baseLayout = baseState!.layoutRange();
        const newPx = baseLayout.endPx - progress.x;
        const newValue = baseState!.pixelToValue(newPx);

        this.renderImmediate(baseState!.withRangeEnd(newValue));
        this.emitRangeChanged();
      },
      onPointerUp: () => {
        $rightThumb.classList.remove("dragging");
        this.render(this.state);
      },
    });
  }

  private setupMiddleDrag() {
    let baseState: Option<TwoWaySliderState>;
    const $leftThumb = this.$("left-thumb");
    const $rightThumb = this.$("right-thumb");
    
    GESTURE_MANAGER.addDragGesture(
      this.$("selected-range"),
      "thick-two-way-slider-middle",
      {
        onPointerDown: () => {
          if (this.hasAttribute("disabled")) { baseState = null; return; }
          baseState = this.state;
          // Disable transitions on both thumbs when dragging the range
          $leftThumb.classList.add("dragging");
          $rightThumb.classList.add("dragging");
        },
        onPointerMove: ({ progress }) => {
          if (baseState == null || this.hasAttribute("disabled")) return;
          this.renderImmediate(baseState!.withRangeShift(-progress.x));
          this.emitRangeChanged();
        },
        onPointerUp: () => {
          // Re-enable transitions after drag completes
          $leftThumb.classList.remove("dragging");
          $rightThumb.classList.remove("dragging");
          this.render(this.state);
        },
      },
    );
  }

  bind(props: {
    min: number;
    max: number;
    minWidth: number;
    rangeStart: number;
    rangeEnd: number;
    startLabel?: Option<string>;
    endLabel?: Option<string>;
    disabled?: Option<boolean>;
    snap?: Option<number[]>;
    renderSnaps?: Option<boolean>;
    renderSnapIndicators?: Option<
      (value: number, index: number, allSnaps: number[]) => boolean
    >;
    showTooltip?: Option<boolean>;
    onRangeChanged?: Option<(start: number, end: number) => void>;
  }) {
    let state = new TwoWaySliderState(
      props.min,
      props.max,
      props.minWidth,
      props.rangeStart,
      props.rangeEnd,
      this.state.widthPx,
      1,
    );
    if (props.snap) {
      state = state.withSnap(props.snap);
    }

    // Always set all config properties to avoid stateful behavior
    this.config.renderSnaps = props.renderSnaps ?? true;
    this.config.renderSnapIndicators = props.renderSnapIndicators ?? undefined;
    this.config.showTooltip = props.showTooltip ?? true;
    this.onRangeChanged = props.onRangeChanged;
    this.toggleAttribute("disabled", props.disabled ?? false);
    this.$("left-thumb").setAttribute("aria-label", props.startLabel ?? "Range start");
    this.$("right-thumb").setAttribute("aria-label", props.endLabel ?? "Range end");
    this.render(state);
  }

  private render(state: TwoWaySliderState) {
    this.renderInternal(state, true);
  }

  private renderImmediate(state: TwoWaySliderState) {
    this.renderInternal(state, false);
  }

  private renderInternal(state: TwoWaySliderState, animated: boolean) {
    this.state = state;

    const isInit = this.init;
    const snappedStart = state.findClosestSnap(state.rangeStart);
    const snappedEnd = state.findClosestSnap(state.rangeEnd);
    const snappedState = new TwoWaySliderState(
      state.min,
      state.max,
      state.minWidth,
      snappedStart,
      snappedEnd,
      state.widthPx,
      state.trackPaddingPx,
      state.snap,
    );

    this.state = snappedState;
    SliderUtils.updateSemantics(this.$("left-thumb"), this.$("right-thumb"), snappedState, this.hasAttribute("disabled"));
    const layout = snappedState.layoutRange();
    const rangeWidth = layout.widthPx;

    const isNarrow = rangeWidth < MIN_THUMB_SPACING;

    // When range width is 0 (start=end), center the min-width range on the snap point
    const rangeCenterOffset =
      rangeWidth === 0 ? -THICK_SLIDER_MIN_DISPLAY_WIDTH / 2 : 0;

    const leftThumbPos = isNarrow ? layout.startPx - 11 : layout.startPx - 5;
    const rightThumbPos = isNarrow ? layout.endPx + 1 : layout.endPx - 5;

    if (!animated) {
      this.$("selected-range").style.transform =
        `translateX(${layout.startPx + state.trackPaddingPx + rangeCenterOffset}px)`;
      this.$("selected-range").style.width = `${rangeWidth}px`;

      const $leftThumb = this.$("left-thumb");
      const $rightThumb = this.$("right-thumb");

      $leftThumb.style.transform = `translateX(${leftThumbPos}px)`;
      $rightThumb.style.transform = `translateX(${rightThumbPos}px)`;
    } else {
      $$.mutate(() => {
        this.$("selected-range").style.transform =
          `translateX(${layout.startPx + state.trackPaddingPx + rangeCenterOffset}px)`;
        this.$("selected-range").style.width = `${rangeWidth}px`;

        const $leftThumb = this.$("left-thumb");
        const $rightThumb = this.$("right-thumb");

        $leftThumb.style.transform = `translateX(${leftThumbPos}px)`;
        $rightThumb.style.transform = `translateX(${rightThumbPos}px)`;
      });
    }

    if (this.config.showTooltip) {
      this.$("range-tooltip").textContent =
        `${Math.round(snappedStart)} - ${Math.round(snappedEnd)}`;

      this.labelTimeout && clearTimeout(this.labelTimeout);
      this.labelTimeout = setTimeout(() => {
        this.$("label-tooltip").style.opacity = "0";
        this.labelTimeout = null;
      }, TOOLTIP_TIMEOUT_MS);

      !isInit && (this.$("label-tooltip").style.opacity = "1");
      this.init = false;

      const labelWidthPx =
        this.$("label-tooltip").getBoundingClientRect().width;
      this.$("label-tooltip").style.transform =
        `translate(calc(${MathUtils.clampInc(
          layout.startPx + rangeWidth / 2 - labelWidthPx / 2 + 1,
          0,
          state.widthPx - labelWidthPx,
        )}px), calc(-100% - 4px))`;
    } else {
      this.$("label-tooltip").style.opacity = "0";
    }

    if (state.snap && this.config.renderSnaps) {
      DomUtils.clearChildren(this.$("snap"));
      state.snap.forEach((notch, index, allSnaps) => {
        if (notch === state.min || notch === state.max) return;

        if (this.config.renderSnapIndicators) {
          if (!this.config.renderSnapIndicators(notch, index, allSnaps)) {
            return;
          }
        }

        const notchPx = snappedState.valueToPixel(notch) + 1;
        const $notch = document.createElement("div");
        $notch.style.setProperty("--position", String(notchPx));
        this.$("snap").appendChild($notch);
      });
    }

    this.init = false;
  }

  static makeWith(props: {
    min: number;
    max: number;
    minWidth: number;
    rangeStart: number;
    rangeEnd: number;
    startLabel?: Option<string>;
    endLabel?: Option<string>;
    disabled?: Option<boolean>;
    snap?: Option<number[]>;
    renderSnaps?: Option<boolean>;
    renderSnapIndicators?: Option<
      (value: number, index: number, allSnaps: number[]) => boolean
    >;
    showTooltip?: Option<boolean>;
    onRangeChanged?: Option<(start: number, end: number) => void>;
  }): ThickTwoWaySlider {
    const slider = ThickTwoWaySlider.make() as ThickTwoWaySlider;
    slider.bind(props);
    return slider;
  }

  emitRangeChanged() {
    this.onRangeChanged?.(this.state.rangeStart, this.state.rangeEnd);
  }

  onRecycle(): void {
    if (this.labelTimeout != null) clearTimeout(this.labelTimeout);
    this.labelTimeout = null;
    this.onRangeChanged = null;
    super.onRecycle();
  }

  static $styles = [Typography.$style, $thickSliderStyles, css`
    .thumb:focus-visible { outline: 2px solid var(--accent-color, #007aff); outline-offset: 3px; }
  `];

  static $html = html`
    <std-col id="label-tooltip">
      <p id="range-tooltip"></p>
    </std-col>
    <std-col id="track">
      <div id="selected-range"></div>
      <div id="snap"></div>
      <div id="left-thumb" class="thumb"></div>
      <div id="right-thumb" class="thumb"></div>
      <div id="label">
        <slot></slot>
      </div>
    </std-col>
  `;
}

export namespace TwoWaySlider {
  export type Default = TwoWaySlider;
  export const Default = TwoWaySlider;

  export type Thick = ThickTwoWaySlider;
  export const Thick = ThickTwoWaySlider;
}
