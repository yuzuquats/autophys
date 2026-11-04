import { LonaWebComponent } from "./component";
import { DomUtils } from "./dom";

/**
 * Utility class to observe scroll events on ancestor elements.
 * Used to reposition floating elements (dropdowns, context menus, etc.) when parent elements scroll.
 */
export class ScrollAncestorObserver {
  private $element: HTMLElement;
  private $watchedAncestors: Option<HTMLElement[]>;
  private callback: EmptyFunction;
  private onScroll = (_e: Event) => this.callback();

  constructor($element: HTMLElement, callback: () => void) {
    this.$element = $element;
    this.callback = callback;
  }

  observe() {
    if (this.$watchedAncestors) {
      this.unobserve();
    }

    // HACK: traversing the ancestor dom is not necessarily sufficient because
    // we might be placed in the shadow dom somewhere but "parentNode" doesn't
    // tell us where in the shadow we are. just that our parent is the lightdom
    // element
    //
    this.$watchedAncestors = DomUtils.getAncestors(this.$element);
    const $scroll = this.$watchedAncestors.find(
      (v) => v.tagName === "STD-SCROLL",
    ) as Option<LonaWebComponent>;
    const $scvp = $scroll?.$("content-viewport");
    $scvp && this.$watchedAncestors.push($scvp);

    for (const $parent of this.$watchedAncestors) {
      $parent.addEventListener("scroll", this.onScroll, {
        passive: true,
      });
    }
  }

  unobserve() {
    if (!this.$watchedAncestors) return;

    for (const $parent of this.$watchedAncestors) {
      $parent.removeEventListener("scroll", this.onScroll);
    }
    this.$watchedAncestors = null;
  }
}

export namespace ScrollUtils {
  let handle: number = 0;
  const scrolls: Map<HTMLElement, number> = new Map();

  // Element to move, element or px from, element or px to, time in ms to animate
  export function scrollTo(
    $e: HTMLElement,
    to: number,
    durationMs: number,
    mutateEnd: boolean,
    scrollDirection: "horizontal" | "vertical",
    onComplete?: () => void,
  ) {
    // if (durationMs <= 0) return;
    const nextHandle = handle++;
    scrolls.set($e, nextHandle);
    if (!scrolls) return;
    const from =
      scrollDirection === "horizontal" ? $e.scrollLeft : $e.scrollTop;
    _scrollTo(
      $e,
      from,
      to,
      Date.now(),
      durationMs,
      easeOutCuaic,
      nextHandle,
      mutateEnd,
      scrollDirection,
      onComplete,
    );
  }

  function _scrollTo(
    $e: HTMLElement,
    xFrom: number,
    xTo: number,
    startTimeMs: number,
    durationMs: number,
    motion: (t: number) => number,
    handle: number,
    mutateEnd: boolean,
    scrollDirection: "horizontal" | "vertical",
    onComplete?: () => void,
  ) {
    const currentHandle = scrolls.get($e);
    if (currentHandle == null || currentHandle !== handle) {
      onComplete?.();
      return;
    }

    if (durationMs === 0) {
      if (scrollDirection === "horizontal") {
        $e.scrollLeft = xTo;
      } else {
        $e.scrollTop = xTo;
      }
      scrolls.delete($e);
      onComplete?.();
      return;
    }

    const nowMs = Date.now();
    const deltaMs = nowMs - startTimeMs;
    const deltaPercent = deltaMs / durationMs;
    if (deltaPercent >= 1 || deltaPercent < 0) {
      if (scrollDirection === "horizontal") {
        $e.scrollLeft = xTo;
      } else {
        $e.scrollTop = xTo;
      }
      scrolls.delete($e);
      onComplete?.();
      return;
    }

    const value = xFrom - (xFrom - xTo) * motion(deltaPercent);
    if (scrollDirection === "horizontal") {
      $e.scrollLeft = value;
    } else {
      $e.scrollTop = value;
    }
    requestAnimationFrame(() => {
      _scrollTo(
        $e,
        xFrom,
        xTo,
        startTimeMs,
        durationMs,
        motion,
        handle,
        mutateEnd,
        scrollDirection,
        onComplete,
      );
    });
  }

  export function cancelScroll($e: HTMLElement) {
    scrolls.delete($e);
  }

  export function easeOutCuaic(t: number): number {
    t--;
    return t * t * t + 1;
  }
}
