import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { ScrollAncestorObserver } from "../../scroll-utils";
import { Typography } from "../../ui/typography";
import { ZIndex } from "../../z-index";

// The element four sites already used, made a component. `std-tooltip` was an
// UNREGISTERED tag: a CSS rule in an opt-in sheet, shown by the PARENT's
// `:has(> std-tooltip):hover` — ambient CSS, which the charter forbids, and a
// `:has()` that Blink re-resolved against every adopting tree on each
// child-list change (avatar.ts carried a workaround for exactly that).
//
// Now it is an element that attaches to its parent. Drop it inside the
// trigger — a button, an anchor span — and on connect it listens to that
// parent for hover, focus and Escape, writes `aria-describedby` on it, and on
// show positions a fixed bubble against the parent's rect, tracking scroll
// through `ScrollAncestorObserver` (the `tracking-tooltip.ts` recipe, with its
// `#222` replaced by tokens). `position: fixed` escapes the parent's
// `overflow: hidden`, which the old absolute rule never did.
//
// Text arrives through `bind()`. Rich content arrives through the SLOT and
// stays in the caller's light DOM under the caller's own stylesheet — the
// turn bar's key/value grid keeps its classes — which is the section-head
// lesson: slot, never adopt.
@component({ name: "std-tooltip" })
export class Tooltip extends LonaWebComponent {
  private $bubble: HTMLElement = this.$("bubble");
  private $text: HTMLElement = this.$("text");
  private props: Option<Tooltip.Props>;
  private $trigger: Option<HTMLElement>;
  private showTimer: Option<number>;
  private observer: Option<ScrollAncestorObserver>;
  private shown = false;
  private static seq = 0;

  bind(props: Tooltip.Props): this {
    this.props = props;
    const text = props.text;
    this.$text.textContent = text ?? "";
    this.$text.toggleAttribute("hidden", text == null);
    this.setAttribute("placement", props.placement);
    if (this.shown) this.reposition();
    return this;
  }

  static makeWith(props: Tooltip.Props): Tooltip {
    return Tooltip.make().bind(props);
  }

  // The parent outlives this element and is not its own shadow, so the
  // listeners are installed on connect and removed on disconnect — the one
  // case the constructor rule does not cover.
  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("role", "tooltip");
    if (this.id === "") this.id = `std-tooltip-${++Tooltip.seq}`;
    const $t = this.parentElement;
    if ($t == null) return;
    this.$trigger = $t;
    $t.addEventListener("pointerenter", this.onEnter);
    $t.addEventListener("pointerleave", this.onLeave);
    $t.addEventListener("focusin", this.onFocusIn);
    $t.addEventListener("focusout", this.onLeave);
    $t.addEventListener("keydown", this.onKeydown);
    if (!$t.hasAttribute("aria-describedby")) $t.setAttribute("aria-describedby", this.id);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.hide();
    const $t = this.$trigger;
    if ($t != null) {
      $t.removeEventListener("pointerenter", this.onEnter);
      $t.removeEventListener("pointerleave", this.onLeave);
      $t.removeEventListener("focusin", this.onFocusIn);
      $t.removeEventListener("focusout", this.onLeave);
      $t.removeEventListener("keydown", this.onKeydown);
      if ($t.getAttribute("aria-describedby") === this.id) $t.removeAttribute("aria-describedby");
    }
    this.$trigger = null;
  }

  onRecycle(): void {
    super.onRecycle();
    this.hide();
    this.props = null;
    this.$text.textContent = "";
    this.$text.toggleAttribute("hidden", true);
  }

  private onEnter = (): void => {
    if (this.showTimer != null) return;
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null;
      this.show();
    }, this.props?.delayMs ?? 150);
  };

  private onFocusIn = (): void => this.show();

  private onLeave = (): void => this.hide();

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.hide();
  };

  private onViewport = (): void => this.reposition();

  private show(): void {
    if (this.shown || this.$trigger == null) return;
    this.shown = true;
    this.toggleAttribute("open", true);
    this.reposition();
    this.observer = new ScrollAncestorObserver(this.$trigger, this.onViewport);
    this.observer.observe();
    window.addEventListener("resize", this.onViewport);
  }

  private hide(): void {
    if (this.showTimer != null) {
      window.clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (!this.shown) return;
    this.shown = false;
    this.removeAttribute("open");
    this.observer?.unobserve();
    this.observer = null;
    window.removeEventListener("resize", this.onViewport);
  }

  private reposition(): void {
    const $t = this.$trigger;
    if ($t == null) return;
    const a = $t.getBoundingClientRect();
    const b = this.$bubble.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(this).getPropertyValue("--tooltip-margin")) || 6;
    let top: number;
    let left: number;
    switch (this.props?.placement ?? "top") {
      case "bottom":
        top = a.bottom + margin;
        left = a.left + a.width / 2 - b.width / 2;
        break;
      case "left":
        top = a.top + a.height / 2 - b.height / 2;
        left = a.left - margin - b.width;
        break;
      case "right":
        top = a.top + a.height / 2 - b.height / 2;
        left = a.right + margin;
        break;
      default:
        top = a.top - margin - b.height;
        left = a.left + a.width / 2 - b.width / 2;
    }
    // Stay on screen: a tooltip half off the edge tells the reader nothing.
    const pad = 4;
    left = Math.max(pad, Math.min(left, window.innerWidth - b.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - b.height - pad));
    // `position: fixed` resolves against the viewport ONLY until an ancestor
    // carries a transform, filter, perspective or paint containment — then
    // that ancestor is the containing block, and viewport coordinates land
    // wherever it happens to be. Every catalogue card is translated by the
    // grid, so this is not a corner case; the origin is subtracted out.
    const origin = this.fixedOrigin();
    this.$bubble.style.top = `${Math.round(top - origin.y)}px`;
    this.$bubble.style.left = `${Math.round(left - origin.x)}px`;
  }

  /** The viewport offset of the nearest ancestor that is a containing block
   * for fixed positioning, crossing shadow boundaries; zero when none is. */
  private fixedOrigin(): { x: number; y: number } {
    let $n: Option<Element> = this.$trigger;
    while ($n != null) {
      const cs = getComputedStyle($n);
      const contains =
        cs.transform !== "none" ||
        cs.perspective !== "none" ||
        cs.filter !== "none" ||
        cs.backdropFilter !== "none" ||
        /transform|perspective|filter/.test(cs.willChange) ||
        /paint|layout|strict|content/.test(cs.contain) ||
        (cs.containerType !== "" && cs.containerType !== "normal");
      if (contains) {
        const r = $n.getBoundingClientRect();
        return { x: r.left + $n.clientLeft, y: r.top + $n.clientTop };
      }
      const root = $n.getRootNode();
      $n = $n.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return { x: 0, y: 0 };
  }

  static $styles = [
    Typography.$style,
    css(`
      :host {
        --tooltip-bg: var(--tooltip-bg-preset, var(--bg-tooltip));
        --tooltip-color: var(--tooltip-color-preset, var(--fg-tooltip));
        --tooltip-margin: 6px;
        --tooltip-radius: 5px;
        --tooltip-max-width: 240px;
        --tooltip-padding: 4px 10px;

        /* No box of its own: the host sits inside the trigger and must not
           change the trigger's layout. */
        display: contents;
      }

      #bubble {
        position: fixed;
        top: 0;
        left: 0;
        z-index: ${ZIndex.TOOLTIP};
        box-sizing: border-box;
        width: max-content;
        max-width: var(--tooltip-max-width);
        padding: var(--tooltip-padding);
        border-radius: var(--tooltip-radius);
        background: var(--tooltip-bg);
        color: var(--tooltip-color);
        font-weight: normal;
        text-align: start;
        pointer-events: none;
        user-select: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.15s ease, visibility 0s linear 0.15s;
      }

      :host([open]) #bubble {
        opacity: 1;
        visibility: visible;
        transition-delay: 0s;
      }

      #text {
        --font-size: var(--small-size);
        --line-height-ratio: 1.3;
        --margin-top: 0px;
        --margin-bottom: 0px;
        white-space: normal;
        overflow-wrap: anywhere;
      }

      #text[hidden] {
        display: none;
      }

      @media (prefers-reduced-motion: reduce) {
        #bubble {
          transition: none;
        }
      }
    `),
  ];

  static $html = html`<div id="bubble"><p id="text" hidden></p><slot></slot></div>`;
}

