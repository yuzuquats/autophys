import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { LazySync } from "@tento-ui/lazy";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Globals } from "../../globals";
import { SimpleKeyframe } from "../../keyframe";
import { MathUtils } from "@tento-core/math";
import { ZIndex } from "../../z-index";
import { PageIndiciatorDots } from "../page-indicator-dots";
import { Scrollbars } from "../scrollbars";
import { Toast } from "./toast";

const SPACING = 2;
const EDGE_EASE_WINDOW = 20;
const VIEWPORT_HEIGHT = 300;
const HEADER_GAP = 4;

@component({
  name: "std-toaster",
})
export class Toaster extends LonaWebComponent {
  static ZINDEX = ZIndex.TOAST;

  private $$ = {
    sentinel: this.$("sentinel"),
    header: this.$("header"),
    clearAll: this.$("clear-all"),
    clearAllLabel: this.$("clear-all-label"),
  };

  constructor() {
    super();
    // Host and own-shadow targets: they survive recycling, so nothing here is
    // removed on disconnect. See the note in text-input.ts.
    this.addEventListener("wheel", this.handleWheel, { passive: false });
    this.$$.sentinel.addEventListener("pointerenter", this.handlePointerEnter);
    this.$$.sentinel.addEventListener("pointerleave", this.handlePointerLeave);
    this.$$.header.addEventListener("pointerenter", this.handlePointerEnter);
    this.$$.header.addEventListener("pointerleave", this.handlePointerLeave);
    this.$$.clearAll.addEventListener("pointerenter", this.handleClearAllEnter);
    GESTURE_MANAGER.addPointerEvent(this.$$.clearAll, {
      onClick: () => this.dismissAll(),
    });
  }

  static readonly instance: LazySync<Toaster> = new LazySync(() => {
    const $toaster = Toaster.make();
    document.body.appendChild($toaster);
    return $toaster;
  });

  private get $toasts(): HTMLElement[] {
    return [
      ...this.$<HTMLSlotElement>("toasts").assignedElements(),
    ] as HTMLElement[];
  }

  get expanded(): boolean {
    return this.$$.sentinel.hasAttribute("expanded");
  }

