import "./modal-close-button/modal-close-button";

import { LonaWebComponent, html } from "../component";
import { ModalCloseButton } from "./modal-close-button/modal-close-button";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { LonaModalWebComponent } from "../ui/modal-component";
import { Focus } from "../ui/focus";
import { Typography } from "../ui/typography";
import { Overlay } from "./overlay";

// A surface that comes up from the bottom edge, owes the reader a read, and
// goes back down.
//
// The motion is the product's, not this component's invention: a panel that
// wants your attention rises from the bottom everywhere in Lona. What this file
// is for is that there were already TWO of them and neither could be reused.
// `lona-subscription-drawer` is a bottom sheet welded to plan options, auth and
// a logout; the ux-tests console hand-rolled a second one — a fixed host, a
// scrim, a sheet, a grip, a header, a close button and about seventy lines of
// stylesheet — because the first one is a subscription drawer rather than a
// sheet. Two independent copies of one shape, agreeing on nothing they did not
// have to.
//
// WHAT IS IN HERE is the part both copies got right and any third would have to
// rediscover — and two of those are traps rather than choices:
//
//   - **A transition only runs from a style the element has already been laid
//     out with.** Revealing and animating in one frame paints the sheet at its
//     final position with no motion at all, and reads as a CSS bug for as long
//     as it takes to find. `open` forces the layout between the two writes.
//   - **The hide is on a timer, not `transitionend`.** A sheet closed while the
//     tab is backgrounded never fires one — transitions are throttled — and the
//     host stays over the page as an invisible click-eater.
//   - `pointer-events: none` on the host with `auto` on its two children, so a
//     closing sheet stops eating clicks the moment it starts leaving rather
//     than when it arrives.
//   - the three exits a sheet owes: the scrim, the close button, and Escape.
//   - **The close button owns a corner, and the content is inset from it.**
//     `std-modal-close-button` is built to FLOAT over a modal's scroller, with
//     a shadow that appears once content scrolls under it. In a sheet the title
//     row runs the full width, so a floating button sat on top of the title. The
//     button is pinned to the end of the title row instead, flat, and the row
//     reserves `--sheet-safe-area-inset-end` for it. The inset is also
//     inherited by slotted content, so a caller whose content reaches the top
//     edge can keep clear of the button the same way.
//
// TWO OPT-IN MODES, for a sheet that lives on the page rather than visiting it
// (the review miniapp's approval sheet, which had grown a private copy of this
// whole component to get them):
//
//   - **peek**: the sheet never hides. Closed, it is pushed down until only the
//     grip and the `peek` slot show, a bar along the bottom edge; open, it rises
//     to its full height. The title row is not drawn — the peek content is the
//     sheet's identity. The visible strip is measured and published as
//     --sheet-peek-height (and `onPeekHeight`), so the page can keep its last
//     line clear of it.
//   - **drag-dismiss**: a drag down on an open sheet follows the pointer and,
//     past 30% of the sheet's height or at a flick (>0.6 px/ms), dismisses it;
//     otherwise it settles back. A drag that starts in a field, a button
//     component, or a scroller that can scroll is left to that element, and the
//     click a drag would land is swallowed.
//
// Without either attribute the sheet behaves as before: hidden until
// presented, and the grip is a glyph, not a handle. One change applies to every
// sheet: a raised sheet's scrim now swallows wheel and overscroll, so the page
// under it no longer scrolls while it is up.
//
// Content arrives through SLOTS and stays in the caller's light DOM under the
// caller's own stylesheet — the `std-section-head` contract, for the reason
// recorded there: an adopted element lands in this shadow root where the
// caller's sheet cannot follow, and every such element degenerates into inline
// styles.

