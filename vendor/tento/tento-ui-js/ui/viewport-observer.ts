import { NumRangeLike } from "@tento-core/range";

type ViewportChangeCallback = (viewport: NumRangeLike) => void;

export class ViewportObserver {
  $container: HTMLElement;
  viewportSize: Size;
  viewport: NumRangeLike;
  listeners: ViewportChangeCallback[] = [];
  private reverse: boolean;

  private resizeObserver = new ResizeObserver(() => {
    this.recalculateViewportSize();
    this.viewport = this.calculateViewport();
    this.emitViewportChange();
  });

  constructor($e: HTMLElement = document.body, reverse: boolean = false) {
    this.$container = $e;
    this.reverse = reverse;
    this.viewportSize = this.calculateViewportSize();
    this.viewport = this.calculateViewport();

    // this.emitViewportChange();
    this.resizeObserver.observe(this.$container);
    this.$container.addEventListener(
      "scroll",
      () => {
        this.recalculateViewport();
        this.emitViewportChange();
      },
      {
        capture: true,
        passive: false,
      },
    );
  }

  calculateViewportSize(): Size {
    const rect = this.$container.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
    };
  }

  private calculateViewport(): NumRangeLike {
    if (this.reverse) {
      return {
        start: -this.$container.scrollTop,
        end: -this.$container.scrollTop + this.viewportSize.height,
      };
    } else {
      return {
        start: this.$container.scrollTop,
        end: this.$container.scrollTop + this.viewportSize.height,
      };
    }
  }

  recalculateViewportSize() {
    this.viewportSize = this.calculateViewportSize();
  }

  recalculateViewport() {
    this.viewport = this.calculateViewport();
  }

  emitViewportChange() {
    if (!this.enabled) return;
    for (const listener of this.listeners) {
      listener(this.viewport);
    }
  }

  addViewportListener(fn: ViewportChangeCallback) {
    this.listeners.push(fn);
    fn(this.viewport);
  }

  private enabled: boolean = true;
  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }
}