export namespace Tooltip {
  // Preserve the parent-owned CSS API used by existing product stories.
  export const style = /* css */ `
    :has(> std-tooltip):is(:hover, :focus-visible, :active) > std-tooltip {
      opacity: 1;
      transition-delay: 150ms;
    }

    std-tooltip {
      pointer-events: none;
      user-select: none;
      opacity: 0;

      height: fit-content;
      position: absolute;
      z-index: 1;
      inline-size: max-content;
      text-align: start;
      font-size: 0.775rem;
      font-weight: normal;
      line-height: initial;
      margin: 0;
      border-radius: 5px;
      color: var(--fg-tooltip);
      padding: 4px 12px;

      background: var(--bg-tooltip);
      bottom: calc(100% + var(--std-tooltip-margin, 4px));
      transition: opacity 0.3s ease;
    }

    std-tooltip[position=right] {
      bottom: unset;
      left: calc(100% + var(--std-tooltip-margin, 4px));
      top: 0px;
    }

    std-tooltip[position=left-overlap] {
      bottom: unset;
      left: 0px;
      top: 0px;
    }

    std-tooltip[position=right-overlap] {
      bottom: unset;
      right: 0px;
      top: 0px;
    }

    std-tooltip[position=bottom] {
      bottom: 0px;
      top: calc(100% + var(--std-tooltip-margin, 4px));
    }

    std-tooltip[position=left] {
      bottom: 0px;
      right: calc(100% + var(--std-tooltip-margin, 4px))
    }
  `;

  export const $style = css(style);


  export type Placement = "top" | "bottom" | "left" | "right";
  export type Props = {
    /** The description. `null` when the slotted content is the whole tooltip. */
    text: Option<string>;
    placement: Placement;
    /** Hover delay; focus shows immediately. Default 150ms. */
    delayMs: Option<number>;
  };

  /** For a CSS-only caption on a control carrying a `tooltip` attribute —
   * the `attr(tooltip)` pattern the date and time pickers use. Unchanged. */
  export const mixin = `
    content: attr(tooltip);
    position: absolute;
    pointer-events: none;
    background-color: var(--bg-tooltip);
    color: var(--fg-tooltip);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    width: max-content;
  `;
}
