// Side-effect import: registers <std-modal-close-button>. The named import
// below is type-only (it annotates the hydrated field) and would be elided at
// runtime, so without this the custom element never upgrades.
import "../modal-close-button/modal-close-button";

import { html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Overlay } from "../overlay";
import { Focus } from "../../ui/focus";

import { ModalCloseButton } from "../modal-close-button/modal-close-button";
import { Typography } from "../../ui/typography";

// Full-screen "lightbox" view of one thing at its native size. It began life in
// `brand/landing/` as the asset grid's zoom, but its Props were generic from the
// start — a label, a native size, a content factory, an inert flag — and only
// the name and the directory said "brand". Promoted: the asset preview is now
// one caller among any. The content is rendered at its native pixel size with
// NO transform scaling (which would soften images); the viewport caps to the
// screen and scrolls when the content is larger. Dismisses on backdrop click /
// Escape (via Overlay) and the close button.
//
// Promotion also gave it the overlay contract it lacked: `role=dialog` with
// `aria-modal` named by the label, focus on the close button when revealed,
// and focus back on the invoker on every dismissal path (rule R8).
@component({ name: "std-lightbox" })
export class Lightbox extends LonaModalWebComponent {
  private $viewport: HTMLElement = this.$("viewport");
  private $stage: HTMLElement = this.$("stage");
  private $label: HTMLElement = this.$("label");
  private $close: ModalCloseButton = this.hydrate("close");

  static show(props: Lightbox.Props): Lightbox {
    const $lightbox = Lightbox.makeWith(props);
    // Captured in the closure, not a field: the overlay returns the element
    // to the pool BEFORE it fires `onDismiss`, and `onRecycle` clears fields.
    const $invoker = Focus.activeDeep();
    // No position arg → Overlay centers it. (Position.center/CENTER offsets it
    // upward or throws — Overlay hardcodes top:50% and only varies transformY.)
    Overlay.instance.get().reveal($lightbox, {
      onDismiss: () => {
        if ($invoker != null && Focus.isLostOrWithin($lightbox)) $invoker.focus();
      },
      canDismiss: null,
      position: null,
    });
    requestAnimationFrame(() => {
      ($lightbox.$close.shadowRoot?.querySelector<HTMLElement>("button") ?? $lightbox.$close).focus();
    });
    return $lightbox;
  }

  static makeWith(props: Lightbox.Props): Lightbox {
    return Lightbox.make().bind(props);
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$stage);
    this.$label.textContent = "";
    for (const a of ["role", "aria-modal", "aria-label"]) this.removeAttribute(a);
  }

  bind(props: Lightbox.Props): this {
    this.$label.textContent = props.label;
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-modal", "true");
    this.setAttribute("aria-label", props.label);

    // Render at native size (1:1) — no transform scaling. The viewport's
    // max-width/height + overflow keep an oversized asset on-screen and crisp.
    this.$stage.style.width = `${props.nativeSize.width}px`;
    this.$stage.style.height = `${props.nativeSize.height}px`;
    this.$viewport.style.width = `${props.nativeSize.width}px`;
    this.$viewport.style.height = `${props.nativeSize.height}px`;
    DomUtils.clearChildren(this.$stage);
    this.$stage.appendChild(props.makeContent());
    this.$stage.toggleAttribute("inert", props.inertContent);

    this.$close.bind({ onDismiss: () => this.dismiss() });
    return this;
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: inline-block;
      }

      #panel {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        border-radius: 20px;
        background: var(--bg);
        box-shadow: 0 24px 64px color-mix(in srgb, var(--text-pri) 22%, transparent);
      }

      #label {
        --font-size: var(--text-11px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
        font-weight: 700;
        padding-right: 44px;
      }

      #viewport {
        position: relative;
        overflow: auto;
        max-width: calc(100vw - 80px);
        max-height: calc(100vh - 160px);
        border-radius: 14px;
        border: 1px solid var(--divider);
        background: var(--bg);
      }

      #stage {
        position: relative;
      }

      /* The asset is purely visual; never let it intercept clicks meant for the
         backdrop / close button. */
      #stage[inert] {
        pointer-events: none;
      }

      #close {
        top: 12px;
        right: 12px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="panel">
      <p id="label"></p>
      <div id="viewport"><div id="stage"></div></div>
      <std-modal-close-button id="close"></std-modal-close-button>
    </div>
  `;
}

export namespace Lightbox {
  export type Props = {
    label: string;
    nativeSize: Size;
    makeContent: () => HTMLElement;
    inertContent: boolean;
  };
}
