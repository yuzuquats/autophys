import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LandingUi } from "./landing-ui";
import { setSafeHref } from "@tento-brand/src/safe-url";
// Side-effect import, and it must stay: `Round` is otherwise referenced only as
// a TYPE (`this.hydrate<Round>("bg")`), so the bundler elides the import, the
// `@component` decorator never runs, `std-round` is never defined, and `#bg`
// stays an un-upgraded element — `this.$bg.bind(...)` then throws
// "bind is not a function" and takes the whole page render down with it. A page
// that happens to import `round` by another path hides this.
import "../../components/round";
import { Round } from "../../components/round";

@component({ name: "std-brand-card" })
export class LandingCard extends LonaWebComponent {
  // The card surface is a continuous-corner ("round") squircle: a std-round
  // (#bg) wraps the content, painting the rounded background + shadow, so there
  // is no border-radius anywhere. With `clip` set, std-round also clips its
  // content to that same squircle path (via its own ResizeObserver) so
  // edge-bleeding media follows the shared continuous contour. The radius
  // stays physical as the card resizes.
  private static BG_RADIUS = 48;

  private $bg: Round = this.hydrate<Round>("bg");
  private $anchor: HTMLElement = this.$("anchor");
  private $cardBackdrop: HTMLElement = this.$("card-backdrop");
  private $media: HTMLElement = this.$("media");
  private $mediaVisual: HTMLElement = this.$("media-visual");

  static makeWith(props: LandingCard.Props): LandingCard {
    return LandingCard.make().bind(props);
  }

  bind(props: LandingCard.Props): this {
    for (const child of [...this.children]) {
      if (["icon", "title", "subtitle", "accessory"].includes(child.getAttribute("slot") ?? "")) child.remove();
    }
    this.style.removeProperty("grid-column");
    this.$media.style.removeProperty("--media-min-height");
    this.style.removeProperty("--card-bg");
    this.removeAttribute("interactive");
    this.removeAttribute("tabindex");
    this.removeAttribute("role");
    this.style.removeProperty("cursor");
    this.$anchor.removeAttribute("href");
    this.$anchor.removeAttribute("aria-label");
    GESTURE_MANAGER.unregister(this);
    this.onclick = null;
    this.onkeydown = null;
    this.setAttribute("image-pos", props.imagePosition ?? "bottom");

    if (props.span != null && props.span > 1) {
      this.style.gridColumn = `span ${props.span}`;
    }

    if (props.renderIcon) {
      const $icon = props.renderIcon();
      $icon.slot = "icon";
      this.appendChild($icon);
    }

    {
      const $title = document.createElement("h3");
      $title.className = "card-title";
      $title.slot = "title";
      LandingUi.components.typography.bind($title, { variant: "card-title", text: props.title });
      this.appendChild($title);
    }

    if (props.description) {
      const $subtitle = document.createElement("p");
      $subtitle.className = "card-subtitle";
      $subtitle.slot = "subtitle";
      LandingUi.components.typography.bind($subtitle, { variant: "card-subtitle", text: props.description });
      this.appendChild($subtitle);
    }

    // A supplementary element under the text (e.g. a std-swatch-row of theme
    // colors). Sits in the text column, below the subtitle.
    if (props.renderAccessory) {
      const $accessory = props.renderAccessory();
      $accessory.slot = "accessory";
      this.appendChild($accessory);
    }

    DomUtils.clearChildren(this.$cardBackdrop);
    DomUtils.clearChildren(this.$mediaVisual);
    this.removeAttribute("has-media");
    this.removeAttribute("has-card-backdrop");
    this.toggleAttribute("has-icon", props.renderIcon != null);
    this.toggleAttribute("has-accessory", props.renderAccessory != null);

    if (props.renderCardBackdrop != null) {
      this.$cardBackdrop.appendChild(props.renderCardBackdrop());
      this.setAttribute("has-media", "");
      this.setAttribute("has-card-backdrop", "");
    }

    // The image bleeds to every card edge except the side that meets the text.
    if (props.renderVisual) {
      this.$mediaVisual.appendChild(props.renderVisual());
      this.setAttribute("has-media", "");
    } else if (props.showPlaceholderVisual) {
      this.$mediaVisual.appendChild(this.$placeholderMedia());
      this.setAttribute("has-media", "");
    }

    if (props.visualHeight != null) {
      this.$media.style.setProperty("--media-min-height", `${props.visualHeight}px`);
    }

    if (props.background) {
      this.style.setProperty("--card-bg", props.background);
    }

    // The squircle surface wrapping the content: paints the rounded bg + shadow
    // and clips the content to the squircle silhouette. Bound after --card-bg is
    // set so it reflects any per-card background override.
    this.$bg.bind({
      radius: LandingCard.BG_RADIUS,
      bg: "var(--card-bg)",
      shadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
      clip: true,
    });

    // Whole-card affordance — a real anchor when an href is given, otherwise a
    // gesture handler on the host. No visible arrow.
    if (props.href != null || props.onClick != null) {
      this.setAttribute("interactive", "");
    }

    if (props.href != null) {
      setSafeHref(this.$anchor, props.href);
      this.$anchor.setAttribute("aria-label", props.title);
    } else if (props.onClick) {
      this.style.cursor = "pointer";
      this.setAttribute("tabindex", "0");
      this.setAttribute("role", "button");
      this.onclick = event => {
        const nestedControl = event.composedPath().some(node => node !== this &&
          node instanceof Element && (node.matches("a[href],button,input,textarea,select,[role=button],[role=link]") ||
            node.getAttribute("slot") === "accessory"));
        if (!nestedControl) props.onClick?.();
      };
      this.onkeydown = event => {
        if (event.target !== this || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault(); props.onClick?.();
      };
    }

    return this;
  }

  private $placeholderMedia(): HTMLElement {
    const $panel = document.createElement("div");
    $panel.className = "media-placeholder";
    return $panel;
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        min-height: var(--feature-card-min-height, 0px);
        transition: transform 0.3s ease;
        --card-bg: var(--bg-elevated, var(--bg));
      }

      /* The std-round (#bg) wraps the content: it paints the squircle surface +
         shadow and clips #card to the squircle silhouette. It must fill the card
         height (Round defaults to min-content). No border-radius anywhere. */
      #bg {
        height: 100%;
        min-height: inherit;
      }

