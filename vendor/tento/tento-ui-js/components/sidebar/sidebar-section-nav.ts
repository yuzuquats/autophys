import { LonaModalHeader } from "../../ui/modal-header-styles";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";
import { SidebarSection } from "./sidebar-section";
import { Div } from "../../component-builtin";
import { Typography } from "../../ui/typography";

@component({ name: "std-sidebar-section-nav" })
export class SidebarSectionNav extends LonaWebComponent {
  private iconHoverEnterHandler: Option<() => void> = null;
  private iconHoverLeaveHandler: Option<() => void> = null;

  $title: Option<HTMLElement>;
  $cta: Option<HTMLElement>;
  $icon: Option<HTMLElement>;

  /** Independently positioned header contents for a section's shared FLIP. */
  get $layoutElements(): HTMLElement[] {
    return [this.$("nav-content"), this.$("back-button"), ...(this.$cta ? [this.$cta] : [])];
  }

  bindAccessory(cta: Option<SidebarSectionNav.Cta>): void {
    this.$cta && DomUtils.removeFromDom(this.$cta);
    this.$cta = cta?.$element;

    if (!cta) return;

    cta.$element.slot = "accessory";
    this.appendChild(cta.$element);
    GESTURE_MANAGER.addPointerEvent(cta.$element, {
      onClick: cta.onClick,
    });
  }

  setCallbacks(callbacks: SidebarSectionNav.Callbacks): SidebarSectionNav {
    callbacks.onNavContentClick &&
      GESTURE_MANAGER.addPointerEvent(this.$("nav-content"), {
        onClick: callbacks.onNavContentClick,
      });
    this.toggleAttribute(
      "nav-content-clickable",
      callbacks.onNavContentClick != null,
    );
    callbacks.onBackButtonClick &&
      GESTURE_MANAGER.addPointerEvent(this.$("back-button"), {
        onClick: () => {
          if (!this.hasAttribute("back-button-shown")) return;
          callbacks?.onBackButtonClick?.();
        },
      });
    return this;
  }

  bind(
    label: string,
    $icon: Option<HTMLElement>,
    callbacks?: SidebarSection.Callbacks,
  ): SidebarSectionNav {
    this.$title && DomUtils.removeFromDom(this.$title);

    this.$icon && DomUtils.removeFromDom(this.$icon);
    this.$icon = $icon;

    this.style.display = "block";

    this.$title = SidebarSection.$makeTitle(label);
    this.$title.slot = "title";
    this.appendChild(this.$title);

    // Remove old icon hover handlers before adding new ones
    if (this.iconHoverEnterHandler) {
      this.removeEventListener("pointerenter", this.iconHoverEnterHandler);
      this.iconHoverEnterHandler = null;
    }
    if (this.iconHoverLeaveHandler) {
      this.removeEventListener("pointerleave", this.iconHoverLeaveHandler);
      this.iconHoverLeaveHandler = null;
    }

    if ($icon) {
      $icon.slot = "icon";
      this.iconHoverEnterHandler = () => $icon.toggleAttribute("hover", true);
      this.iconHoverLeaveHandler = () => $icon.toggleAttribute("hover", false);
      this.addEventListener("pointerenter", this.iconHoverEnterHandler);
      this.addEventListener("pointerleave", this.iconHoverLeaveHandler);
      this.appendChild($icon);
    }

    this.setCallbacks(callbacks ?? {});
    return this;
  }

  /** A title with a caption under it, in the title slot.
   *
   *  Every modal that wanted this built the same `.lona-modal-header` std-col
   *  with an h1 and a p by hand and slotted it in (settings, the scheduling
   *  links sidebar, the add-host modal). This is that block, built once. The
   *  sizes come from LonaModalHeader's knobs, so a caller sets
   *  `--modal-header-title-size` on this element to take the title down a
   *  step and touches nothing else.
   *
   *  Strings become the h1 and p; an element is placed as given, for a caller
   *  that needs the title or the caption to be a link.
   *
   *  The block is this element's LIGHT-DOM child, so the rules in this shadow
   *  root do not reach its h1 and p -- the caller's stylesheet does. Include
   *  LonaModalHeader.$style in the caller's $styles, as every hand-built
   *  header already did; without it the block renders at the page's h1/p. */
  bindHeader(header: SidebarSectionNav.Header): SidebarSectionNav {
    this.$title && DomUtils.removeFromDom(this.$title);
    const $block = Div.make();
    $block.className = "lona-modal-header";
    $block.slot = "title";
    $block.assignStyles({ display: "flex", flexDirection: "column" });

    // Strings go through Typography, like every other ramp element: it owns
    // the tag and the size class, and it refuses to stringify a node.
    const $title =
      typeof header.title === "string" ? Typography.h1(header.title) : header.title;
    $block.appendChild($title);

    if (header.caption != null) {
      const $caption =
        typeof header.caption === "string" ? Typography.p(header.caption) : header.caption;
      $block.appendChild($caption);
    }

    this.$title = $block;
    this.appendChild($block);
    this.style.display = "block";
    return this;
  }