@component({ name: "std-bottom-sheet" })
export class BottomSheet extends LonaModalWebComponent {
  private modalProps: Option<BottomSheet.Props>;
  private $panel: HTMLElement = this.$("modal-panel");
  private $handle: HTMLElement = this.$("modal-handle");
  private $modalBody: HTMLElement = this.$("modal-body");
  private $modalClose: ModalCloseButton = this.hydrate("modal-close");
  private snap = 0;
  private modalOverlay: Option<Overlay>;
  private modalCallback: Option<EmptyFunction>;
  private invoker: Option<HTMLElement>;
  private entryFrame: Option<number>;
  private modalGeneration = 0;
  private modalBinding = 0;
  private recycleAfter = 0;
  private clearDrag: EmptyFunction = () => {};
  private $sheet: HTMLElement = this.$("sheet");
  private $scrim: HTMLElement = this.$("scrim");
  private $body: HTMLElement = this.$("body");
  private $close: ModalCloseButton = this.hydrate("close");

  /** Pending hide, so a reopen mid-slide cannot blank the sheet under itself. */
  private hideTimer: Option<number> = null;
  private open_: boolean = false;
  private $peek: HTMLElement = this.$("peek");
  /** The strip a peek sheet shows when closed, in px; 0 for a modal sheet. */
  private peekPx = 0;
  private readonly peekObserver = new ResizeObserver(() => this.measurePeek());

  /** Dismissed — by the scrim, the close button or Escape. The sheet has
   * already started leaving; this is where a caller syncs whatever opened it. */
  onDismiss: () => void = () => {};

  /** A peek sheet's visible strip changed height (px, without the safe-area
   * inset). The page reserves this much room under its last line. */
  onPeekHeight: (px: number) => void = () => {};