  private cachedHeights: Map<HTMLElement, number> = new Map();
  // A toast's height is measured once and then trusted, but it can change
  // after that: content that lays out late (a std-exception), or expanding,
  // which lifts the collapsed 160px cap. A stale height misplaces every toast
  // above it and the clear-all button, so re-measure on resize.
  private readonly resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const $toast = entry.target as HTMLElement;
      const cached = this.cachedHeights.get($toast);
      if (cached == null) continue;
      const h = entry.borderBoxSize[0]?.blockSize ??
        $toast.getBoundingClientRect().height;
      if (Math.abs(h - cached) < 0.5) continue;
      this.cachedHeights.set($toast, h);
      changed = true;
    }
    if (changed) this.rebind();
  });
  private toastDurations: WeakMap<HTMLElement, number> = new WeakMap();
  private currentTimeout: Option<ReturnType<typeof setTimeout>>;
  private hoverLeaveTimer: Option<ReturnType<typeof setTimeout>> = null;
  private virtualScroll: number = 0;

  private handlePointerEnter = () => {
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.expanded) return;
    this.expandWithAnimation();
  };

  private isInsideExpandedSentinel(e: PointerEvent): boolean {
    if (!this.expanded) return false;
    const rect = this.$$.sentinel.getBoundingClientRect();
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );
  }

  private handlePointerLeave = (e: PointerEvent) => {
    if (this.isInsideExpandedSentinel(e)) return;
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    this.hoverLeaveTimer = setTimeout(() => {
      this.hoverLeaveTimer = null;
      this.queueNextToastTimeout();
      if (!this.expanded) return;
      this.collapseWithAnimation();
    }, 100);
  };

  private clearAllWidthMeasured = false;
  private handleClearAllEnter = () => {
    if (this.clearAllWidthMeasured) return;
    const w = this.$$.clearAllLabel.offsetWidth;
    this.$$.clearAll.style.setProperty("--clear-all-w", `${w + 36}px`);
    this.clearAllWidthMeasured = true;
  };

  private handleWheel = (e: WheelEvent) => {
    if (!this.expanded) return;
    e.preventDefault();

    const $toasts = this.$toasts;
    const totalHeight = this.getTotalContentHeight($toasts);
    const maxScroll = Math.max(0, totalHeight - VIEWPORT_HEIGHT);

    // Update virtual scroll position
    this.virtualScroll = MathUtils.clampInc(
      this.virtualScroll + e.deltaY,
      0,
      maxScroll,
    );
    this.applyExpandedLayout($toasts, false);
  };

  disconnectedCallback() {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
  }

  private expandWithAnimation() {
    const $toasts = this.$toasts;
    if ($toasts.length === 0) return;

    this.$$.sentinel.toggleAttribute("expanded", true);
    this.measureHeights($toasts);

    // Set virtual scroll to bottom to show newest toasts
    const totalHeight = this.getTotalContentHeight($toasts);
    this.virtualScroll = Math.max(0, totalHeight - VIEWPORT_HEIGHT);

    this.applyExpandedLayout($toasts);
  }

  private collapseWithAnimation() {
    const $toasts = this.$toasts;
    if ($toasts.length === 0) {
      this.$$.sentinel.toggleAttribute("expanded", false);
      return;
    }

    this.$$.sentinel.toggleAttribute("expanded", false);
    this.virtualScroll = 0;
    this.applyCollapsedLayout($toasts);
  }

  private rebind() {
    const $toasts = this.$toasts;
    if (this.expanded) {
      this.measureHeights($toasts);
      const totalHeight = this.getTotalContentHeight($toasts);
      // Clamp virtual scroll to valid range after toast count changes
      this.virtualScroll = MathUtils.clampInc(
        this.virtualScroll,
        0,
        Math.max(0, totalHeight - VIEWPORT_HEIGHT),
      );
      this.applyExpandedLayout($toasts);
    } else {
      // Apply immediately to ensure z-indices are updated when toasts are added
      this.applyCollapsedLayout($toasts);
    }
  }

  private measureHeights($toasts: HTMLElement[]) {
    for (const $toast of $toasts) {
      if (!this.cachedHeights.has($toast)) {
        this.cachedHeights.set($toast, $toast.getBoundingClientRect().height);
      }
    }
  }

  private getHeight($toast: HTMLElement): number {
    let h = this.cachedHeights.get($toast);
    if (h == null) {
      h = $toast.getBoundingClientRect().height;
      this.cachedHeights.set($toast, h);
    }
    return h;
  }

  private getTotalContentHeight($toasts: HTMLElement[]): number {
    let total = 0;
    for (const $toast of $toasts) {
      total += this.getHeight($toast) + SPACING;
    }
    return total > 0 ? total - SPACING : 0;
  }

  private applyCollapsedLayout(
    $toasts: HTMLElement[],
    enableTransition: boolean = true,
  ) {
    const $front = $toasts[0];
    if ($front) {
      this.measureHeights($toasts);
      const topH = this.getHeight($front);
      this.style.setProperty("--header-bottom", `${topH + HEADER_GAP}px`);
    }
    for (const [idx, $toast] of $toasts.entries()) {
      const cappedIdx = Math.min(idx, 2);
      $toast.assignStyles({
        zIndex: String(Toaster.ZINDEX - idx),
        "--toast-transition": enableTransition ? "" : "none",
        "--toast-transform": `scale(${1 - cappedIdx * 0.04}) translateY(${
          cappedIdx * -12
        }px)`,
        filter: idx === 0 ? "" : idx === 1 ? "blur(0.7px)" : "blur(1.4px)",
      });
    }
  }

  private applyExpandedLayout(
    $toasts: HTMLElement[],
    enableTransition: boolean = true,
  ) {
    if ($toasts.length === 0) return;

    const transitionValue = enableTransition ? "" : "none";
    const totalHeight = this.getTotalContentHeight($toasts);
    const maxScroll = Math.max(0, totalHeight - VIEWPORT_HEIGHT);
    const scrollTop = this.virtualScroll;

    const visibleTop = Math.min(totalHeight, VIEWPORT_HEIGHT);
    this.style.setProperty("--header-bottom", `${visibleTop + HEADER_GAP}px`);

    // Calculate positions from bottom (newest at bottom, oldest at top)
    // runningOffset = distance from bottom of content to bottom of current toast
    let runningOffset = 0;

    for (const [idx, $toast] of $toasts.entries()) {
      const h = this.getHeight($toast);

      // Position in content coordinates (0 = bottom, totalHeight = top)
      const toastBottomFromBottom = runningOffset;
      const toastTopFromBottom = runningOffset + h;

      // Convert to "from top" coordinates for viewport calculations
      const toastTop = totalHeight - toastTopFromBottom;
      const toastBottom = totalHeight - toastBottomFromBottom;

      runningOffset += h + SPACING;

      // Calculate base translateY to position this toast in the stack
      // All toasts anchored at bottom: 0, then stack upward with negative translateY
      // Scroll adjustment: when scrolled to bottom (scrollTop = maxScroll), no adjustment
      // When scrolled to top (scrollTop = 0), shift everything down by maxScroll
      const baseTranslateY = -toastBottomFromBottom + (maxScroll - scrollTop);

      // Check if toast is at viewport edges
      const deltaTop = scrollTop - toastTop;
      const deltaBottom = toastBottom - (scrollTop + VIEWPORT_HEIGHT);

      // Overflowing top edge (older toasts) - make them stick to top edge
      // Reverse z-index so visible toasts appear over blurred/shrunk ones
      if (deltaTop > 0) {
        const progress = MathUtils.clampInc(deltaTop / EDGE_EASE_WINDOW, 0, 1);
        // Add deltaTop to pull toast back towards viewport (stick to top edge)
        const stickyTranslateY = baseTranslateY + deltaTop;
        $toast.assignStyles({
          zIndex: String(Toaster.ZINDEX + $toasts.length - idx),
          "--toast-transition": transitionValue,
          "--toast-transform": `translateY(${stickyTranslateY}px) scale(${MathUtils.lerp(1, 0.96, progress)})`,
          filter: `blur(${MathUtils.lerp(0, 0.7, progress)}px)`,
        });
        continue;
      }

      // Overflowing bottom edge (newer toasts) - just overlap, no blur/scale
      if (deltaBottom > 0) {
        // Subtract deltaBottom to push toast back towards viewport (stick to bottom edge)
        const stickyTranslateY = baseTranslateY - deltaBottom;
        $toast.assignStyles({
          zIndex: String(Toaster.ZINDEX + $toasts.length * 2 - idx),
          "--toast-transition": transitionValue,
          "--toast-transform": `translateY(${stickyTranslateY}px)`,
          filter: "",
        });
        continue;
      }

      // Fully visible
      $toast.assignStyles({
        zIndex: String(Toaster.ZINDEX + $toasts.length * 2 - idx),
        "--toast-transition": transitionValue,
        "--toast-transform": `translateY(${baseTranslateY}px)`,
        filter: "",
      });
    }
  }

  static showPersistent(
    id: string,
    $toast: HTMLElement,
    group?: Option<string>,
  ): Toaster.Persistent.Handle {
    const $toaster = Toaster.Persistent.Container.instance.get();
    return $toaster.show(id, $toast, group);
  }

  static show($toast: Toast, timeoutMs: number) {
    const $toaster = Toaster.instance.get();
    $toaster.show($toast, timeoutMs);
  }

  show($toast: Toast, timeoutMs: number = Globals.TOAST_DURATION_MS) {
    const removeToast = () => {
      this.animateRemoveToast($toast, () => {
        if (this.$toasts.length === 0) {
          $$.mutate(() => {
            this.$$.sentinel.toggleAttribute("expanded", false);
          });
        }
        this.rebind();
      });
    };

    $toast.onClickClose = removeToast;
    $toast.onClickUndo = removeToast;

    $toast.addEventListener("pointerenter", this.handlePointerEnter);
    $toast.addEventListener("pointerleave", this.handlePointerLeave);

    this.prepend($toast);
    if (this.$toasts.length === 1) {
      this.animate(SimpleKeyframe.builder().slideIn(0, 20).fadeIn().build(), {
        duration: 150,
      });
    }

    this.toastDurations.set($toast, timeoutMs);
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    this.queueNextToastTimeout();

    this.cachedHeights.delete($toast);
    this.resizeObserver.observe($toast);
    this.rebind();
  }

  dismissAll() {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    const $toasts = this.$toasts;
    if ($toasts.length === 0) return;
    this.$$.sentinel.toggleAttribute("expanded", false);
    this.virtualScroll = 0;
    let remaining = $toasts.length;
    for (const $toast of $toasts) {
      this.animateRemoveToast($toast, () => {
        remaining--;
        if (remaining === 0) this.rebind();
      });
    }
  }

  private animateRemoveToast($toast: HTMLElement, onComplete?: EmptyFunction) {
    $toast.removeEventListener("pointerenter", this.handlePointerEnter);
    $toast.removeEventListener("pointerleave", this.handlePointerLeave);
    $toast.animate(SimpleKeyframe.builder().slideOut(0, 20).fadeOut().build(), {
      duration: 150,
    }).onfinish = () => {
      this.resizeObserver.unobserve($toast);
      this.cachedHeights.delete($toast);
      DomUtils.removeFromDom($toast);
      onComplete?.();
    };
  }

  private queueNextToastTimeout() {
    const $first = this.$toasts[0];
    if (!$first) {
      this.currentTimeout = null;
      return;
    }
    const timeoutMs = this.toastDurations.get($first)!;
    this.currentTimeout = setTimeout(() => {
      this.animateRemoveToast($first, () => {
        this.rebind();
        this.queueNextToastTimeout();
      });
    }, timeoutMs);
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        display: block;
        position: fixed;
        bottom: 0px;
        right: 0px;
        z-index: 7000; /* ZIndex.TOAST */
        outline: var(--debug-toaster-outline, none);
        pointer-events: none;
      }

      #root {
        position: absolute;
        bottom: 0;
        right: 0;
        transform: translate(
          var(--toaster-offset, -20px),
          calc(
            var(--toaster-offset, -20px)
            - var(--persistent-toast-height, 0px)
            + var(--additional-toaster-bottom, 0px)
          )
        );
        transition: transform 0.3s ease;
      }

      #sentinel {
        position: relative;
        overflow: visible;
        width: 320px;
        outline: var(--debug-toaster-outline, none);
      }

      #container {
        position: relative;
        overflow: visible;
      }

      #sentinel[expanded] {
        height: 300px;
        overflow: hidden;
        pointer-events: auto;
      }

      #sentinel[expanded] #container {
        height: 300px;
      }

      #sentinel[expanded] slot::slotted(*) {
        max-height: none;
      }

      slot::slotted(*) {
        position: absolute;
        right: 0px;
        bottom: 0px;
        max-height: 160px;
        will-change: transform;
        pointer-events: auto;
      }

      #header {
        position: absolute;
        bottom: var(--header-bottom, 80px);
        right: 8px;
        width: calc(100% - 16px);
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        z-index: 99999;
        opacity: 0;
        transform: translateY(20px);
        transition: bottom 0.3s ease, opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
      }

      #sentinel[expanded] ~ #header {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      #clear-all {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 32px;
        width: 32px;
        padding: 0;
        border: 1px solid var(--divider);
        background: var(--bg);
        color: var(--text-sec);
        border-radius: 16px;
        cursor: pointer;
        box-shadow: var(--box-shadow);
        transition: width 0.3s ease;
      }

      #clear-all #x {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        transition: opacity 0.3s ease;
      }

      #clear-all-label {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        white-space: nowrap;
        font-size: var(--text-12px);
        font-weight: 500;
        color: var(--text-sec);
        opacity: 0;
        transition: opacity 0.3s ease;
      }

      #clear-all:hover {
        width: var(--clear-all-w, 120px);
      }

      #clear-all:hover #x {
        opacity: 0;
      }

      #clear-all:hover #clear-all-label {
        opacity: 1;
      }

      #clear-all:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
