import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Session } from "../session";

@component({
  name: "std-flippable-card",
})
export class FlippableCard extends LonaWebComponent {
  private timeout: Option<ReturnType<typeof setTimeout>>;

  connectedCallback() {
    super.connectedCallback();
    // Firefox's 3D flip (preserve-3d + backface-visibility) blanks/bleeds
    // content re-slotted through a nested shadow component inside a face (see
    // .learnings/2026-07-04-firefox-flip-card-reslot-blank). Drop to the flat
    // opacity swap generically on Firefox; Chrome keeps the real 3D flip. The
    // `flat` attribute stays a valid manual opt-in for other consumers too.
    if (Session.isFirefox) this.toggleAttribute("flat", true);
  }

  /**
   * Flip the card to show front or back.
   * @param side - Target side to show. If omitted, toggles current side.
   * @param animate - When false, snap to the target side with no rotation. Used
   *   by the deck shuffle to deal cards face-down without the front-showing first
   *   half of the flip rotation. Defaults to the animated 3D flip.
   */
  flip(side?: "front" | "back", animate: boolean = true) {
    const isCurrentlyFlipped = this.hasAttribute("flipped");
    const targetFlipped = side === "back" ? true : side === "front" ? false : !isCurrentlyFlipped;

    // No-op if already on the correct side
    if (targetFlipped === isCurrentlyFlipped) return;

    const $card = this.$("root");
    if (this.timeout != null) {
      $card.classList.remove("card--flipped", "card--unflip");
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (!animate) {
      // Snap with no rotation: clear the keyframe classes so only the `flipped`
      // attribute drives the resting transform (see the
      // :host([flipped]:not([flat])) #root rule below). On Firefox ([flat]) the
      // face swap is opacity-driven, so this just toggles the swap.
      $card.classList.remove("card--flipped", "card--unflip");
      this.toggleAttribute("flipped", targetFlipped);
      return;
    }
    // Branch on the TARGET side, not the presence of `card--flipped`: an instant
    // flip(side, false) sets the `flipped` attribute WITHOUT that class, so the
    // class is no longer a reliable proxy for the current side. Deriving the
    // direction from targetFlipped keeps the animated reveal correct after an
    // instant deal (otherwise the "last" flip-to-front would animate to back).
    if (targetFlipped) {
      // front → back: play the flip rotation and hold it.
      $card.classList.add("card--flipped");
    } else {
      // back → front: play the unflip rotation, then clear the keyframe classes
      // so #root returns to its base (front) transform.
      $card.classList.add("card--unflip");
      this.timeout = setTimeout(() => {
        $card.classList.remove("card--flipped", "card--unflip");
      }, 300);
    }
    this.toggleAttribute("flipped", targetFlipped);
  }

  static $styles = [
    css`
      :host {
        display: block;
        height: 440px;
        width: 280px;
        /* The card's corner radius. Consumers override by setting border-radius
           on the host; #root and the faces below inherit it, so the whole card
           has one source of truth for the radius. */
        border-radius: 20px;
      }

      #root {
        position: relative;
        transform-style: preserve-3d;
        transform: rotateY(180deg);
        height: 100%;
        width: 100%;

        border-radius: inherit;
        box-shadow: inherit;
        background: inherit;
      }

      .card-face {
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;

        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }

      /* Inherit the host radius (via #root, which is border-radius: inherit) so
         the overflow:hidden clip matches the host instead of a hardcoded value —
         otherwise a host rounded to e.g. 22 clips its content at 20, leaving a
         mismatched double corner. */
      .card-back {
        overflow: var(--flippable-card-face-overflow, hidden);
        border-radius: inherit;
      }

      .card-front {
        overflow: var(--flippable-card-face-overflow, hidden);
        border-radius: inherit;
        transform: rotateY(180deg);
      }

      /* Resting flipped (back) state, attribute-driven so a flip(side, false)
         snaps instantly with no rotation. The cardFlip/cardUnFlip keyframes
         override this during an animated flip and settle on the same rotateY(0).
         Excluded on [flat] (Firefox), where #root stays untransformed and the
         face swap is opacity-driven. */
      :host([flipped]:not([flat])) #root {
        transform: rotateY(0deg);
      }

      slot[name=back]::slotted(*) {
        pointer-events: none;
      }

      :host([flipped]) slot[name=back]::slotted(*) {
        pointer-events: all;
      }

      /* Flat mode (opt-in via the \`flat\` attribute): drop the 3D entirely —
         both faces stay in the 2D plane and swap via opacity/visibility on
         \`flipped\`. Firefox blanks content that is re-slotted through a nested
         shadow component inside a preserve-3d + backface-visibility face (see
         .learnings/2026-07-04-firefox-flip-card-reslot-blank); flat sidesteps it.
         For consumers that don't need the 3D flip (e.g. an unused back face). */
      :host([flat]) #root {
        transform: none;
        transform-style: flat;
      }

      :host([flat]) .card-face {
        backface-visibility: visible;
        -webkit-backface-visibility: visible;
        transform: none;
        transition: opacity 0.2s ease, visibility 0.2s ease;
      }

      /* Flat-mode paint order (the "front wash"): the VISIBLE face must sit
         ABOVE the hidden one. A face that wraps its content in a std-round with a
         drop-shadow (\`shadow:\` -> Round sets filter: drop-shadow on the squircle
         fill) promotes that fill to its own compositing layer; Firefox paints that
         layer while ignoring the ancestor \`opacity: 0\`, and since .card-back is
         DOM-after .card-front it bleeds the hidden back's surface OVER the front.
         Stacking the active face on top lets its opaque squircle occlude the bled
         layer. See .learnings/2026-07-04-firefox-flip-card-reslot-blank. */
      :host([flat]) .card-front {
        z-index: 2;
      }

      :host([flat]) .card-back {
        z-index: 1;
        opacity: 0;
        visibility: hidden;
      }

      :host([flat][flipped]) .card-front {
        z-index: 1;
        opacity: 0;
        visibility: hidden;
      }

      :host([flat][flipped]) .card-back {
        z-index: 2;
        opacity: 1;
        visibility: visible;
      }
    `,
    css`
      .card--flipped {
        animation: cardFlip 0.275s forwards linear;
      }

      .card--unflip {
        animation: cardUnFlip 0.275s forwards linear;
      }

      /* Flat mode drives the face swap via opacity/visibility, not the 3D
         keyframe rotation — neutralize the animation so #root stays flat. */
      :host([flat]) .card--flipped,
      :host([flat]) .card--unflip {
        animation: none;
      }

      @keyframes cardFlip {
        0% {
          transform: rotateZ(0deg) rotateY(180deg);
        }
        50% {
          transform: rotateZ(-10deg) rotateY(90deg);
        }
        100% {
          transform: rotateZ(0deg) rotateY(0deg);
        }
      }

      @keyframes cardUnFlip {
        0% {
          transform: rotateZ(0deg) rotateY(0deg);
        }
        50% {
          transform: rotateZ(-10deg) rotateY(90deg);
        }
        100% {
          transform: rotateZ(0deg) rotateY(180deg);
        }
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <slot></slot>
      <div class="card-face card-front">
        <slot name="front"></slot>
      </div>
      <div class="card-face card-back">
        <slot name="back"></slot>
      </div>
    </div>
  `;
}
