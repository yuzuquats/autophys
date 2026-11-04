import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { DomEventUtils } from "../../dom-event-utils";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { MathUtils } from "@tento-core/math";
import { NumRangeLike } from "@tento-core/range";
import { $jsx } from "../../ui/jsx";

@component({
  name: "std-apple-slider",
})
export class DefaultSlider extends LonaWebComponent {
  onProgressChanged: (progress: number) => void = Constants.EMPTY_FUNCTION;

  private state = new Slider.State(Slider.DEFAULT_BOUNDS, 0, 140, 10);
  private sliderAriaLabel: string = "Slider";

  get value(): number {
    return this.state.value;
  }

  ro = new ResizeObserver(([_]) => {
    this.render(this.state.withWidthPx(this.$("track").offsetWidth));
  });

  private handleKeydown = (e: KeyboardEvent) => {
    const step = (this.state.range.end - this.state.range.start) / 10;

    let newValue = this.state.value;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        newValue = Math.min(this.state.range.end, this.state.value + step);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        newValue = Math.max(this.state.range.start, this.state.value - step);
        break;
      case "Home":
        e.preventDefault();
        newValue = this.state.range.start;
        break;
      case "End":
        e.preventDefault();
        newValue = this.state.range.end;
        break;
      default:
        return;
    }
    this.render(this.state.withValue(newValue));
    this.onProgressChanged?.(this.value);
  };

  constructor() {
    super();

    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;

    {
      let baseValue: Option<Slider.State>;
      GESTURE_MANAGER.addDragGesture(this.$("thumb"), "slider", {
        onPointerDown: () => {
          baseValue = this.state;
        },
        onPointerMove: ({ progress }) => {
          this.render(
            baseValue!.withProgressPx(
              baseValue!.layout().progressPx - progress.x,
            ),
          );
          this.onProgressChanged?.(this.value);
        },
      });
    }

    this.$("track").onpointerup = (e) => {
      this.render(this.state.withProgressPx(e.offsetX - 9));
      this.onProgressChanged?.(this.value);
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this.ro.observe(this);

    // ARIA slider setup
    const $thumb = this.$("thumb");
    $thumb.setAttribute("role", "slider");
    $thumb.setAttribute("tabindex", "0");
    $thumb.setAttribute("aria-label", this.sliderAriaLabel);
    this.updateAriaValues();
    $thumb.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro.unobserve(this);
    this.$("thumb").removeEventListener("keydown", this.handleKeydown);
  }

  private updateAriaValues(): void {
    const $thumb = this.$("thumb");
    $thumb.setAttribute("aria-valuemin", String(this.state.range.start));
    $thumb.setAttribute("aria-valuemax", String(this.state.range.end));
    $thumb.setAttribute("aria-valuenow", String(this.value));
  }

  private render(state: Slider.State) {
    this.state = state;
    this.updateAriaValues();
    const vm = state.layoutValue(state.findClosestSnap(state.value));

    this.$("range-low").textContent = String(
      Math.round(this.state.range.start),
    );
    this.$("range-high").textContent = String(Math.round(this.state.range.end));
    this.$("thumb").style.transform = `translateX(${vm.progressPx}px)`;
    this.$("progress").style.setProperty(
      "--current-progress",
      vm.progressPx + "px",
    );
    this.$("label").style.display = "block";
    this.$("label").textContent = Math.round(this.state.value) + "px";
    const labelWidthPx = this.$("label").getBoundingClientRect().width;
    this.$("label").style.transform = `translateX(calc(${
      vm.progressPx + 11 - labelWidthPx / 2
    }px))`;
  }

  setBounds(bounds: NumRangeLike, value: number): this {
    this.render(this.state.withValue(value).withRange(bounds));
    return this;
  }

  addOnChange(onProgressChanged: (progress: number) => void): this {
    this.onProgressChanged = onProgressChanged;
    return this;
  }

  static $styles = [
    css`
      :host {
        --std-slider-track-color: var(--bg-hover, rgba(0, 0, 0, 0.03));
        --std-slider-progress-color: var(--background-color, white);
        --std-slider-thumb-color: var(--background-color, white);
        --std-slider-thumb-border-color: var(
          --divider,
          rgba(0, 0, 0, 0.12)
        );

        position: relative;
      }

      #track {
        position: relative;
        height: 20px;
        width: 100%;
        background: var(--std-slider-track-color);
        border-radius: 11px;
        overflow: hidden;
        border: 1px solid var(--divider);
      }

      #progress {
        position: absolute;
        top: 0px;
        left: 0px;
        height: 100%;
        width: 100%;
        background: var(--std-slider-progress-color);
        transform: translateX(calc(var(--current-progress, 0px) - 100% + 10px));
        pointer-events: none;
      }

      #thumb {
        position: relative;
        height: 18px;
        width: 18px;
        margin: 0px;
        margin-top: -1px;
        margin-left: -1px;
        border-radius: 10px;
        background: var(--std-slider-thumb-color);
        z-index: 999;
        cursor: pointer;
      }

      #thumb::before {
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

      #thumb::after {
        position: absolute;
        content: "";
        top: 1px;
        left: 1px;
        height: 20px;
        width: 20px;
        border-radius: 9px;
        pointer-events: none;
        opacity: 0.8;
      }

      #thumb:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #label {
        position: absolute;
        left: 0px;
        top: -2px;
        z-index: 1;
        font-size: 0.7125rem;
        color: var(--text-sec);
        background: var(--bg);
        border-radius: 2px;
        padding: 2px 6px;
        display: none;
      }

      #label-row {
        position: relative;
        width: 100%;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 0.7125rem;
        padding-left: 4px;
        padding-left: 4px;
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="track">
      <div id="progress"></div>
      <div id="thumb"></div>
    </std-row>
    <std-row id="label-row">
      <div id="range-low">0</div>
      <div id="range-high">100</div>
      <div id="label"></div>
    </std-row>
  `;
}

@component({
  name: "std-thick-slider",
})
export class ThickSlider extends LonaWebComponent {
  onProgressChanged: (progress: number) => void = Constants.EMPTY_FUNCTION;

  private state = new Slider.State(Slider.DEFAULT_BOUNDS, 0, 200, 4);
  private config: {
    renderSnaps: boolean;
    renderLastSnap: boolean;
  } = {
    renderSnaps: true,
    renderLastSnap: false,
  };
  private labelTimeout: Option<number>;
  private init: boolean = true;
  private sliderAriaLabel: string = "Slider";

  get value(): number {
    return this.state.findClosestSnap(this.state.value);
  }

  private ro = new ResizeObserver(([_]) => {
    this.render(this.state.withWidthPx(this.$("track").offsetWidth));
  });

  private handleKeydown = (e: KeyboardEvent) => {
    const step = this.state.snap?.[1]
      ? this.state.snap[1] - this.state.snap[0]
      : (this.state.range.end - this.state.range.start) / 10;

    let newValue = this.state.value;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        newValue = Math.min(this.state.range.end, this.state.value + step);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        newValue = Math.max(this.state.range.start, this.state.value - step);
        break;
      case "Home":
        e.preventDefault();
        newValue = this.state.range.start;
        break;
      case "End":
        e.preventDefault();
        newValue = this.state.range.end;
        break;
      default:
        return;
    }
    this.render(this.state.withValue(newValue));
    this.onProgressChanged?.(this.value);
  };

  constructor() {
    super();

    $$.measure(() =>
      this.render(this.state.withWidthPx(this.$("track").offsetWidth)),
    );

    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;

    {
      let baseValue: Option<Slider.State>;
      GESTURE_MANAGER.addDragGesture(this.$("thumb"), "slider", {
        onPointerDown: () => {
          baseValue = this.state;
        },
        onPointerMove: ({ progress }) =>
          this.render(
            baseValue!.withProgressPx(
              baseValue!.layout().progressPx - progress.x,
            ),
          ),
      });
    }

    this.$("track").onpointerup = (e) =>
      this.render(this.state.withProgressPx(e.offsetX + 6));
  }

  connectedCallback() {
    super.connectedCallback();
    this.init = true;
    this.ro.observe(this.$("track"));

    // ARIA slider setup
    const $thumb = this.$("thumb");
    $thumb.setAttribute("role", "slider");
    $thumb.setAttribute("tabindex", "0");
    $thumb.setAttribute("aria-label", this.sliderAriaLabel);
    this.updateAriaValues();
    $thumb.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro.disconnect();
    this.$("thumb").removeEventListener("keydown", this.handleKeydown);
    if (this.labelTimeout) {
      clearTimeout(this.labelTimeout);
      this.labelTimeout = null;
    }
  }

  private updateAriaValues(): void {
    const $thumb = this.$("thumb");
    $thumb.setAttribute("aria-valuemin", String(this.state.range.start));
    $thumb.setAttribute("aria-valuemax", String(this.state.range.end));
    $thumb.setAttribute("aria-valuenow", String(this.value));
  }

  bind(props: {
    bounds: NumRangeLike;
    value: number;
    snap?: Option<number[]>;
    renderSnaps?: Option<boolean>;
    renderLastSnap?: Option<boolean>;
    ariaLabel?: Option<string>;
  }) {
    let state = this.state.withValue(props.value).withRange(props.bounds);
    if (props.snap) {
      state = state.withSnap(props.snap);
    }
    if (props.renderSnaps != null) this.config.renderSnaps = props.renderSnaps;
    if (props.renderLastSnap != null) {
      this.config.renderLastSnap = props.renderLastSnap;
    }
    if (props.ariaLabel != null) {
      this.sliderAriaLabel = props.ariaLabel;
      this.$("thumb").setAttribute("aria-label", this.sliderAriaLabel);
    }
    this.render(state);
  }

  setBounds(bounds: NumRangeLike, value: number) {
    this.render(this.state.withValue(value).withRange(bounds));
  }

  setSnap(snap: number[]) {
    this.render(this.state.withSnap(snap));
  }

  private render(state: Slider.State) {
    this.state = state;
    this.updateAriaValues();
    const snappedValue = state.findClosestSnap(state.value);
    const vm = state.layoutValue(snappedValue);
    this.$("progress").assignStyles({
      "--current-progress": vm.progressPx + 6 + "px",
      backgroundColor: vm.progressPx === 0 ? "transparent" : "",
      transition:
        state.snap != null && state.snap.length > 0
          ? "width 0.1s ease, background-color 0.3s ease"
          : "background-color 0.3s ease",
    });

    this.$("progress-label-tooltip").textContent =
      Math.round(snappedValue) + "";
    this.labelTimeout && clearTimeout(this.labelTimeout);
    this.labelTimeout = setTimeout(() => {
      this.$("label-tooltip").style.opacity = "0";
      this.labelTimeout = null;
    }, 2_000);

    !this.init && (this.$("label-tooltip").style.opacity = "1");
    this.init = false;
    const labelWidthPx = this.$("label-tooltip").getBoundingClientRect().width;
    this.$("label-tooltip").style.transform =
      `translate(calc(${MathUtils.clampInc(
        vm.progressPx + 5 - labelWidthPx / 2,
        0,
        state.widthPx - 2 - labelWidthPx,
      )}px), calc(-100% - 4px))`;

    if (this.state.snap && (this.config?.renderSnaps ?? true)) {
      DomUtils.clearChildren(this.$("snap"));
      for (const notch of this.state.snap) {
        if (notch === this.state.range.start) {
          continue;
        }
        if (!this.config?.renderLastSnap && notch === this.state.range.end) {
          continue;
        }
        this.$("snap").appendChild(
          $jsx("div", {
            style: {
              "--position": String(this.state.layoutValue(notch).progressPx),
            },
          }),
        );
      }
    }
  }

  static $styles = [
    css`
      :host {
        position: relative;
      }

      #track {
        height: var(--slider-track-height, 48px);
        width: 100%;
        background: var(--slider-track-bg, white);
        border-radius: 8px;
        padding: 1px;
      }

      #progress {
        position: relative;
        width: calc(var(--current-progress));
        min-width: 12px;
        height: 100%;
        background-color: var(--slider-progress-bg, var(--black12));
        border-radius: 8px;
        transition: background-color 0.3s ease;
      }

      #thumb {
        width: 12px;
        height: 100%;
        cursor: ew-resize;
        position: absolute;
        right: 0px;
      }

      #thumb::after {
        position: absolute;
        content: "";
        top: 8px;
        bottom: 8px;
        right: 4px;
        width: 4px;
        border-radius: 2px;
        background: var(--black33);
      }

      #thumb:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
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
      }

      #progress-label-tooltip {
        color: var(--fg-tooltip);
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
        left: calc(var(--position) * 1px + -1px);
      }
    `,
  ];

  static $html = html`
    <std-col id="label-tooltip" style="opacity:0;">
      <p id="progress-label-tooltip"></p>
    </std-col>
    <std-col id="track">
      <div id="progress">
        <div id="thumb"></div>
      </div>
      <div id="snap"></div>
      <div id="label">
        <slot></slot>
      </div>
    </std-col>
  `;
}