  toggleBackButton(showBackButton: boolean, animate: boolean) {
    this.style.setProperty(
      "--std-sidebar-section-transition-duration",
      animate ? "0.3s" : "0s",
    );
    this.toggleAttribute("back-button-shown", showBackButton);
  }

  toggleActive(force: boolean, animate: boolean) {
    this.style.setProperty(
      "--std-sidebar-section-transition-duration",
      animate ? "0.3s" : "0s",
    );
    this.toggleAttribute("active", force);
  }

  static $styles = [
    Button.$style,
    LonaModalHeader.$style,
    css`
      :host {
        display: block;
      }

      * {
        transition-property: transform, opacity;
        transition-duration: var(--std-sidebar-section-transition-duration, 0.3s);
        transition-timing-function: ease;
      }

      :host([layout-flip]) * {
        /* FLIP owns position; the back button can still fade into view. */
        transition-property: opacity;
      }

      #nav-button-container {
        flex-grow: 1;
        width: 100%;
        align-self: stretch;
        align-items: start;
        justify-content: start;
        padding: 0px;
        /* A flex item's default min-width:auto floors this at its min-content —
           which includes the slotted title's text — so when the row runs out of
           room the ACCESSORY was pushed out of the nav rather than the title
           giving way. MEASURED in ux-tests.node at a 499px nav: a 252px
           accessory landed at 596-848 against a right edge of 800. Zero lets
           the title shrink instead (measured: it WRAPS onto more lines; nothing
           on the title path declares an ellipsis), and cannot bind when there
           is room, so no consumer that fits today moves.
           (No backticks in this comment: one would end the css template.) */
        min-width: 0;
      }

      #back-button {
        opacity: 0;
        padding: 4px;
        align-self: start;
        margin-inline: 4px;
        margin-block: var(--back-btn-margin-block, 2px);
        background: transparent;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        color: inherit;
      }

      :host([back-button-shown]) #back-button:hover {
        background: var(--bg-hover);
      }

      #back-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #nav-content {
        min-width: 100%;
        border-radius: 8px;
        min-height: 100%;
      }

      :host([nav-content-clickable]) #nav-content:hover {
        background: var(--bg-hover);
        cursor: pointer;
      }

      #back-button,
      #nav-content {
        transform: translateX(-40px);
      }

      :host([back-button-shown]) #nav-content {
        transform: translateX(
          calc(
            var(--back-btn-margin-left, 0px) +
              var(--nav-content-revealed-offset, 0px)
          )
        );
        min-width: calc(100% - 40px);
        width: calc(100% - 40px);
        opacity: 1;
      }

      :host([back-button-shown]) #back-button {
        transform: translateX(var(--back-btn-margin-left, 0px));
        opacity: 1;
        margin-right: 1px;
      }

      slot[name="icon"]::slotted(*) {
        align-self: center;
        margin-left: 8px;
      }

      slot[name="accessory"]::slotted(*) {
        flex-shrink: 0;
        align-self: center;
        margin-inline: 8px;
      }
    `,
  ];
  static $html = html`
    <std-row id="root">
      <std-row id="nav-button-container">
        <button id="back-button" aria-label="Go back">
          <svg
            style="align-self:center"
            viewBox="0 0 24 24"
            xml:space="preserve"
            width="24"
            height="24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M17 11H9.41l3.3-3.29a1 1 0 1 0-1.42-1.42l-5 5a1 1 0 0 0-.21.33 1 1 0 0 0 0 .76 1 1 0 0 0 .21.33l5 5a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.42L9.41 13H17a1 1 0 0 0 0-2z"
            ></path>
          </svg>
        </button>
        <std-row id="nav-content">
          <slot name="icon"></slot>
          <slot name="title"></slot>
        </std-row>
      </std-row>
      <slot name="accessory"></slot>
    </std-row>
  `;
}

export namespace SidebarSectionNav {
  export interface Cta {
    $element: HTMLElement;
    onClick: EmptyFunction;
  }

  export type Callbacks = Optional<{
    onBackButtonClick: EmptyFunction;
    onNavContentClick: EmptyFunction;
  }>;

  export type Header = {
    title: string | HTMLElement;
    caption?: Option<string | HTMLElement>;
  };
}
