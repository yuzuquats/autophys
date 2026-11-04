import { $$ } from "../../fastdom";
import { LazySync } from "../../lazy";
import { LiveData } from "@tento-core/livedata";
import { Point } from "@tento-core/point";
import { Rational } from "@tento-core/rational";
import { Tracing } from "@tento-core/tracing";
import { SizeGate } from "../../ui/size-gate";
import { Round } from "../round";
import { PopoverInfo, ScrollLayoutSnapshot } from "./scroll-layout-snapshot";

export class ScrollPopover {
  offsetX = 0;
  readonly size = new LiveData<Option<Size>>(null);
  readonly sizeGate = new SizeGate();
  private ro: ResizeObserver;

  constructor(
    readonly identifier: string,
    readonly $content: HTMLElement,
    readonly position: Point<number, /* index */ LiveData<number> /* px */>,
    readonly subindex: Rational,
    readonly location: "header" | "body" | "footer",
    readonly options?: ScrollPopover.Options,
  ) {
    this.ro = new ResizeObserver(([e]) => {
      const newSize = {
        width: e.contentRect.width,
        height: e.contentRect.height,
      };
      this.sizeGate.resolve(newSize);
      this.size.update(newSize);
    });
  }

  startObserving() {
    this.ro.observe(this.$content);
  }

  stopObserving() {
    this.ro?.disconnect();
  }

  widthPx(): number {
    return this.options?.widthPx ?? 340;
  }

  buildPopoverInfo(
    layout: ScrollLayoutSnapshot,
    anchorFrame: {
      left: number;
      width: number;
    },
    size: Size,
  ): PopoverInfo {
    const basePosition = {
      x: this.position.x,
      y: this.position.y.get(),
    };
    const visualY =
      basePosition.y - layout.config.scrollTop + layout.config.headerHeight;
    return new PopoverInfo({
      position: basePosition,
      anchorFrame,
      edge: {
        left: anchorFrame.left,
        top: visualY,
        bottom: visualY,
        right: 0,
      },
      size,
      subcolumn: this.subindex,
      subcolumnWidth: anchorFrame.width / this.subindex.d,
      options: {
        offsetY: this.options?.offsetY,
        margin: this.options?.margin,
        offset: this.options?.offset,
      },
    });
  }
}

export namespace ScrollPopover {
  export type Options = Optional<{
    edge: {
      top: number;
      bottom: number;
    };
    offsetY: number;
    /** @deprecated Use offset instead for unified inner/outer offset control */
    margin: Inset;
    offset: {
      inner?: { vertical?: number; horizontal?: number | { left: number; right: number } };
      outer?: { vertical?: number; horizontal?: number | { left: number; right: number } };
    };
    widthPx: number;
    shouldOverlapIndex: boolean;
    onBind: EmptyFunction;
    onDismiss: EmptyFunction;
    onReveal: EmptyFunction;
    context: string;
    constraintsChecker: ScrollLayoutSnapshot.ConstraintsChecker;
  }>;

  export interface Delegate {
    appendFixedChild(
      $e: HTMLElement,
      location: "body" | "header" | "footer",
      index: number,
      onUpdate: (offset: number) => void,
    ): number;
    layoutSnapshot(location: "header" | "body" | "footer"): ScrollLayoutSnapshot;
    getAnchorFrame(index: number): { left: number; width: number };
    onPopoverInfoChange(
      info: Option<{
        popover: PopoverInfo;
        location: "body" | "header" | "footer";
      }>,
    ): void;
  }

  export class Controller {
    private $popover = new LazySync<Round>(() => {
      const $e = Round.makeWith({
        ...Round.Props.MODAL,
        bg: "var(--bg-elevated)",
        transformTopLeft: true,
      }).setAnimates(false);
      $e.id = "popover";
      $e.style.marginTop = "0px";
      return $e;
    });

    constructor(readonly delegate: ScrollPopover.Delegate) {}

    private _popover: Option<ScrollPopover>;
    private _isFirstReveal = true;
    get currentPopover(): Option<Readonly<ScrollPopover>> {
      return this._popover;
    }

    revealPopover(popover: ScrollPopover) {
      const sameId = this._popover?.identifier === popover.identifier;
      // True double-fire — same slot AND same content element → no-op.
      if (sameId && this._popover?.$content === popover.$content) return;
      // Same slot, NEW content element → swap content in place: keep the box
      // painted (no visibility flip, no dismiss) and ease to the new anchor via
      // the animated, non-slide-up path. This is what keeps the popover present
      // across an event→event switch instead of blanking for a frame.
      const isSwap = sameId;

      if (!isSwap) this._popover?.options?.onDismiss?.();

      const { $content, position, location, options } = popover;

      let isFirstTime = isSwap ? false : this._isFirstReveal;
      this._popover?.stopObserving();
      // Drop the prior popover's size listener so a late ResizeObserver tick on
      // the swapped-out popover can't re-enter layout (mirrors reset() minus the
      // null-out, which the reassignment below performs).
      this._popover?.size.removeListener(this);
      this._popover = popover;

      const $e = this.$popover.get();
      $e.setAttribute("context", options?.context ?? "");
      if (!isSwap) $e.style.visibility = "hidden";
      popover.offsetX = this.delegate.appendFixedChild(
        $e,
        location,
        position.x,
        (offsetX) =>
          $$.mutate(() => {
            popover.offsetX = offsetX;
            this.layoutPopover(popover, false, isSwap);
          }),
      );
      $e.replaceChildren($content);
      options?.onBind?.();

      $e.style.width = popover.widthPx() + "px";
      popover.startObserving();
      popover.size.addListener(
        this,
        (size) => {
          if (!size) return;
          this.layoutPopover(popover, isFirstTime, isSwap);
          isFirstTime = false;
          this._isFirstReveal = false;
        },
        LiveData.TriggerImmediately,
      );
    }

