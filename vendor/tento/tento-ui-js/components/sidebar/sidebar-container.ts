import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { CSSLength } from "../../css-length";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Tracing } from "@tento-core/tracing";
import { Scrollbars } from "../scrollbars";
import { SidebarContainerState } from "./sidebar-container-state";

export { SidebarContainerState };

@component({
  name: "std-sidebar-container",
})
export class SidebarContainer extends LonaWebComponent {
  /** Begin and end at rest; content FLIP shares the visible panel's easing. */
  static readonly layoutEasing = "ease-in-out";

  private onSidebarDragStart: EmptyFunction = Constants.EMPTY_FUNCTION;
  private onSidebarDragMove: (
    initialSidebarWidthPx: number,
    additionalSizePx: number,
  ) => void = Constants.EMPTY_FUNCTION;
  private onSidebarDragEnd: EmptyFunction = Constants.EMPTY_FUNCTION;
  private onRequestModalClose: EmptyFunction = Constants.EMPTY_FUNCTION;
  private onResizePreview: (width: CSSLength) => void = (_width) => {};
  private onResizeCommit: (width: CSSLength) => void = (_width) => {};
  private onVisibleSidebarWidthChange: (
    snapshot: SidebarContainerState.ResolvedSnapshot,
  ) => void = (_snapshot) => {};

  private sidebarHoverTargetActive: boolean = false;
  private sidebarContainerHovered: boolean = false;
  private dragging: boolean = false;
  private initializingAnimation = false;
  private widthAnimationFrame: Option<number>;
  private widthAnimationClock: Option<Animation>;
  private widthAnimationGeneration = 0;
  private widthProgress: Option<number>;
  private widthFrameListeners = new Set<(progress: Option<number>) => void>();

  /** Draw with the shell's eased progress; null releases an ended/cancelled resize. */
  observeWidthAnimation(listener: (progress: Option<number>) => void): EmptyFunction {
    this.widthFrameListeners.add(listener);
    return () => { this.widthFrameListeners.delete(listener); };
  }

  /** Linear frame progress for content animations sharing the visible resize. */
  get widthAnimationProgress(): Option<number> {
    return this.widthProgress;
  }
  private mainAnimationTarget: Option<string>;
  private restoreMainTransition: Option<EmptyFunction>;
  private focusedSet: Set<string> = new Set();
  private viewModel: SidebarContainer.ViewModel =
    SidebarContainer.defaultViewModel();
  private resolvedSnapshot: Option<SidebarContainerState.ResolvedSnapshot> =
    null;