`,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <div id="sentinel">
        <div id="container">
          <slot id="toasts"></slot>
        </div>
      </div>
      <div id="header">
        <button id="clear-all" aria-label="Clear all notifications">
          <svg id="x" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.41,12l4.3-4.29a1,1,0,1,0-1.42-1.42L12,10.59,7.71,6.29A1,1,0,0,0,6.29,7.71L10.59,12l-4.3,4.29a1,1,0,0,0,0,1.42,1,1,0,0,0,1.42,0L12,13.41l4.29,4.3a1,1,0,0,0,1.42,0,1,1,0,0,0,0-1.42Z"/>
          </svg>
          <span id="clear-all-label">Clear all</span>
        </button>
      </div>
    </std-col>
  `;
}

export namespace Toaster {
  export namespace Persistent {
    export type Handle = {
      id: string;
      dismiss: () => void;
    };

    type GroupEntry = {
      id: string;
      $toast: HTMLElement;
    };

    type GroupState = {
      toasts: GroupEntry[];
      activeIndex: number;
      $wrapper: HTMLElement;
      $dots: PageIndiciatorDots;
    };

    @component({
      name: "std-toaster-persistent-container",
    })
    export class Container extends LonaWebComponent {
      static readonly instance: LazySync<Container> = new LazySync(() => {
        const $persistent = Container.make();
        document.body.appendChild($persistent);
        return $persistent;
      });