      #card {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-height: inherit;
        box-sizing: border-box;
      }

      :host([has-media]) #media {
        --media-flex-basis: var(--media-min-height, 160px);
      }

      :host([image-pos="top"]) #card {
        flex-direction: column-reverse;
      }

      :host([image-pos="right"]) #card {
        flex-direction: row;
      }

      :host([image-pos="left"]) #card {
        flex-direction: row-reverse;
      }

      :host([image-pos="left"]) #text,
      :host([image-pos="right"]) #text {
        flex: 0 0 40%;
        align-self: center;
      }

      :host([has-media][image-pos="left"]) #media,
      :host([has-media][image-pos="right"]) #media {
        --media-flex-basis: 0px;
        min-height: var(--media-min-height, 160px);
      }

      /* Lift the whole host (bg + clipped content together) on hover. */
      :host([interactive]:hover) {
        transform: translateY(-4px);
      }

      /* Outline on the host — #card's clip-path would otherwise clip it away. */
      :host(:focus-visible),
      :host([interactive]:focus-within) {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      /* Whole-card link sits above the content. */
      #anchor {
        position: absolute;
        inset: 0;
        z-index: 3;
      }

      #anchor:not([href]) {
        display: none;
      }

      #text {
        position: relative;
        z-index: 2;
        flex: none;
        box-sizing: border-box;
        height: var(--card-text-height, auto);
        overflow: hidden;
        padding: 28px;
        pointer-events: none;
      }

      ::slotted(.card-title) {
        font-family: var(--landing-card-copy-font-family, inherit);
        color: var(--text-pri);
        font-weight: 600;
        --font-size: var(--text-16px);
        --line-height-ratio: 1.15;
        --margin-top: 0px;
        --margin-bottom: 6px;
      }

      ::slotted([slot="icon"]) {
        display: block;
        margin-bottom: 14px;
      }

      ::slotted(.card-subtitle) {
        font-family: var(--landing-card-copy-font-family, inherit);
        color: color-mix(in srgb, var(--text-pri) 65%, transparent 35%);
        --font-size: var(--text-11px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      ::slotted([slot="accessory"]) {
        /* #text disables pointer events (so a whole-card link captures clicks);
           an accessory can be interactive (e.g. a swatch row), so opt it back in. */
        pointer-events: auto;
      }

      /* Accessory cards lay the text column out as flex so a growable spacer can
         sit between the subtitle and the accessory (e.g. the swatch row). */
      :host([has-accessory]) #text {
        display: flex;
        flex-direction: column;
        /* Center the title/subtitle/swatches block so free space beyond the
           capped gap splits evenly above the title and below the swatches. */
        justify-content: center;
      }

      /* Side-by-side layouts vertically centre the text; let it fill the height
         instead so the spacer below has room to grow. */
      :host([has-accessory][image-pos="left"]) #text,
      :host([has-accessory][image-pos="right"]) #text {
        align-self: stretch;
      }

      .accessory-spacer {
        display: none;
      }

      /* The spacer between the subtitle and the accessory: a flex-growable gap,
         capped at 80px (12px floor when tight). Free space beyond the cap is
         distributed by #text's justify-content:center, so it splits evenly above
         the title and below the swatches rather than piling under the swatches. */
      :host([has-accessory]) .accessory-spacer {
        display: block;
        flex: 1 1 0;
        min-height: 12px;
        max-height: 80px;
      }

      /* Sticker card only: a generous caption→detach-button gap in the
         side-by-side (left/right) layout; the stacked (top/bottom) layout tightens
         it in the @media block below. */
      :host([image-pos="right"]) #card:has(std-sticker-bento-hero) .accessory-spacer {
        max-height: 52px;
      }

      :host(:not([has-media])) #media {
        display: none;
      }

      /* The sticker bento card (LandingBento, image-pos="right") stacks
         text-on-top / image-on-bottom once its 3-col grid collapses to one
         full-width column (≤768px) — the squeezed text-left/image-right row reads
         badly full-width. Reuses the default column path (#text precedes #media,
         so column = text-top / image-bottom).

         SCOPED to the sticker card only (#card:has(std-sticker-bento-hero)). The
         generic feature grid (std-landing-feature-grid) drives its OWN
         side-by-side vs stacked choice by re-rendering on width — a feature is
         image-pos="right" only as a stretched single ≥560px wide (TWO_UNIT_MIN),
         "bottom" below that. A blanket :host([image-pos="right"]) rule here would
         double-stack those cards (e.g. "No app juggling") in the 560–768px band,
         forcing top/bottom when the grid wants them left/right. */
      @media (max-width: 768px) {
        :host([image-pos="right"]) #card:has(std-sticker-bento-hero) {
          flex-direction: column;
        }

        :host([image-pos="right"]) #card:has(std-sticker-bento-hero) #text {
          flex: none;
          align-self: stretch;
        }

        /* The sticker card's tall desktop media (--media-min-height: 360px, from
           visualHeight, tuned for the side-by-side row) keeps the whole card 360px
           tall when stacked full-width — shrink it so the card actually scales
           down. The :has(std-sticker-bento-hero) prefix out-specifies the base
           :host([has-media]) #media min-height. Tunable. */
        :host([image-pos="right"]) #media:has(std-sticker-bento-hero) {
          min-height: 240px;
        }

        /* Stacked sticker card: tighten the caption→detach-button gap (less than
           the side-by-side cap) so the button sits close under the caption above
           the sheet. */
        :host([image-pos="right"]) #card:has(std-sticker-bento-hero) .accessory-spacer {
          min-height: 20px;
          max-height: 20px;
        }
      }

      :host(:not([has-card-backdrop])) #card-backdrop {
        display: none;
      }

      #card-backdrop {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
      }

      #media {
        position: relative;
        z-index: 1;
        flex: 1 1 var(--media-flex-basis, 0px);
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      #media-visual {
        position: absolute;
        inset: 0;
      }

      #media-visual {
        z-index: 1;
      }

      :host([has-card-backdrop]) #media-visual std-feature-card-hero {
        --feature-card-hero-bg: transparent;
        background: transparent;
      }

      /* Children fill the media area edge-to-edge. The media area clips itself
         (#media has overflow:hidden); the squircle silhouette comes from the
         std-round wrapper (#bg) clipping #card. */
      #card-backdrop > *,
      #media-visual > * {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      #card-backdrop > .feature-gradient-wash {
        position: absolute;
        inset: var(--feature-gradient-inset, 0px);
        width: auto;
        height: auto;
        background-repeat: no-repeat;
        background-position: center;
        background-size: 100% 100%;
      }

      .media-placeholder {
        background: color-mix(in srgb, var(--bg) 86%, var(--text-pri) 14%);
      }
    `,
  ];

  static $html = html`
    <std-round id="bg" clip>
      <std-col id="card">
        <a id="anchor"></a>
        <div id="text">
          <slot name="icon"></slot>
          <slot name="title"></slot>
          <slot name="subtitle"></slot>
          <div class="accessory-spacer"></div>
          <slot name="accessory"></slot>
        </div>
        <std-col id="media">
          <div id="card-backdrop"></div>
          <div id="media-visual"></div>
        </std-col>
      </std-col>
    </std-round>
  `;
}

export namespace LandingCard {
  export type Props = {
    title: string;
    description?: Option<string>;
    renderIcon?: Option<() => HTMLElement>;
    renderVisual?: Option<() => HTMLElement>;
    renderCardBackdrop?: Option<() => HTMLElement>;
    renderAccessory?: Option<() => HTMLElement>;
    showPlaceholderVisual?: Option<boolean>;
    visualHeight?: Option<number>;
    span?: Option<number>;
    imagePosition?: Option<"top" | "bottom" | "left" | "right">;
    background?: Option<string>;
    href?: Option<string>;
    onClick?: Option<() => void>;
    // Legacy — accepted for back-compat, not rendered in the minimal card.
    kicker?: Option<string>;
    tags?: Option<string[]>;
    meta?: Option<string>;
  };
}