  constructor() {
    super();
    this.$scrim.addEventListener("click", () => this.dismissSlot());
    let startHeight = 0;
    let dragBinding = 0;
    GESTURE_MANAGER.addDragGesture(this.$handle, "std-bottom-sheet", {
      onPointerDown: () => {
        if (!this.modalProps) return;
        dragBinding = this.modalBinding;
        startHeight = this.$panel.getBoundingClientRect().height;
        this.toggleAttribute("dragging", true);
      },
      onPointerMove: e => {
        if (this.modalProps && dragBinding === this.modalBinding) this.$panel.style.height = `${Math.max(0, startHeight + e.progress.y)}px`;
      },
      onPointerUp: e => {
        if (!this.modalProps || dragBinding !== this.modalBinding) return;
        this.removeAttribute("dragging");
        this.settle(startHeight + e.progress.y, -e.progress.y);
      },
    });
    this.$panel.addEventListener("keydown", e => this.onModalKeydown(e));
    // The page behind a raised sheet does not scroll under the scrim.
    this.$scrim.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    this.attachDrag();
    // No `scrollSource`: that is what gives the button its shadow, and the
    // shadow is for a button that floats over scrolling content. This one sits
    // in a row of its own, and the body scrolls below it.
    this.$close.bind({ onDismiss: () => this.dismissSlot() });
    // On the host, not the document: a listener that outlives every sheet on
    // the page is one the page cannot see and cannot remove.
    // Handled means consumed: a page that also binds Escape (to leave the
    // view, say) sees defaultPrevented and lets this press be the sheet's.
    this.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape" || !this.open_) return;
      e.preventDefault();
      this.dismissSlot();
    });
  }

  /**
   * Hidden until presented — applied on CONNECT, not in the constructor.
   *
   * `this.style.display = "none"` writes the `style` attribute, and the
   * custom-element contract forbids a constructor from putting attributes on
   * its host: `document.createElement("std-bottom-sheet")` — which is what
   * `make()` is — throws NotSupportedError ("the result must not have
   * attributes"). A page that built its sheet at module top level died on that
   * line before it drew anything. Presenting still flips the same inline
   * property, so nothing about open/dismiss changes.
   */
  connectedCallback(): void {
    super.connectedCallback();
    if (this.modalProps) return;
    if (!this.open_ && !this.peeks) this.style.display = "none";
    // A folded body is off screen; keep it out of the tab order.
    this.$body.inert = this.peeks && !this.open_;
    this.peekObserver.observe(this.$peek);
    this.peekObserver.observe(this.$sheet);
  }

  disconnectedCallback(): void {
    this.cancelEntryFocus();
    this.clearDrag();
    this.peekObserver.disconnect();
    const overlay = this.modalOverlay;
    if (overlay?.isRevealed(this)) this.dismiss(overlay);
    super.disconnectedCallback();
  }

  /** Whether this sheet folds to a bar instead of hiding (the `peek` attribute). */
  get peeks(): boolean {
    return this.hasAttribute("peek");
  }

  /** The closed strip's height in px; 0 unless `peek`. */
  get peekHeight(): number {
    return this.peekPx;
  }

  /** The strip from the sheet's top edge to the bottom of the peek slot, plus
   * the same gap the sheet keeps between its rows. */
  private measurePeek(): void {
    if (!this.peeks) return;
    const gap = parseFloat(getComputedStyle(this.$sheet).rowGap) || 0;
    const px = Math.ceil(this.$peek.offsetTop + this.$peek.offsetHeight + gap);
    if (px === this.peekPx) return;
    this.peekPx = px;
    this.style.setProperty("--sheet-peek-height", `${px}px`);
    this.onPeekHeight(px);
  }

  get isOpen(): boolean {
    return this.modalProps ? (this.modalOverlay?.isRevealed(this) ?? false) : this.open_;
  }

  /**
   * Raise the sheet.
   *
   * `maxHeightPx` is the caller's business because the bound is: a sheet grows
   * UPWARD from the bottom edge, so the only thing between a long body and
   * whatever sits at the top of the page is this number. The caller is the one
   * that knows where its own header ends.
   */
  open(maxHeightPx?: number): void {
    if (this.modalOverlay?.isRevealed(this) || performance.now() < this.recycleAfter) {
      throw new Error("Close the active modal presentation before opening the slot sheet");
    }
    this.modalBinding++;
    this.modalProps = null;
    this.cancelEntryFocus();
    this.removeAttribute("presentation");
    for (const attribute of ["role", "aria-modal", "aria-label"]) this.removeAttribute(attribute);
    DomUtils.clearChildren(this.$modalBody);
    if (this.isConnected) { this.peekObserver.observe(this.$peek); this.peekObserver.observe(this.$sheet); }
    if (this.hideTimer != null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (maxHeightPx != null) {
      this.$sheet.style.maxHeight = `${Math.round(maxHeightPx)}px`;
    }
    this.style.display = "";
    // The layout the transition needs a starting style from. Removing this line
    // does not break the sheet — it removes the animation, silently.
    void this.$sheet.offsetHeight;
    this.toggleAttribute("visible", true);
    this.open_ = true;
    this.$body.inert = false;
    // Focus the sheet so Escape reaches the host listener without the caller
    // having to own a document-level one.
    this.$sheet.focus({ preventScroll: true });
  }

  /** Lower it. Idempotent, and safe to call on a sheet that never opened. */
  close(): void {
    if (this.modalProps) { this.dismiss(); return; }
    if (!this.open_) {
      if (!this.peeks) this.style.display = "none";
      return;
    }
    this.toggleAttribute("visible", false);
    this.open_ = false;
    if (this.peeks) {
      this.$body.inert = true;
      return;
    }
    this.hideTimer = window.setTimeout(() => {
      this.style.display = "none";
      this.hideTimer = null;
    }, BottomSheet.TRANSITION_MS);
  }

  /** The scroller, for a caller that wants to reset it between binds. */
  get $scroller(): HTMLElement {
    return this.modalProps ? this.$modalBody : this.$body;
  }

  onRecycle(): void {
    this.onModalDismiss();
    this.modalBinding++;
    this.modalProps = null;
    this.snap = 0;
    this.modalOverlay = null;
    this.invoker = null;
    this.clearDrag();
    this.peekObserver.disconnect();
    this.peekPx = 0;
    this.onDismiss = () => {};
    this.onPeekHeight = () => {};
    DomUtils.clearChildren(this.$modalBody);
    this.$panel.style.removeProperty("height");
    this.$sheet.style.removeProperty("max-height");
    this.$body.inert = false;
    for (const attribute of ["role", "aria-modal", "aria-label", "presentation", "dragging"]) this.removeAttribute(attribute);
    super.onRecycle();
    if (this.hideTimer != null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.open_ = false;
    this.style.display = "none";
    this.toggleAttribute("visible", false);
  }

  private dismissSlot(): void {
    if (this.modalProps || !this.open_) return;
    this.close();
    this.onDismiss();
  }

  /** The `drag-dismiss` gesture. Wired always, active only with the attribute,
   * so a caller can turn it on and off without rebinding. */
  private attachDrag(): void {
    let startY: Option<number> = null;
    let pointerId: Option<number> = null;
    let dy = 0;
    let dragging = false;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let clickTimer: Option<number>;
    const guard = (click: Event): void => { click.stopPropagation(); click.preventDefault(); };
    this.clearDrag = () => {
      if (pointerId != null && this.$sheet.hasPointerCapture(pointerId)) this.$sheet.releasePointerCapture(pointerId);
      pointerId = null;
      startY = null;
      dragging = false;
      this.toggleAttribute("dragging", false);
      this.$sheet.style.transform = "";
      this.$sheet.removeEventListener("click", guard, { capture: true });
      if (clickTimer != null) window.clearTimeout(clickTimer);
      clickTimer = null;
    };
    const ownsDrag = (path: EventTarget[]): boolean => {
      for (const node of path) {
        if (node === this.$sheet) return true;
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches("textarea, input, select, [contenteditable]:not([contenteditable=false]), std-button")) return false;
        // A list that can scroll keeps its own drag.
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) return false;
      }
      return false;
    };
    this.$sheet.addEventListener("pointerdown", (e) => {
      if (!this.open_ || !this.hasAttribute("drag-dismiss") || e.button !== 0) return;
      if (!ownsDrag(e.composedPath())) return;
      startY = e.clientY;
      pointerId = e.pointerId;
      // Capture the press before a mouse can jump outside this sheet. Touch
      // already captures implicitly; waiting for a move lost the mouse path.
      this.$sheet.setPointerCapture(e.pointerId);
      lastY = e.clientY;
      lastT = e.timeStamp;
      dy = 0;
      velocity = 0;
      dragging = false;
    });
    this.$sheet.addEventListener("pointermove", (e) => {
      if (startY == null) return;
      dy = Math.max(0, e.clientY - startY);
      if (!dragging && dy > 8) {
        dragging = true;
        this.$sheet.setPointerCapture(e.pointerId);
        this.toggleAttribute("dragging", true);
      }
      if (!dragging) return;
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;
      this.$sheet.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    });
    const end = (e: PointerEvent): void => {
      if (startY == null) return;
      startY = null;
      pointerId = null;
      if (!dragging) return;
      if (this.$sheet.hasPointerCapture(e.pointerId)) this.$sheet.releasePointerCapture(e.pointerId);
      const height = this.$sheet.getBoundingClientRect().height;
      // Both at once: the transition comes back on and the inline offset goes,
      // so the sheet moves from where the finger left it, not from the top.
      this.toggleAttribute("dragging", false);
      this.$sheet.style.transform = "";
      if (e.type !== "pointercancel" && (dy > height * 0.3 || velocity > 0.6)) this.dismissSlot();
      // The click this drag would land on a row or the bar. A touch drag makes
      // no click, so the guard is dropped again right after.
      this.$sheet.addEventListener("click", guard, { capture: true, once: true });
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        this.$sheet.removeEventListener("click", guard, { capture: true });
        dragging = false;
      }, 50);
    };
    this.$sheet.addEventListener("pointerup", end);
    this.$sheet.addEventListener("pointercancel", end);
  }

  /** Props binding selects the historical modal/snap presentation for this instance. */
  bind(props: BottomSheet.Props): this {
    if (!props.snapPoints.length || props.snapPoints.some(f => !Number.isFinite(f) || f <= 0 || f > 1) ||
        props.snapPoints.some((f, i) => i > 0 && f < props.snapPoints[i - 1]) || !Number.isFinite(props.initialSnap)) {
      throw new RangeError("BottomSheet requires ascending snap fractions in (0,1] and a finite initialSnap");
    }
    const overlay = this.modalOverlay;
    const revealed = overlay?.isRevealed(this) ?? false;
    // Rebinding a live modal keeps its Overlay placement. Starting an exit
    // animation here would let the previous queued animation hide the new bind.
    this.onModalDismiss();
    if (revealed) this.recycleAfter = 0;
    if (this.hideTimer != null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.open_ = false;
    this.clearDrag();
    this.peekObserver.disconnect();
    const binding = ++this.modalBinding;
    this.modalProps = props;
    this.snap = Math.min(Math.max(0, Math.trunc(props.initialSnap)), props.snapPoints.length - 1);
    this.setAttribute("presentation", "modal");
    this.style.display = "";
    this.toggleAttribute("visible", false);
    DomUtils.clearChildren(this.$modalBody);
    this.$modalBody.appendChild(props.$content());
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-modal", "true");
    this.setAttribute("aria-label", props.label);
    this.$modalClose.toggleAttribute("hidden", !props.dismissible);
    this.$modalClose.bind({ onDismiss: () => { if (binding === this.modalBinding && this.modalProps?.dismissible) this.dismiss(); } });
    this.$handle.setAttribute("aria-label", "Resize sheet");
    this.$panel.tabIndex = -1;
    this.applySnap();
    if (revealed) this.reveal(overlay!);
    return this;
  }

  private fraction(index: number): number { return this.modalProps?.snapPoints[index] ?? 0.5; }
  private applySnap(): void { this.$panel.style.height = `${Math.round(this.fraction(this.snap) * window.innerHeight)}px`; }
  private settle(heightPx: number, dragDownPx: number): void {
    const props = this.modalProps;
    if (!props) return;
    if (props.dismissible && (heightPx < this.fraction(0) * window.innerHeight * 0.6 || dragDownPx > 160)) { this.dismiss(); return; }
    let best = 0;
    for (let i = 1; i < props.snapPoints.length; i++) {
      if (Math.abs(props.snapPoints[i] * window.innerHeight - heightPx) < Math.abs(props.snapPoints[best] * window.innerHeight - heightPx)) best = i;
    }
    this.snap = best;
    this.applySnap();
  }

  private focusables(): HTMLElement[] {
    const result: HTMLElement[] = [];
    const visit = (node: Element | ShadowRoot): void => {
      if (node instanceof HTMLElement) {
        const style = getComputedStyle(node);
        if (node.matches(":disabled, [disabled], [hidden], [inert]") || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return;
        // Some controls focus their host; others delegate into their shadow.
        // Retain both candidates and confirm which target actually takes focus.
        if (node.tabIndex >= 0 && node.getClientRects().length) result.push(node);
        if (node instanceof HTMLSlotElement) {
          const assigned = node.assignedElements({ flatten: true });
          if (assigned.length) { for (const child of assigned) visit(child); return; }
        }
      }
      for (const child of (node instanceof Element && node.shadowRoot ? node.shadowRoot : node).children) visit(child);
    };
    visit(this.$panel);
    return result;
  }

  private focusTarget(target: HTMLElement): boolean {
    target.focus({ preventScroll: true });
    return Focus.activeDeep() === target;
  }

  private onModalKeydown(e: KeyboardEvent): void {
    const props = this.modalProps;
    if (!props) return;
    if (Focus.activeDeep() === this.$handle && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (e.key === "ArrowUp") this.snap = Math.min(this.snap + 1, props.snapPoints.length - 1);
      else if (this.snap > 0) this.snap--;
      else if (props.dismissible) { e.preventDefault(); this.dismiss(); return; }
      this.applySnap();
      e.preventDefault();
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    const list = this.focusables();
    const active = Focus.activeDeep();
    const index = active == null ? -1 : list.indexOf(active);
    for (let step = 1; step <= list.length; step++) {
      const next = e.shiftKey ? ((index < 0 ? 0 : index) - step + list.length * 2) % list.length : (index + step) % list.length;
      if (this.focusTarget(list[next])) return;
    }
    this.focusTarget(this.$panel);
  }

  private cancelEntryFocus(): void {
    this.modalGeneration++;
    if (this.entryFrame != null) cancelAnimationFrame(this.entryFrame);
    this.entryFrame = null;
  }

  reveal(overlay: Overlay = Overlay.instance.get(), context: Option<string> = null, position: Option<Overlay.Position> = null): void {
    if (!this.modalProps) { super.reveal(overlay, context, position); return; }
    const props = this.modalProps;
    this.cancelEntryFocus();
    const generation = this.modalGeneration;
    this.modalOverlay = overlay;
    this.modalCallback = props.onDismiss;
    this.invoker = Focus.activeDeep();
    overlay.reveal(this, { onDismiss: () => this.onModalDismiss(), canDismiss: () => this.modalProps?.dismissible ?? false, position: position ?? Overlay.Position.bottom("0px") });
    overlay.setContext(context);
    this.entryFrame = requestAnimationFrame(() => {
      this.entryFrame = null;
      if (generation !== this.modalGeneration || !this.isConnected || !overlay.isRevealed(this)) return;
      const active = Focus.activeDeep();
      if (active && active !== this.invoker && !Focus.isLostOrWithin(this)) return;
      for (const target of this.focusables().filter(target => target !== this.$handle)) if (this.focusTarget(target)) return;
      this.focusTarget(this.$panel);
    });
  }

  dismiss(overlay: Overlay = this.modalOverlay ?? Overlay.instance.get()): void {
    if (!this.modalProps) { this.dismissSlot(); return; }
    overlay.dismiss(this);
  }

  onModalDismiss(): void {
    this.cancelEntryFocus();
    const callback = this.modalCallback;
    this.modalCallback = null;
    const invoker = this.invoker;
    this.invoker = null;
    if (callback || this.modalOverlay?.isRevealed(this)) this.recycleAfter = performance.now() + 350;
    if (invoker?.isConnected && Focus.isLostOrWithin(this)) invoker.focus({ preventScroll: true });
    callback?.();
  }

  // Overlay owns a 300ms removal animation. Keep that occupant out of the pool
  // until removal has settled so its old timer cannot remove a slot successor.
  static _recycle<T extends LonaWebComponent>(instance: T): void {
    if (instance instanceof BottomSheet && performance.now() < instance.recycleAfter) {
      window.setTimeout(() => this._recycle(instance), instance.recycleAfter - performance.now() + 1);
      return;
    }
    super._recycle(instance);
  }

  static makeWith(props: BottomSheet.Props): BottomSheet { return BottomSheet.make().bind(props); }
  static show(props: BottomSheet.Props): BottomSheet {
    const sheet = BottomSheet.makeWith(props);
    sheet.reveal();
    return sheet;
  }

  /** Kept in one place because the CSS and the hide timer must agree: a timer
   * shorter than the transition hides a sheet mid-slide. */
  static TRANSITION_MS = 260;

  static $styles = [
    Typography.$style,
    css`
      :host(:not([presentation="modal"])) #modal-panel { display: none; }
      :host([presentation="modal"]) #scrim, :host([presentation="modal"]) #sheet { display: none; }
    `,
    css`
      :host([presentation="modal"]) {
        position: relative;
        inset: auto;
        z-index: auto;
        pointer-events: auto;
        --bottom-sheet-bg: var(--bottom-sheet-bg-preset, var(--bg));
        --bottom-sheet-radius: 16px;
        --bottom-sheet-handle: var(--divider);

        display: block;
        width: 100%;
        max-width: none;
      }

      #modal-panel {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 100%;
        max-height: calc(100dvh - 24px);
        background: var(--bottom-sheet-bg);
        border-radius: var(--bottom-sheet-radius) var(--bottom-sheet-radius) 0 0;
        box-shadow: 0 -12px 40px color-mix(in srgb, var(--text-pri) 18%, transparent);
        transition: height 0.2s ease;
        outline: none;
        position: relative;
      }

      :host([dragging]) #modal-panel {
        transition: none;
      }

      #modal-handle {
        flex: none;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        touch-action: none;
        outline: none;
        border-radius: 12px;
      }

      #modal-handle::before {
        content: "";
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--bottom-sheet-handle);
      }

      #modal-handle:focus-visible {
        box-shadow: inset 0 0 0 2px var(--blue);
      }

      #modal-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0 16px 16px;
      }

      #modal-close {
        top: 8px;
        right: 8px;
      }

      #modal-close[hidden] {
        display: none;
      }

      @media (prefers-reduced-motion: reduce) {
        #modal-panel {
          transition: none;
        }
      }
    `,

    css`
      /* A VIEWPORT overlay. It is fixed rather than a child of anything,
         because a sheet has to escape whatever overflow its opener lives in. */
      :host {
        position: fixed;
        inset: 0;
        /* 6000 is ZIndex.OVERLAY, spelled rather than imported: a stylesheet
           cannot read the TypeScript scale, and an inline z-index written from
           the constructor would outrank every caller that wanted a different
           one. Change both together. */
        z-index: var(--sheet-z, 6000);
        pointer-events: none;
        /* The close button's footprint, and the inset the content keeps from
           it. The button is 28px (std-modal-close-button binds its icon at
           that size); the 8px is the gap between it and the title. Both are
           custom properties so a caller can read the inset from slotted
           content, which inherits it through the slot. */
        --sheet-close-size: 28px;
        --sheet-safe-area-inset-end: calc(var(--sheet-close-size) + 8px);
      }

      /* The scrim takes input only while the sheet is open. A peeking sheet
         keeps its host displayed when folded, and an always-on scrim there
         was an invisible pane over the page that ate every click and wheel. */
      #scrim {
        position: absolute;
        inset: 0;
        overscroll-behavior: contain;
        pointer-events: none;
        background: var(--sheet-scrim, light-dark(var(--black12), var(--black40)));
        opacity: 0;
        transition: opacity 0.26s ease;
      }

      :host([visible]) #scrim {
        opacity: 1;
        pointer-events: auto;
      }

      #sheet {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        margin: 0 auto;
        box-sizing: border-box;
        width: var(--sheet-width, min(760px, 100%));
        max-height: var(--sheet-max-height, 72vh);
        display: flex;
        flex-direction: column;
        padding: var(--sheet-padding, 8px 20px 22px);
        gap: 8px;
        background: var(--bg-elevated);
        border: 1px solid var(--sheet-border-color, var(--divider));
        border-bottom: none;
        border-top-left-radius: var(--sheet-radius, 14px);
        border-top-right-radius: var(--sheet-radius, 14px);
        box-shadow: 0 -10px 34px 2px light-dark(var(--black12), var(--black40));
        transform: translateY(100%);
        transition: transform 0.26s ease;
        pointer-events: auto;
        overflow: hidden;
        outline: none;
      }

      :host([visible]) #sheet {
        transform: translateY(0);
      }

      /* Peek: closed, only the grip and the peek strip show above the bottom
         edge (and the device's safe area); open, the whole sheet. */
      :host([peek]) #sheet {
        transform: translateY(
          calc(100% - var(--sheet-peek-height, 0px) - env(safe-area-inset-bottom, 0px))
        );
      }

      :host([peek][visible]) #sheet {
        transform: translateY(0);
      }

      :host([peek]) #head {
        display: none;
      }

      :host(:not([peek])) #peek {
        display: none;
      }

      #peek {
        flex: 0 0 auto;
        min-width: 0;
      }

      /* Following the finger: no easing between pointer moves. */
      :host([dragging]) #sheet {
        transition: none;
      }

      :host([drag-dismiss]) #grip,
      :host([drag-dismiss]) #peek {
        touch-action: none;
      }

      @media (prefers-reduced-motion: reduce) {
        #scrim,
        #sheet {
          transition: none;
        }
      }

      /* The grabber. Not interactive — see the file note — but it is the one
         glyph that says "this came up from the bottom and goes back down". */
      #grip {
        flex: 0 0 auto;
        align-self: center;
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--divider);
        margin-bottom: 2px;
      }

      :host([no-grip]) #grip {
        display: none;
      }

      /* The title row. It is at least as tall as the close button, so a sheet
         with no title still starts its body below the button, and its end
         padding is the safe area, so a long title ellipsizes before the
         button instead of running under it. */
      #head {
        flex: 0 0 auto;
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        min-height: var(--sheet-close-size);
        padding-inline-end: var(--sheet-safe-area-inset-end);
      }

      /* Pinned to the end of the title row. These override the button's own
         floating defaults (absolute at top: 16px, inline margins, a shadow):
         a rule in this tree outranks the button's :host rules. */
      #close {
        position: absolute;
        top: 50%;
        right: 0;
        margin: 0;
        transform: translateY(-50%);
        box-shadow: none;
      }

      /* A default, not a rule: ::slotted loses to any rule in the caller's own
         tree, which is the point of slotting rather than adopting. */
      slot[name="title"]::slotted(*) {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* The scroller is the BODY, not the sheet: the grip and the title stay
         put while a long read moves under them.

         A BLOCK, not a flex column. A flex child defaults to flex-shrink: 1,
         so in a body that has hit the sheet's max height every paragraph is
         squeezed a couple of pixels shorter than its own line instead of the
         body scrolling — the lines close up and the sheet quietly stops
         honouring the type ramp. Normal block flow is also what the ramp's
         margins are written for. */
      #body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      /* Paragraph breaks, in the type ramp's own currency.
         --margin-bottom is ADDED to the ramp's optical trim rather than
         replacing it, so this is 12px of space you can SEE, against a 13.75px
         line. Two things it does that a gap on the body does not:
           - it INHERITS, so a caller that wraps its paragraphs in a div gets
             the same breaks; a gap only separates the slot's own children;
           - it applies after the LAST paragraph too, so the trim's blank tail
             stops hanging below the scroll port and giving a body that fits
             three pixels of scroll.
         A default, not a rule: ::slotted loses to the caller's own sheet. */
      #body slot::slotted(*) {
        --margin-bottom: 12px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="modal-panel">
      <div id="modal-handle" role="separator" aria-orientation="horizontal" tabindex="0"></div>
      <div id="modal-body"></div>
      <std-modal-close-button id="modal-close"></std-modal-close-button>
    </div>

    <div id="scrim"></div>
    <div id="sheet" role="dialog" aria-modal="false" tabindex="-1">
      <div id="grip"></div>
      <div id="peek"><slot name="peek"></slot></div>
      <div id="head">
        <slot name="title"></slot>
        <std-modal-close-button id="close"></std-modal-close-button>
      </div>
      <div id="body"><slot></slot></div>
    </div>
  `;
}

export namespace BottomSheet {
  export type Props = {
    $content: () => HTMLElement;
    /** Fractions of the viewport height, ascending, e.g. [0.35, 0.9]. */
    snapPoints: number[];
    /** Index into `snapPoints`. */
    initialSnap: number;
    /** Escape, the backdrop, the close button, and a drag past the lowest point. */
    dismissible: boolean;
    onDismiss: Option<EmptyFunction>;
    label: string;
  };
}