      private groups: Map<string, GroupState> = new Map();

      // The toaster lifts its stack by --persistent-toast-height. It is
      // published on this container's parent, which holds the toasters that
      // share its corner: document.body for the page's instance, a local
      // frame for one placed in a story. Writing it on body from anywhere let
      // a container inside a storybook card lift the page's own toaster.
      private $published: Option<HTMLElement> = null;

      private readonly ro = new ResizeObserver(([entry]) => {
        const h = entry.contentRect.height;
        $$.mutate(() => {
          const $parent = this.parentElement;
          if ($parent == null) return;
          this.$published = $parent;
          $parent.style.setProperty(
            "--persistent-toast-height",
            h === 0 ? "0px" : `${h + 2}px`,
          );
        });
      });

      connectedCallback() {
        this.ro.observe(this);
      }

      disconnectedCallback() {
        this.ro.unobserve(this);
        // A removed container lifts nothing.
        this.$published?.style.removeProperty("--persistent-toast-height");
        this.$published = null;
      }

      show(
        id: string,
        $toast: HTMLElement,
        group?: Option<string>,
      ): Persistent.Handle {
        if (group == null) {
          return this.showUngrouped(id, $toast);
        }
        return this.showGrouped(id, $toast, group);
      }

      private showUngrouped(
        id: string,
        $toast: HTMLElement,
      ): Persistent.Handle {
        this.appendChild($toast);
        $toast.animate(
          SimpleKeyframe.builder().slideIn(0, 20).fadeIn().build(),
          {
            duration: 150,
          },
        );
        const dismiss = () => {
          if ($toast.parentElement !== this) return;
          DomUtils.removeFromDom($toast);
        };
        if ($toast instanceof Toast) {
          $toast.onClickClose = dismiss;
        }
        return {
          id,
          dismiss,
        };
      }