    private layoutPopover(
      popover: ScrollPopover,
      isFirstTime: boolean,
      isSwap: boolean,
    ) {
      if (this.currentPopover != popover) return;
      // console.trace("dbg/scroll/popover/layout");
      $$.mutate(() => this.layoutPopoverSync(popover, isFirstTime, isSwap));
    }

    private async layoutPopoverSync(
      popover: ScrollPopover,
      isFirstTime: boolean,
      isSwap: boolean,
    ) {
      if (this._popover !== popover) return;
      const $e = this.$popover.get();
      $e.ontransitionend = null;

      // await popover.sizeGate.waitForSize();
      popover.position.y.removeListener($e);
      $e.style.width = popover.widthPx() + "px";
      $e.style.pointerEvents = "all";

      const layout = this.delegate.layoutSnapshot(popover.location);
      const anchorFrame = this.delegate.getAnchorFrame(popover.position.x);
      const rsize = {
        width: $e.offsetWidth,
        height: $e.offsetHeight,
      };
      const popoverInfo = popover.buildPopoverInfo(layout, anchorFrame, rsize);
      this.delegate.onPopoverInfoChange({
        popover: popoverInfo,
        location: popover.location,
      });
      const defaultChecker: ScrollLayoutSnapshot.ConstraintsChecker = (
        canLayout,
      ) => ({
        horizontal: {
          position: canLayout.right ? "right" : "left",
          overlap: popover.options?.shouldOverlapIndex ?? false,
        },
        vertical: {
          position: "below",
          overlap: false,
        },
      });

      const checker = popover.options?.constraintsChecker ?? defaultChecker;
      const { base, additional } = layout.resolvePosition(popoverInfo, checker);

      const previous = {
        x: $e.dataset.prevX ? Number.parseInt($e.dataset.prevX) : 0,
        y: $e.dataset.prevY ? Number.parseInt($e.dataset.prevY) : 0,
      };
      const newScreen = {
        x: base.x + additional.x,
        y: base.y + additional.y + layout.config.headerHeight,
      };
      const delta = {
        x: newScreen.x - previous.x,
        y: newScreen.y - previous.y,
      };
      const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y);
      const distanceThreshold = 1200;
      // An in-place content swap never slides up — the box is already painted,
      // so the slide-up (opacity 0→1) would re-introduce the very flash this
      // path exists to avoid, even for events far enough apart to trip the
      // distance threshold. It only eases the transform to the new anchor.
      const useSlideUpAnimation =
        !isSwap && (isFirstTime || distance > distanceThreshold);

      $e.dataset.prevX = String(newScreen.x);
      $e.dataset.prevY = String(newScreen.y);
      Tracing.dev("scroll-popover", useSlideUpAnimation, isFirstTime, distance, distanceThreshold);
      $e.setAnimates(!useSlideUpAnimation);
      if (useSlideUpAnimation) {
        $e.assignStyles({
          transition: "none",
          opacity: String(0),
          visibility: "visible",
          "--x": popover.offsetX + "px",
          "--y": base.y + 8 + "px",
          "--additional-x": additional.x + "px",
          "--additional-y": additional.y + "px",
        });
        $$.measure(() => {
          $e.offsetHeight; // Force layout
          setTimeout(() => {
            $$.mutate(() => {
              $e.assignStyles({
                transition: "transform 0.3s ease, opacity 0.3s ease",
                opacity: String(1),
                "--y": base.y + "px",
              });
              popover.options?.onReveal && $$.defer(popover.options.onReveal);
            });
          });
        });
      } else {
        $$.mutate(() => {
          $e.assignStyles({
            transition: "transform 0.3s ease, opacity 0.3s ease",
            opacity: String(1),
            visibility: "visible",
            "--x": popover.offsetX + "px",
            "--y": base.y + "px",
            "--additional-x": additional.x + "px",
            "--additional-y": additional.y + "px",
          });
          popover.options?.onReveal && $$.defer(popover.options.onReveal);
        });
      }
    }

    dismissPopover(id: string) {
      if (this._popover?.identifier !== id) return;
      this._popover?.options?.onDismiss?.();
      this.reset();
      // A replacement can reveal before the dismiss transition ends. Treat that
      // reveal as fresh immediately so it does not animate from this popover's
      // previous screen coordinates.
      this._isFirstReveal = true;
      const $popover = this.$popover.get();
      const previousY = Number.parseInt($popover.style.getPropertyValue("--y"));
      $popover.style.setProperty("--y", previousY + 40 + "px");
      $popover.style.opacity = String(0);
      $popover.style.pointerEvents = "none";
      // TODO: is it not sufficient to just blur the popover?
      $popover.blur();
      for (const $c of $popover.children) {
        if (!($c instanceof HTMLElement)) continue;
        $c.blur();
      }
      $popover.ontransitionend = async () => {
        if (this._popover?.identifier != null) return;
        this._isFirstReveal = true;
        $popover.style.setProperty("--height", "100%");
        $popover.clearChildren(false);
        $popover.ontransitionend = null;
        setTimeout(() => {
          $$.mutate(() => {
            $popover.assignStyles({
              "--y": previousY + "px",
            });
          });
        });
      };

      this.delegate.onPopoverInfoChange(null);
    }

    private reset() {
      this._popover?.size.removeListener(this);
      this._popover?.stopObserving();
      this._popover = null;
    }
  }
}
