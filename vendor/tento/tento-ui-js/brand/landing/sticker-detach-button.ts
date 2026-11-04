import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

// The explicit "→ in a circle" detach affordance for the sticker feature card.
// It sits in the card's text column (the `accessory` slot); clicking it pops the
// sticker sheet out of the card into a floating window. The wiring is supplied by
// the caller via `onClick` (the sticker section hands it a StickerPopHandle), so
// this component stays a pure, reusable control.
@component({ name: "std-sticker-detach-button" })
export class StickerDetachButton extends LonaWebComponent {
  private detachLabel = "";
  private closeLabel = "";

  static makeWith(props: StickerDetachButton.Props): StickerDetachButton {
    return (StickerDetachButton.make() as StickerDetachButton).bind(props);
  }

  bind(props: StickerDetachButton.Props): this {
    this.detachLabel = props.detachLabel;
    this.closeLabel = props.closeLabel;
    const $button = this.$("button");
    $button.setAttribute("aria-label", props.detachLabel);
    GESTURE_MANAGER.unregister($button);
    $button.onclick = () => props.onClick();
    return this;
  }

  // Flip the affordance: the detach (arrow) glyph when docked, a close (X) glyph
  // when the sheet is popped out. Driven by StickerPopHandle.onStateChange.
  setPopped(popped: boolean): void {
    this.toggleAttribute("popped", popped);
    this.$("button").setAttribute(
      "aria-label",
      popped ? this.closeLabel : this.detachLabel,
    );
  }

  static $styles = [
    css`
      :host {
        display: inline-flex;
      }

      #button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0px;
        border: none;
        border-radius: 50%;
        /* "Ink" circle: text-pri fill + bg-coloured arrow auto-inverts in dark
           mode (text-pri is light there), staying high-contrast either way. */
        background: var(--text-pri);
        color: var(--bg);
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
        transition:
          transform 0.2s ease,
          box-shadow 0.2s ease,
          opacity 0.15s ease;
      }

      #button:hover {
        transform: translateY(-1px);
        box-shadow: 0 5px 14px rgba(0, 0, 0, 0.24);
      }

      #button:active {
        transform: translateY(0px);
        opacity: 0.9;
      }

      #button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      /* Detach (arrow) by default; close (X) when the sheet is popped out. */
      #close-icon {
        display: none;
      }

      :host([popped]) #arrow-icon {
        display: none;
      }

      :host([popped]) #close-icon {
        display: block;
      }

      svg {
        width: 20px;
        height: 20px;
        display: block;
      }
    `,
  ];

  static $html = html`
    <button id="button" type="button">
      <svg
        id="arrow-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="5" y1="12" x2="18" y2="12"></line>
        <polyline points="12 6 18 12 12 18"></polyline>
      </svg>
      <svg
        id="close-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="6" y1="6" x2="18" y2="18"></line>
        <line x1="6" y1="18" x2="18" y2="6"></line>
      </svg>
    </button>
  `;
}

export namespace StickerDetachButton {
  export type Props = {
    onClick: () => void;
    // Aria-label for each affordance; the glyph swaps arrow ⇄ X via setPopped.
    detachLabel: string;
    closeLabel: string;
  };
}