      private showGrouped(
        id: string,
        $toast: HTMLElement,
        group: string,
      ): Persistent.Handle {
        const existingGroup = this.groups.get(group);

        if (existingGroup) {
          const activeToast = existingGroup.toasts[existingGroup.activeIndex];
          if (activeToast) {
            activeToast.$toast.style.display = "none";
          }

          existingGroup.toasts.push({ id, $toast });
          existingGroup.activeIndex = existingGroup.toasts.length - 1;

          existingGroup.$wrapper.insertBefore($toast, existingGroup.$dots);
          this.updateGroupDots(group);
        } else {
          const $wrapper = document.createElement("std-col");
          $wrapper.classList.add("group-wrapper");
          $wrapper.assignStyles({
            alignItems: "center",
          });

          const $dots = PageIndiciatorDots.make();
          $dots.style.display = "none";
          $dots.onChange = (index) => this.navigateToToast(group, index);

          $wrapper.appendChild($toast);
          $wrapper.appendChild($dots);
          this.appendChild($wrapper);

          $wrapper.animate(
            SimpleKeyframe.builder().slideIn(0, 20).fadeIn().build(),
            {
              duration: 150,
            },
          );

          const groupState: GroupState = {
            toasts: [{ id, $toast }],
            activeIndex: 0,
            $wrapper,
            $dots,
          };
          this.groups.set(group, groupState);
        }

        if ($toast instanceof Toast) {
          $toast.onClickClose = () => this.dismissFromGroup(id, group);
        }

        return {
          id,
          dismiss: () => this.dismissFromGroup(id, group),
        };
      }