  private static defaultViewModel(): SidebarContainer.ViewModel {
    return SidebarContainerState.peek({
      width: CSSLength.fromPx(300),
      animate: true,
      resizeEnabled: true,
    });
  }

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$("modal-backdrop"), {
      onClick: () => {
        if (!this.resolvedSnapshot?.dismissOnBackdrop) return;
        this.onRequestModalClose();
      },
    });
    this.$("sidebar-hover-target-strip").onpointerenter = () => {
      this.setHoverState(true, false);
    };
    this.$("sidebar-hover-target-strip").onpointerleave = (event) => {
      if (this.isSidebarContainerTarget(event.relatedTarget)) return;
      this.setHoverState(false, false);
    };
    this.$("sidebar-container").onpointerenter = () => {
      this.setHoverState(false, true);
    };
    this.$("sidebar-container").onpointerleave = (event) => {
      if (this.isSidebarHoverStripTarget(event.relatedTarget)) return;
      this.setHoverState(false, false);
    };
    let initialSidebarWidthPx: Option<number>;
    GESTURE_MANAGER.addDragGesture(
      this.$("sidebar-resize-indicator"),
      "sidebar-drag",
      {
        onPointerDown: () => {
          initialSidebarWidthPx = this.sidebarWidth.resolveToPx();
          this.toggleAttribute("resizing", true);
          this.dragging = true;
          this.updateSidebarState();
          this.onSidebarDragStart();
        },
        onPointerMove: ({ progress }) => {
          const additionalSizePx = -progress.x;
          const nextWidth = CSSLength.fromPx(
            Math.max(0, initialSidebarWidthPx! + additionalSizePx),
          );
          this.onResizePreview(nextWidth);
          this.onSidebarDragMove(initialSidebarWidthPx!, additionalSizePx);
        },
        onPointerUp: ({ progress }) => {
          const additionalSizePx = -progress.x;
          const nextWidth = CSSLength.fromPx(
            Math.max(0, initialSidebarWidthPx! + additionalSizePx),
          );
          this.onResizeCommit(nextWidth);
          this.onSidebarDragMove(initialSidebarWidthPx!, additionalSizePx);
          this.onSidebarDragEnd();
          this.toggleAttribute("resizing", false);
          this.dragging = false;
          this.updateSidebarState();
          initialSidebarWidthPx = null;
        },
      },
    );
  }

  connectedCallback() {
    this.initializingAnimation = true;
    this.toggleAnimate(false);
    // Read initial width pre-seeded before upgrade, if present.
    const initialWidth = this.dataset.initialWidth;
    if (initialWidth != null) {
      this.viewModel = {
        ...this.viewModel,
        width: CSSLength.fromPx(Number.parseFloat(initialWidth)),
      };
      delete this.dataset.initialWidth;
    }
    Tracing.log("sidebar/connect", {
      preSeededWidth: initialWidth ?? null,
      presentation: this.viewModel.presentation,
      t: performance.now(),
    });
    window.addEventListener("keydown", this.handleWindowKeyDown);
    this.rebindSidebarState();
    $$.defer(() => {
      if (!this.isConnected) return;
      this.initializingAnimation = false;
      this.rebindSidebarState();
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.initializingAnimation = false;
    this.cancelWidthAnimations();
    window.removeEventListener("keydown", this.handleWindowKeyDown);
  }

  onRecycle(): void {
    super.onRecycle();
    this.cancelWidthAnimations();
  }

  private cancelWidthAnimations(): void {
    this.widthAnimationGeneration += 1;
    if (this.widthAnimationFrame != null) cancelAnimationFrame(this.widthAnimationFrame);
    this.widthAnimationFrame = null;
    // Setting currentTime keeps even an unattached timing effect alive on the
    // document timeline. Release it on completion, reversal, and disconnect.
    this.widthAnimationClock?.cancel();
    this.widthAnimationClock = null;
    this.widthProgress = null;
    this.mainAnimationTarget = null;
    this.restoreMainTransition?.();
    this.restoreMainTransition = null;
    const listeners = [...this.widthFrameListeners];
    this.widthFrameListeners.clear();
    for (const listener of listeners) listener(null);
  }

  bind(props: SidebarContainer.Props): this {
    this.viewModel = props.viewModel;
    if (props.delegate != null) {
      this.onSidebarDragStart =
        props.delegate.onSidebarDragStart ?? Constants.EMPTY_FUNCTION;
      this.onSidebarDragMove =
        props.delegate.onSidebarDragMove ?? Constants.EMPTY_FUNCTION;
      this.onSidebarDragEnd =
        props.delegate.onSidebarDragEnd ?? Constants.EMPTY_FUNCTION;
      this.onRequestModalClose =
        props.delegate.onRequestModalClose ?? Constants.EMPTY_FUNCTION;
      this.onResizePreview = props.delegate.onResizePreview ?? ((_width) => {});
      this.onResizeCommit = props.delegate.onResizeCommit ?? ((_width) => {});
      this.onVisibleSidebarWidthChange =
        props.delegate.onVisibleSidebarWidthChange ?? ((_snapshot) => {});
    }

    this.rebindSidebarState();
    return this;
  }

  private updateSidebarState() {
    this.rebindSidebarState();
  }

  private setHoverState(
    sidebarHoverTargetActive: boolean,
    sidebarContainerHovered: boolean,
  ) {
    if (
      this.sidebarHoverTargetActive === sidebarHoverTargetActive &&
      this.sidebarContainerHovered === sidebarContainerHovered
    ) {
      return;
    }
    this.sidebarHoverTargetActive = sidebarHoverTargetActive;
    this.sidebarContainerHovered = sidebarContainerHovered;
    this.updateSidebarState();
  }

  private isSidebarHoverStripTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Node &&
      this.$("sidebar-hover-target-strip").contains(target)
    );
  }

  private isSidebarContainerTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Node && this.$("sidebar-container").contains(target)
    );
  }

  toggleFocused(id: string, force?: boolean) {
    const wasFocused = this.focusedSet.has(id);
    const focus = force == null ? !wasFocused : force;
    if (focus) {
      this.focusedSet.add(id);
    } else {
      this.focusedSet.delete(id);
    }
    this.rebindSidebarState();
  }

  toggleAnimate(force: boolean): boolean {
    return this.toggleAttribute("no-transition", !force);
  }

  toggleWidthAnimate(force: boolean): boolean {
    return this.toggleAttribute("no-width-transition", !force);
  }

  toggleTransformAnimate(force: boolean): boolean {
    return this.toggleAttribute("no-transform-transition", !force);
  }

  get sidebarWidth(): CSSLength {
    return this.viewModel.width;
  }
  set sidebarWidth(widthWithUnit: CSSLength) {
    this.viewModel = {
      ...this.viewModel,
      width: widthWithUnit,
    };
    this.rebindSidebarState();
  }
  setSidebarWidth(widthWithUnit: CSSLength, rebind: boolean) {
    this.viewModel = {
      ...this.viewModel,
      width: widthWithUnit,
    };
    rebind && this.rebindSidebarState();
  }

  get visibleSidebarWidth(): CSSLength {
    return CSSLength.fromPx(
      SidebarContainer.visibleSidebarWidthPx(this.resolvedSnapshot),
    );
  }

  get extraStickyMargin(): CSSLength {
    const esm = CSSLength.fromString(
      this.style.getPropertyValue("--extra-sticky-margin"),
    );
    if (esm.isOk()) return esm.expect();
    return CSSLength.fromPx(0);
  }

  private rebindSidebarState() {
    const viewModel = {
      ...this.viewModel,
      // no-transition is rendered output. Feeding it back into the next state
      // latches animation off after any non-animated bind.
      animate: this.viewModel.animate && !this.initializingAnimation,
    };
    const next = SidebarContainerState.normalize({
      viewModel,
      transientState: this.currentTransientState(),
      referenceWidthPx: window.innerWidth,
    });
    const prevVisibleSidebarWidthPx = SidebarContainer.visibleSidebarWidthPx(
      this.resolvedSnapshot,
    );
    const nextVisibleSidebarWidthPx = SidebarContainer.visibleSidebarWidthPx(
      next,
    );
    const prevStickied = this.resolvedSnapshot?.stickied ?? false;
    const nextStickied = next.stickied;
    const ops = SidebarContainerState.diffSnapshots(this.resolvedSnapshot, next);
    if (ops.length === 0) return;

    Tracing.log("sidebar/rebind", {
      presentation: next.presentation,
      active: next.active,
      stickied: next.stickied,
      width: next.widthCss,
      t: performance.now(),
    });

    this.applyDiffOps(ops, next);
    this.resolvedSnapshot = next;
    if (
      prevVisibleSidebarWidthPx !== nextVisibleSidebarWidthPx ||
      prevStickied !== nextStickied
    ) {
      this.onVisibleSidebarWidthChange(next);
    }
  }

  private static visibleSidebarWidthPx(
    snapshot: Option<SidebarContainerState.ResolvedSnapshot>,
  ): number {
    if (!snapshot?.active) return 0;
    return snapshot.widthPx;
  }

  private currentTransientState(): SidebarContainerState.TransientState {
    return {
      hoverActive:
        this.sidebarContainerHovered || this.sidebarHoverTargetActive,
      dragging: this.dragging,
      forceRevealReasons: [...this.focusedSet],
    };
  }

  private applyDiffOps(
    ops: SidebarContainerState.DiffOp[],
    snapshot: SidebarContainerState.ResolvedSnapshot,
  ): void {
    $$.mutate(() => {
      const $main = this.$("main-content-container");
      let widthMotion: Option<{
        fromWidth: number;
        fromInnerWidth: number;
        fromMain: string;
        duration: number;
      }>;
      for (const op of ops) {
        switch (op.type) {
          case "animation":
            this.toggleAnimate(op.animate);
            break;
          case "width": {
            const $inner = this.$("sidebar-inner-container");
            const $plate = this.$("sidebar-inner-container__before");
            // Capture the in-flight widths before cancelling a reversed toggle.
            const beforeWidth = getComputedStyle($plate).width;
            const beforeInnerWidth = Number.parseFloat(getComputedStyle($inner).width);
            const beforeMain = getComputedStyle($main).transform;
            const durationCss = getComputedStyle(this).getPropertyValue("--p-animation-duration").trim();
            const configuredDuration = Number.parseFloat(durationCss) *
              (durationCss.endsWith("ms") ? 1 : 1000);
            const duration = Number.isFinite(configuredDuration) ? configuredDuration : 300;
            const animateWidth = snapshot.animate &&
              !this.hasAttribute("no-width-transition") &&
              !matchMedia("(prefers-reduced-motion: reduce)").matches;
            this.cancelWidthAnimations();
            this.style.setProperty("--sidebar-width", op.widthCss);
            this.style.setProperty(
              "--sidebar-stickied-width",
              snapshot.stickied ? op.widthCss : "0px",
            );
            this.style.setProperty(
              "--sidebar-floating-width",
              snapshot.stickied ? "0px" : op.widthCss,
            );
            this.$("root").toggleAttribute("expanding", op.expanding);
            this.$("sidebar-inner-container__before").toggleAttribute(
              "expanding",
              op.expanding,
            );
            $inner.style.width = op.widthCss;
            if (animateWidth && duration > 0) {
              // Keep the old width in the painted style until the first frame.
              // Content layout can settle without exposing the final plate width.
              $plate.style.width = beforeWidth;
              const transition = $main.style.transition;
              $main.style.transition = "none";
              this.restoreMainTransition = () => { $main.style.transition = transition; };
              widthMotion = { fromWidth: Number.parseFloat(beforeWidth), fromInnerWidth: beforeInnerWidth, fromMain: beforeMain, duration };
            } else {
              $plate.style.width = op.widthCss;
            }
            break;
          }
          case "affordances":
            this.$("sidebar-hover-target-strip").toggleAttribute(
              "hidden",
              !op.hoverStripVisible,
            );
            this.$("sidebar-resize-strip").toggleAttribute(
              "hidden",
              !op.resizeStripVisible,
            );
            break;
          case "layout":
            this.style.setProperty("--stickied", op.stickied ? "1" : "0");
            this.$("root").toggleAttribute("active", op.active);
            this.$("root").toggleAttribute("stickied", op.stickied);
            this.$("sidebar-inner-container__before").toggleAttribute(
              "stickied",
              op.stickied,
            );
            if (widthMotion || op.mainContentTransform !== this.mainAnimationTarget) {
              if (!widthMotion && this.widthAnimationFrame != null) {
                this.cancelWidthAnimations();
                this.$("sidebar-inner-container__before").style.width = snapshot.widthCss;
                this.$("sidebar-inner-container").style.width = snapshot.widthCss;
              }
              $main.style.transform = op.mainContentTransform;
            }
            this.$("sidebar-container").style.transform = op.sidebarTransform;
            this.$("sidebar-inner-container__before").style.transform = op.sidebarTransform;
            break;
          case "backdrop":
            this.$("modal-backdrop").toggleAttribute("visible", op.visible);
            break;
        }
      }
      if (widthMotion) {
        const motion = widthMotion;
        const generation = this.widthAnimationGeneration;
        // Section mutations belong to this same flush. Resolve destination
        // geometry once they have landed, rather than forcing an earlier pass.
        $$.mutate(() => {
          if (generation !== this.widthAnimationGeneration || !this.isConnected) return;
          this.animatePaintedWidth(motion, snapshot);
        });
      }
    });
  }

  private animatePaintedWidth(
    motion: { fromWidth: number; fromInnerWidth: number; fromMain: string; duration: number },
    snapshot: SidebarContainerState.ResolvedSnapshot,
  ): void {
    const $plate = this.$("sidebar-inner-container__before");
    const $inner = this.$("sidebar-inner-container");
    const $main = this.$("main-content-container");
    const fromX = new DOMMatrixReadOnly(motion.fromMain === "none" ? "" : motion.fromMain).m41;
    const targetTransform = getComputedStyle($main).transform;
    const toX = new DOMMatrixReadOnly(targetTransform === "none" ? "" : targetTransform).m41;
    const toWidth = Number.parseFloat(getComputedStyle($inner).width);
    const generation = this.widthAnimationGeneration;
    // Let section FLIP capture its final layout, then restore the old shell
    // width before this paint. Section callbacks may join mutateEnd after us.
    $$.mutateEnd(() => $$.mutateEnd(() => {
      if (generation !== this.widthAnimationGeneration || !this.isConnected) return;
      $inner.style.width = `${motion.fromInnerWidth}px`;
    }));
    $main.style.transform = motion.fromMain;
    this.mainAnimationTarget = snapshot.mainContentTransform;
    this.widthProgress = 0;
    // Use the browser's CSS ease curve without attaching a width animation to
    // the painted element. Both boundaries are written in the same paint frame;
    // the calendar must not advance on the compositor while the plate is stale.
    const timing = new KeyframeEffect(null, [], {
      duration: motion.duration, easing: SidebarContainer.layoutEasing, fill: "both",
    });
    const clock = new Animation(timing);
    this.widthAnimationClock = clock;
    clock.currentTime = 0;
    let start: Option<number>;
    const frame = (timestamp: number): void => {
      if (!this.isConnected) { this.cancelWidthAnimations(); return; }
      start ??= timestamp;
      const elapsed = Math.min(timestamp - start, motion.duration);
      this.widthProgress = elapsed / motion.duration;
      clock.currentTime = elapsed;
      const progress = timing.getComputedTiming().progress ?? 0;
      const width = motion.fromWidth + (toWidth - motion.fromWidth) * progress;
      $plate.style.width = `${width}px`;
      $inner.style.width = `${motion.fromInnerWidth + (toWidth - motion.fromInnerWidth) * progress}px`;
      $main.style.transform = `translateX(${fromX + (toX - fromX) * progress}px)`;
      for (const listener of this.widthFrameListeners) listener(progress);
      if (elapsed < motion.duration) {
        this.widthAnimationFrame = requestAnimationFrame(frame);
      } else {
        $plate.style.width = snapshot.widthCss;
        $inner.style.width = snapshot.widthCss;
        $main.style.transform = snapshot.mainContentTransform;
        // Commit the final transform before re-enabling CSS transitions, or the
        // previous painted transform can start a second, independent transition.
        getComputedStyle($main).transform;
        this.cancelWidthAnimations();
      }
    };
    this.widthAnimationFrame = requestAnimationFrame(frame);
  }

  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!this.resolvedSnapshot?.dismissOnEscape) return;
    this.onRequestModalClose();
  };

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        display: block;
        position: relative;
        overflow: hidden;
        --p-animation-duration: var(
          --sidebar-container-animation-duration,
          300ms
        );
      }

      #main-content-container,
      #sidebar-container,
      #sidebar-inner-container__before {
        transition-timing-function: ease;
        transition-duration: var(--p-animation-duration);
      }

      #root {
        overscroll-behavior: none;
        height: 100%;
        align-items: stretch;
      }

      :host([no-transition]) #main-content-container,
      :host([no-transition]) #sidebar-container,
      :host([no-transition]) #sidebar-inner-container,
      :host([no-transition]) #sidebar-inner-container__before {
        transition-duration: 0ms !important;
        transition-delay: 0ms !important;
      }

      #main-content-container,
      #sidebar-container {
        transition-property: transform, box-shadow, background-color, width;
      }

      #sidebar-container {
        position: absolute;
        left: 0px;
        top: var(--sidebar-container-top, 0px);
        height: var(--sidebar-container-height, 100%);
        z-index: 2;
        border-top-right-radius: var(--sidebar-container-border-radius, 12px);
        border-bottom-right-radius: var(
          --sidebar-container-border-radius,
          12px
        );
        will-change: transform;
        transition: transform var(--p-animation-duration) ease;
      }

      #sidebar-container[active] {
        transform: translateX(0px);
      }

      #sidebar-inner-container__before {
        --box-shadow-transition-duration-factor: 1;

        position: absolute;
        content: "";
        top: var(--sidebar-container-top, 0px);
        left: 0;
        height: var(--sidebar-container-height, 100%);
        width: 0px;
        box-shadow: var(--box-shadow);
        background-color: var(--bg);
        border-top-right-radius: var(--sidebar-container-border-radius, 12px);
        border-bottom-right-radius: var(
          --sidebar-container-border-radius,
          12px
        );
        /* Keep a stable parent so content resizes cannot leave the painted
           plate edge split across its old and new bounds. */
        z-index: 1;
        pointer-events: none;
        transition-timing-function: ease;
        transition: transform var(--p-animation-duration) ease, box-shadow
            calc(
              var(--p-animation-duration) *
                var(--box-shadow-transition-duration-factor)
            );
      }

      #main-content-container {
        width: 100%;
        z-index: 0;
      }

      #modal-backdrop {
        position: absolute;
        inset: 0;
        z-index: 1;
        background: rgba(15, 23, 42, 0.18);
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--p-animation-duration) ease;
      }

      #modal-backdrop[visible] {
        opacity: 1;
        pointer-events: auto;
      }

      #sidebar-hover-target-strip {
        position: absolute;
        left: 0px;
        height: 100vh;
        width: 6px;
        z-index: 2000; /* ZIndex.SIDEBAR */
      }

      #sidebar-hover-target-strip[hidden],
      #sidebar-resize-strip[hidden] {
        display: none;
      }

      #sidebar-resize-strip {
        position: absolute;
        top: 0px;
        right: -8px;
        height: 100%;
        width: 16px;
        z-index: 2000; /* ZIndex.SIDEBAR */
        display: grid;
        place-items: center;
      }
      #sidebar-resize-indicator {
        height: 340px;
        width: 6px;
        border-radius: 4px;
        cursor: ew-resize;
      }
      :host([resizing]) #sidebar-resize-indicator,
      #sidebar-resize-indicator:hover {
        background-color: var(--text-ter);
      }
      #sidebar-inner-container {
        height: 100%;
        width: 300px;
      }

      #root #sidebar-inner-container__before,
      #root[stickied] #sidebar-inner-container__before {
        --box-shadow-transition-duration-factor: 2;
        box-shadow: none;
      }

      #root[active] #sidebar-inner-container__before {
        --box-shadow-transition-duration-factor: 0.5;
        box-shadow: var(--box-shadow);
      }

      #root[stickied][active] #sidebar-inner-container__before {
        --box-shadow-transition-duration-factor: 2;
        box-shadow: none;
      }

      :host([no-transform-transition]) #main-content-container {
        transition-duration: 0ms;
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <div id="sidebar-hover-target-strip"></div>
      <div id="modal-backdrop"></div>
      <div id="sidebar-inner-container__before" animate></div>

      <div id="sidebar-container">
        <div id="sidebar-inner-container">
          <slot name="sidebar"></slot>
        </div>

        <div id="sidebar-resize-strip">
          <div id="sidebar-resize-indicator"></div>
        </div>
      </div>

      <div id="main-content-container">
        <slot name="main-content"></slot>
      </div>
    </std-row>
  `;
}

export namespace SidebarContainer {
  export type Presentation = SidebarContainerState.Presentation;
  export type TransientState = SidebarContainerState.TransientState;

  /** Declarative presentation state for SidebarContainer. */
  export type ViewModel = SidebarContainerState.ViewModel;

  /** Caller-owned callbacks for semantic sidebar requests. */
  export type Delegate = Optional<{
    onSidebarDragStart: EmptyFunction;
    onSidebarDragMove: (
      initialSidebarWidthPx: number,
      additionalSizePx: number,
    ) => void;
    onSidebarDragEnd: EmptyFunction;
    onRequestModalClose: EmptyFunction;
    onResizePreview: (width: CSSLength) => void;
    onResizeCommit: (width: CSSLength) => void;
    onVisibleSidebarWidthChange: (
      snapshot: SidebarContainerState.ResolvedSnapshot,
    ) => void;
  }>;

  /** Bind props for the declarative model plus semantic interaction delegates. */
  export type Props = {
    viewModel: ViewModel;
    delegate: Option<Delegate>;
  };

  export type ResolvedSnapshot = SidebarContainerState.ResolvedSnapshot;

  export type DiffOp = SidebarContainerState.DiffOp;
}
