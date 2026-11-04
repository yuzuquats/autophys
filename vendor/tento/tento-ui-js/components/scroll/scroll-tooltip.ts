import { Div } from "../../component-builtin";
import { $$ } from "../../fastdom";
import { LazySync } from "../../lazy";
import { LiveData } from "@tento-core/livedata";
import { Point } from "@tento-core/point";
import { Rational } from "@tento-core/rational";
import { SizeGate } from "../../ui/size-gate";
import { PopoverInfo, ScrollLayoutSnapshot } from "./scroll-layout-snapshot";
import { ScrollPopover } from "./scroll-popover";

export class ScrollTooltip {
  offsetX = 0;
  readonly size = new LiveData<Size>({ width: 0, height: 0 });
  readonly sizeGate = new SizeGate();
  private ro: ResizeObserver;

  constructor(
    readonly identifier: string,
    readonly $content: HTMLElement,
    readonly position: Point<number, /* index */ LiveData<number> /* px */>,
    readonly subindex: Rational,
    readonly location: "header" | "body" | "footer",
    readonly options?: ScrollTooltip.Options,
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
    const anchorHeight = this.options?.anchorHeight ?? 0;
    const margin = this.options?.margin;
    const subcolumnWidth = anchorFrame.width / this.subindex.d;
    return new PopoverInfo({
      position: basePosition,
      anchorFrame,
      edge: {
        left: anchorFrame.left,
        top: visualY,
        bottom: visualY + anchorHeight,
        right: 0,
      },
      size,
      subcolumn: this.subindex,
      subcolumnWidth,
      options: {
        offsetY: this.options?.offsetY,
        anchorHeight,
        margin,
      },
    });
  }
}

export namespace ScrollTooltip {
  export type Options = Optional<{
    offsetY: number;
    anchorHeight: number;
    margin: Inset;
    widthPx: number;
    onBind: EmptyFunction;
  }>;

  export class Controller {
    private $tooltip = new LazySync<HTMLDivElement>(() => {
      const $e = Div.make();
      $e.id = "tooltip";
      $e.assignStyles({
        pointerEvents: "none",
        marginTop: "0px",
        width: "fit-content",
      });
      return $e;
    });

    constructor(readonly delegate: ScrollPopover.Delegate) {}

    private _tooltip: Option<ScrollTooltip>;
    get currentTooltip(): Option<Readonly<ScrollTooltip>> {
      return this._tooltip;
    }

    private dismissTimeout: Option<ReturnType<typeof setTimeout>>;
    private static DISMISS_DELAY_MS = 300;
    private wasShown = false;

    private showTimeout: Option<ReturnType<typeof setTimeout>>;
    private pendingTooltip: Option<ScrollTooltip>;
    private static SHOW_DELAY_MS = 150;

    private clearPendingShow() {
      if (this.showTimeout) {
        clearTimeout(this.showTimeout);
        this.showTimeout = null;
      }
      this.pendingTooltip = null;
    }

    revealTooltip(tooltip: ScrollTooltip) {
      if (this.dismissTimeout) {
        clearTimeout(this.dismissTimeout);
        this.dismissTimeout = null;
      }
      this.clearPendingShow();

      if (this.wasShown) {
        this.revealTooltipSync(tooltip);
      } else {
        this.pendingTooltip = tooltip;
        this.showTimeout = setTimeout(() => {
          this.showTimeout = null;
          if (this.pendingTooltip !== tooltip) return;
          this.pendingTooltip = null;
          this.revealTooltipSync(tooltip);
        }, Controller.SHOW_DELAY_MS);
      }
    }

    queueDismissTooltip(id: string) {
      if (this.pendingTooltip?.identifier === id) {
        this.clearPendingShow();
        return;
      }
      this.dismissTimeout = setTimeout(() => {
        this.dismissTimeout = null;
        this.dismissTooltip(id);
      }, Controller.DISMISS_DELAY_MS);
    }

    private revealTooltipSync(tooltip: ScrollTooltip) {
      const { $content, position, location, options } = tooltip;

      this._tooltip?.stopObserving();
      this._tooltip = tooltip;

      const $e = this.$tooltip.get();
      tooltip.offsetX = this.delegate.appendFixedChild(
        $e,
        location,
        position.x,
        (offsetX) =>
          $$.mutate(() => {
            tooltip.offsetX = offsetX;
            this.layoutTooltip(tooltip);
          }),
      );
      $e.replaceChildren($content);
      options?.onBind?.();

      tooltip.startObserving();
      tooltip.size.addListener(
        this,
        (size) => {
          if (!size) return;
          this.layoutTooltip(tooltip);
        },
        LiveData.TriggerImmediately,
      );
    }

    private layoutTooltip(tooltip: ScrollTooltip) {
      if (this.currentTooltip != tooltip) return;
      $$.mutate(() => this.layoutTooltipSync(tooltip));
    }

    private layoutTooltipSync(tooltip: ScrollTooltip) {
      const $e = this.$tooltip.get();

      tooltip.position.y.removeListener($e);

      const layout = this.delegate.layoutSnapshot(tooltip.location);
      const anchorFrame = this.delegate.getAnchorFrame(tooltip.position.x);
      const popoverSize = {
        width: $e.offsetWidth,
        height: $e.offsetHeight,
      };
      const tooltipInfo = tooltip.buildPopoverInfo(
        layout,
        anchorFrame,
        popoverSize,
      );
      this.delegate.onPopoverInfoChange({
        popover: tooltipInfo,
        location: tooltip.location,
      });

      const checker: ScrollLayoutSnapshot.ConstraintsChecker = (canLayout) => {
        const position = canLayout.below ? "below" : "above";
        return {
          horizontal: { position: "center", overlap: true },
          vertical: {
            position,
            overlap: position === "below", // overlap when below, no overlap when above
          },
        };
      };
      const { base, additional } = layout.resolvePosition(tooltipInfo, checker);

      $e.assignStyles({
        transition: this.wasShown
          ? "opacity 0.3s ease, transform 0.3s ease"
          : "opacity 0.3s ease",
        // width: tooltip.options?.widthPx ? tooltip.options?.widthPx + "px" : "",
        opacity: String(1),
        "--x": tooltip.offsetX + "px",
        "--y": base.y + "px",
        "--additional-x": additional.x + "px",
        "--additional-y": additional.y + "px",
      });
      this.wasShown = true;
    }

    dismissTooltip(id: string) {
      if (this.pendingTooltip?.identifier === id) {
        this.clearPendingShow();
      }
      if (this._tooltip?.identifier !== id) return;
      this.reset();

      const $e = this.$tooltip.get();
      $e.style.opacity = String(0);
      $e.style.pointerEvents = "none";

      this.delegate.onPopoverInfoChange(null);
      this.wasShown = false;
    }

    private reset() {
      this.clearPendingShow();
      this._tooltip?.size.removeListener(this);
      this._tooltip?.stopObserving();
      this._tooltip = null;
    }
  }
}