      private dismissFromGroup(id: string, group: string): void {
        const groupState = this.groups.get(group);
        if (!groupState) return;

        const toastIndex = groupState.toasts.findIndex((t) => t.id === id);
        if (toastIndex === -1) return;

        const entry = groupState.toasts[toastIndex];
        DomUtils.removeFromDom(entry.$toast);
        groupState.toasts.splice(toastIndex, 1);

        if (groupState.toasts.length === 0) {
          DomUtils.removeFromDom(groupState.$wrapper);
          this.groups.delete(group);
          return;
        }

        if (groupState.activeIndex >= groupState.toasts.length) {
          groupState.activeIndex = groupState.toasts.length - 1;
        } else if (toastIndex < groupState.activeIndex) {
          groupState.activeIndex--;
        } else if (toastIndex === groupState.activeIndex) {
          groupState.activeIndex = Math.min(
            groupState.activeIndex,
            groupState.toasts.length - 1,
          );
        }

        const newActiveToast = groupState.toasts[groupState.activeIndex];
        if (newActiveToast) {
          newActiveToast.$toast.style.display = "";
        }

        this.updateGroupDots(group);
      }

      private updateGroupDots(group: string): void {
        const groupState = this.groups.get(group);
        if (!groupState) return;

        const { toasts, activeIndex, $dots } = groupState;

        if (toasts.length <= 1) {
          $dots.style.display = "none";
          return;
        }

        $dots.style.display = "";
        $dots.bind(activeIndex, toasts.length);
        $dots.onChange = (index) => this.navigateToToast(group, index);
      }

      private navigateToToast(group: string, index: number): void {
        const groupState = this.groups.get(group);
        if (!groupState) return;
        if (index === groupState.activeIndex) return;
        if (index < 0 || index >= groupState.toasts.length) return;

        const currentToast = groupState.toasts[groupState.activeIndex];
        if (currentToast) {
          currentToast.$toast.style.display = "none";
        }

        groupState.activeIndex = index;
        const newToast = groupState.toasts[index];
        if (newToast) {
          newToast.$toast.style.display = "";
        }
      }

      static $styles: Style.Compat[] = [
        css`
          :host {
            position: fixed;
            bottom: calc(-1 * var(--toaster-offset, -20px) - var(--additional-toaster-bottom, 0px));
            right: 0px;
            z-index: 7000; /* ZIndex.TOAST */
            width: 320px;
          }

          #root {
            transform: translate(calc(var(--toaster-offset, -20px)), 0px);
            gap: 4px;
          }
        `,
      ];
      static $html: Option<HTMLTemplateElement> = html`
        <std-col id=root>
          <slot></slot>
        </std-col>
      `;
    }
  }
}