export namespace Slider {
  export type Default = DefaultSlider;
  export const Default = DefaultSlider;

  export type Thick = ThickSlider;
  export const Thick = ThickSlider;

  export type ViewModel = {
    progressPx: number;
    progressPct: number;
  };

  export const DEFAULT_BOUNDS: NumRangeLike = { start: 0, end: 300 };

  export class State {
    readonly range: NumRangeLike;
    readonly value: number;
    readonly inlinePaddingPx: number;
    readonly widthPx: number;
    readonly snap: Option<number[]>;

    constructor(
      range: NumRangeLike,
      value: number,
      widthPx: number,
      inlinePaddingPx: number,
      snap: Option<number[]> = null,
    ) {
      this.range = range;
      this.value = value;
      this.widthPx = widthPx;
      this.inlinePaddingPx = inlinePaddingPx;
      this.snap = snap;
    }

    findClosestSnap(value: number): number {
      if (this.snap == null || this.snap.length === 0) return value;

      let snap = this.snap[0];
      let delta = Number.MAX_SAFE_INTEGER;
      for (const notch of this.snap) {
        const candDelta = Math.abs(notch - value);
        if (candDelta > delta) continue;

        snap = notch;
        delta = candDelta;
      }

      return snap;
    }

    layoutValue(value: number): ViewModel {
      const effectiveWidthPx = this.widthPx - this.inlinePaddingPx * 2;
      const rangeWidth = this.range.end - this.range.start;
      const progressPct = (value - this.range.start) / rangeWidth;
      const progressPx = progressPct * effectiveWidthPx;

      return {
        progressPct,
        progressPx,
      };
    }

    layout(): ViewModel {
      return this.layoutValue(this.value);
    }

    withValue(value: number): State {
      return new State(
        this.range,
        value,
        this.widthPx,
        this.inlinePaddingPx,
        this.snap,
      );
    }

    withRange(range: NumRangeLike): State {
      return new State(
        range,
        this.value,
        this.widthPx,
        this.inlinePaddingPx,
        this.snap,
      );
    }

    withWidthPx(widthPx: number): State {
      return new State(
        this.range,
        this.value,
        widthPx,
        this.inlinePaddingPx,
        this.snap,
      );
    }

    withSnap(snap: number[]): State {
      return new State(
        this.range,
        this.value,
        this.widthPx,
        this.inlinePaddingPx,
        snap,
      );
    }

    withProgressPx(progressPx: number): State {
      const effectiveWidthPx = this.widthPx - this.inlinePaddingPx * 2;
      const widthPct = progressPx / effectiveWidthPx;
      const value = MathUtils.clampInc(
        MathUtils.lerp(this.range.start, this.range.end, widthPct),
        this.range.start,
        this.range.end,
      );
      return new State(
        this.range,
        value,
        this.widthPx,
        this.inlinePaddingPx,
        this.snap,
      );
    }
  }
}
