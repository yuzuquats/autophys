import "../round";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Position } from "../../anchor-positioning-utils";
import { Focus } from "../../ui/focus";
import { Anchor } from "../anchor";
import { Round } from "../round";
import { $$ } from "../../fastdom";

// The surface over `Anchor.reveal`, which finally restores focus.
//
// `Anchor.reveal` is the floating machinery — body escape, scroll tracking,
// click-outside, Escape, z-index — and every popover in the tree built its own
// surface on it and inherited the same gap: on dismiss, focus went nowhere
// (R8). `std-popover` is the surface: an elevated `std-round` background,
// padding, an optional arrow, and a `static show()` that wraps the reveal,
// records `document.activeElement` before it, moves focus into the content,
// and puts it back on EVERY dismiss path — Escape, click-outside, and the
// caller's own `dismiss()` all run through the one `onDismiss` the reveal
// fires.
//
// `role` is `dialog` with a label for a popover the user works in, `none` for
// a passive card whose content speaks for itself.
@component({ name: "std-popover" })
export class Popover extends LonaWebComponent {
  private $bg: Round = this.hydrate("bg");
  private $body: HTMLElement = this.$("body");
  private $arrow: HTMLElement = this.$("arrow");
  private dismissReveal: Option<EmptyFunction>;
  private entryFocusTask: Option<EmptyFunction>;

  private retireReveal(): void {
    if (this.entryFocusTask != null) $$.clear(this.entryFocusTask);
    this.entryFocusTask = null;
    const dismiss = this.dismissReveal;
    this.dismissReveal = null;
    dismiss?.();
  }

  disconnectedCallback(): void {
    this.retireReveal();
    super.disconnectedCallback();
  }

  bind(props: Popover.Props): this {
    this.retireReveal();
    this.$bg.bind({ ...Round.Props.MODAL, bg: "var(--popover-bg)" });
    DomUtils.clearChildren(this.$body);
    this.$body.appendChild(props.$content());
    if (props.role === "dialog") {
      this.setAttribute("role", "dialog");
      if (props.label != null) this.setAttribute("aria-label", props.label);
      else this.removeAttribute("aria-label");
    } else {
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
    }
    this.$arrow.toggleAttribute("hidden", !props.arrow);
    // Focusable as a whole, so focus has somewhere to land that is inside the
    // popover even when the content has no control of its own.
    this.tabIndex = -1;
    return this;
  }

  onRecycle(): void {
    this.retireReveal();
    super.onRecycle();
    DomUtils.clearChildren(this.$body);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
    this.$arrow.toggleAttribute("hidden", true);
  }

  static makeWith(props: Popover.Props): Popover {
    return Popover.make().bind(props);
  }

  /** Reveal against an anchor; returns the handle that dismisses it. Focus
   * moves into live content after attachment and returns to the invoker on dismiss. */
  static show(props: Popover.Props & { $anchor: HTMLElement }): Popover.Handle {
    const $popover = Popover.makeWith(props);
    // The DEEP active element: inside a shadow-rooted page,
    // `document.activeElement` is the outermost host, which cannot take focus back.
    const $invoker = Focus.activeDeep() ?? props.$anchor;
    let dismissed = false;
    const instance = Anchor.reveal({
      $anchor: props.$anchor,
      $content: $popover,
      position: props.placement ?? Position.BOTTOM_CENTER,
      escapeContainer: true,
      dismissOnClickOutside: true,
      onDismiss: () => {
        if (dismissed) return;
        dismissed = true;
        $popover.retireReveal();
        // Restore only if focus is still ours (or lost to the body): a caller
        // that moved focus elsewhere on purpose keeps its decision.
        if (Focus.isLostOrWithin($popover)) $invoker.focus();
        props.onDismiss?.();
      },
    });
    $popover.dismissReveal = instance.dismiss;
    $popover.entryFocusTask = $$.mutateEnd(() => {
      $popover.entryFocusTask = null;
      if (dismissed || !$popover.isConnected || props.role !== "dialog") return;
      // A caller moving focus during attachment keeps that choice.
      const $active = Focus.activeDeep();
      if ($active != null && $active !== $invoker && !Focus.isLostOrWithin($popover)) return;
      const visit = ($root: Element | ShadowRoot): boolean => {
        for (const $child of $root.children) {
          if (!($child instanceof HTMLElement)) continue;
          const style = getComputedStyle($child);
          if ($child.matches(':disabled, [disabled], [hidden], [inert]') ||
            style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") continue;
          if ($child instanceof HTMLSlotElement) {
            const assigned = $child.assignedElements({ flatten: true });
            // Visit assigned roots themselves, preserving their unavailable ancestry.
            for (const $assigned of assigned) {
              if (focusElement($assigned)) return true;
            }
            if (assigned.length === 0 && visit($child)) return true;
          } else if (focusElement($child)) return true;
        }
        return false;
      };
      const focusElement = ($element: Element): boolean => {
        if (!($element instanceof HTMLElement)) return false;
        const style = getComputedStyle($element);
        if ($element.matches(':disabled, [disabled], [hidden], [inert]') ||
          style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        if ($element.tabIndex >= 0 && $element.getClientRects().length > 0) {
          $element.focus();
          if (Focus.activeDeep() === $element) return true;
        }
        return visit($element.shadowRoot ?? $element);
      };
      if (!visit($popover.shadowRoot!)) $popover.focus();
    });
    return {
      $popover,
      dismiss: () => instance.dismiss(),
      updatePosition: () => instance.updatePosition(),
    };
  }

  static $styles = [
    css`
      :host {
        --popover-bg: var(--popover-bg-preset, var(--bg-elevated));
        --popover-padding: var(--popover-padding-preset, 8px);
        --popover-radius: 12px;
        --popover-max-width: 360px;

        display: block;
        position: relative;
        width: max-content;
        max-width: var(--popover-max-width);
        outline: none;
      }

      #bg {
        position: absolute;
        inset: 0;
        border-radius: var(--popover-radius);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      }

      #body {
        position: relative;
        padding: var(--popover-padding);
      }

      #arrow {
        position: absolute;
        top: -5px;
        left: calc(50% - 5px);
        width: 10px;
        height: 10px;
        transform: rotate(45deg);
        background: var(--popover-bg);
        border-radius: 2px;
      }

      #arrow[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`
    <std-round id="bg" floating></std-round>
    <div id="arrow" hidden></div>
    <div id="body"></div>
  `;
}

export namespace Popover {
  export type Props = {
    $content: () => HTMLElement;
    /** `dialog` for a popover the user works in; `none` for a passive card. */
    role: "dialog" | "none";
    label: Option<string>;
    /** A `Position` strategy from anchor-positioning-utils; default below, centred. */
    placement: Option<Position>;
    arrow: boolean;
    onDismiss: Option<EmptyFunction>;
  };
  export type Handle = {
    $popover: Popover;
    dismiss: EmptyFunction;
    updatePosition: EmptyFunction;
  };
}
