import "@tento-ui/component-builtin";

import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Button } from "@tento-ui/components/button/button";
import { LonaIcons, PlusIcon } from "@tento-ui/ui/icons";
import { PresentationAsset } from "../presentation/presentation-asset";

/**
 * Content for the empty-state placeholder card — a "get started"-style hero
 * forked from NuxExplainerCard: a muted illustration panel holding a large
 * icon, then a headline + subcaption, then a flat "Create task" button. The
 * host card sets `hideCardHeader`, so this fills the card edge-to-edge in card
 * mode (list mode uses the HomeListCell instead). The `#illustration` panel is
 * a drop-in slot for a real illustration later.
 */
@component({
  name: "std-no-cards-state",
})
export class NoCardsState extends LonaWebComponent {
  private $illustration: HTMLElement = this.$("illustration");
  private $title: HTMLElement = this.$("title");
  private $caption: HTMLElement = this.$("caption");
  private $startBtn: HTMLElement = this.$("start-btn");
  private $startIcon: HTMLElement = this.$("start-icon");

  private onAddCard: Option<() => void> = null;

  static makeWith(props: NoCardsState.Props): NoCardsState {
    const $e = NoCardsState.make();
    $e.bind(props);
    return $e;
  }

  bind(props: NoCardsState.Props): this {
    this.onAddCard = props.onAddCard;
    // Title/caption are optional: the greeting header owns the day's status, so
    // the empty card can render hero + CTA only (no status echo). Collapse the
    // element when its text is absent.
    this.$title.textContent = props.title ?? "";
    this.$title.style.display = props.title ? "" : "none";
    this.$caption.textContent = props.caption ?? "";
    this.$caption.style.display = props.caption ? "" : "none";
    const $hero = PresentationAsset.makeWith({
      src: props.heroSrc,
      alt: null,
      fit: null,
      decorative: props.heroDecorative,
      registry: null,
    });
    $hero.id = "hero";
    this.$illustration.replaceChildren($hero);
    this.$startIcon.replaceChildren(
      LonaIcons.make(PlusIcon, { sizePx: 14, color: "currentColor" }),
    );

    if (props.onAddCard) {
      this.$startBtn.style.display = "";
      GESTURE_MANAGER.addPointerEvent(this.$startBtn, {
        onClick: () => this.onAddCard?.(),
      });
    } else {
      this.$startBtn.style.display = "none";
    }
    return this;
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
        height: 100%;
      }

      #container {
        height: 100%;
        gap: 0;
        align-items: stretch;
      }

      /* Muted hero panel (forked from NuxExplainerCard #illustration), holding
         the icon centered. A drop-in slot for a real illustration later. */
      #illustration {
        flex: none;
        height: 58%;
        margin: 8px;
        border-radius: 20px;
        background: color-mix(in srgb, var(--bg) 86%, var(--text-pri) 14%);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #hero {
        width: 48px;
        height: 48px;
      }

      /* Only the body flex-grows (the illustration is fixed) — not both. */
      #body {
        flex-grow: 1;
        align-items: start;
        gap: 4px;
        padding: 16px 20px 20px;
      }

      /* Forked from std-brand-card .card-title via NuxExplainerCard. */
      .title {
        color: var(--text-pri);
        font-weight: 300;
        --font-size: var(--text-12px);
        --line-height-ratio: 1.15;
        --margin-top: 0px;
        --margin-bottom: 8px;
      }

      .caption {
        color: var(--text-ter);
        --font-size: var(--text-10px);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      /* Flat "Create task" button (Button.$style [flat]); pulled left by its
         own padding so the label lines up under the headline. */
      #start-btn {
        align-self: flex-start;
        gap: 6px;
        margin-top: 12px;
        margin-left: -12px;
      }

      #start-icon {
        display: flex;
        align-items: center;
      }
    `,
  ];

  static $html = html`
    <std-col id="container">
      <div id="illustration"></div>
      <std-col id="body">
        <p id="title" class="title"></p>
        <p id="caption" class="caption"></p>
        <button id="start-btn" flat type="button">
          <span id="start-icon"></span>
          <span id="start-label">Create task</span>
        </button>
      </std-col>
    </std-col>
  `;
}

export namespace NoCardsState {
  export type Props = {
    /** Optional headline; omitted (null) when the header owns the status. */
    title: Option<string>;
    /** Optional subcaption under the headline. */
    caption: Option<string>;
    /** Presentation asset shown centered in the hero panel. */
    heroSrc: string;
    /** Whether the hero is decorative for assistive technology. */
    heroDecorative: boolean;
    /** When set, shows a "Create task" CTA that invokes this. */
    onAddCard: Option<() => void>;
  };
}
