import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LandingUi } from "./landing-ui";

export type Cta = {
  label: string;
  primary?: Option<boolean>;
  variant?: "primary" | "secondary";
  href?: Option<string>;
};

@component({ name: "std-landing-hero" })
export class LandingHero extends LonaWebComponent {
  private $ctaRow: HTMLElement = this.$("cta-row");
  private $visualSlot: HTMLElement = this.$("visual-slot");

  static makeWith(props: LandingHero.Props): LandingHero {
    return (LandingHero.make() as LandingHero).bind(props);
  }

  bind(props: LandingHero.Props): this {
    DomUtils.clearChildren(this);

    if (props.kicker) {
      const $kicker = document.createElement("p");
      $kicker.className = "kicker";
      $kicker.slot = "kicker";
      LandingUi.components.typography.bind($kicker, { variant: "hero-kicker", text: props.kicker });
      this.appendChild($kicker);
    }

    {
      const $headline = document.createElement("h1");
      $headline.className = "headline";
      $headline.slot = "headline";
      LandingUi.components.typography.bind($headline, { variant: "hero-title", text: props.headline });
      this.appendChild($headline);
    }

    if (props.subtitle) {
      const $subtitle = document.createElement("p");
      $subtitle.className = "subtitle";
      $subtitle.slot = "subtitle";
      LandingUi.components.typography.bind($subtitle, { variant: "hero-subtitle", text: props.subtitle });
      this.appendChild($subtitle);
    }

    DomUtils.clearChildren(this.$ctaRow);
    if (props.ctas && props.ctas.length > 0) {
      for (const cta of props.ctas) {
        this.$ctaRow.appendChild(this.$cta(cta));
      }
    }

    DomUtils.clearChildren(this.$visualSlot);
    if (props.renderVisual) {
      this.$visualSlot.appendChild(props.renderVisual());
    }

    return this;
  }

  private $cta(cta: Cta): HTMLElement {
    return LandingUi.components.link.make({
      treatment: "hero",
      variant: cta.variant ?? (cta.primary ? "primary" : "secondary"),
      label: cta.label,
      href: cta.href ?? "#",
    });
  }

  static $styles = [
    css(`
      :host {
        display: block;
      }

      #inner {
        gap: 0;
      }

      ::slotted(.kicker) {
        text-transform: uppercase;
        --margin-top: 0px;
        --margin-bottom: 24px;
      }

      ::slotted(.headline) {
        font-family: var(--landing-copy-font-family, inherit);
        max-width: 920px;
        --margin-top: 0px;
        --margin-bottom: 44px;
      }

      ::slotted(.subtitle) {
        font-family: var(--landing-copy-font-family, inherit);
        max-width: 940px;
        color: var(--text-sec);
        --margin-top: 0px;
        --margin-bottom: 48px;
      }

      #cta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 0;
        margin-bottom: 32px;
      }

      #cta-row:empty {
        display: none;
      }

      .cta {
        ${LandingUi.actionBase}
        color: var(--text-sec);
        font-weight: 500;
      }

      .cta:hover {
        ${LandingUi.actionHover}
      }

      .cta:focus-visible {
        ${LandingUi.actionFocus}
      }

      .cta[primary] {
        ${LandingUi.primaryAction}
      }

      .cta[primary]:hover {
        box-shadow: var(--box-shadow-light);
      }

      #visual-slot {
        width: var(--landing-visual-width, min(1120px, calc(100vw - 80px)));
        position: relative;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 32px;
      }

      @media (max-width: 768px) {
        #visual-slot {
          width: var(--landing-visual-width, calc(100vw - 32px));
          margin-top: 24px;
        }

        #cta-row {
          gap: 8px;
          margin-bottom: 24px;
        }
      }

      #visual-slot:empty {
        display: none;
      }
    `),
  ];

  static $html = html`
    <std-col id="inner">
      <slot name="kicker"></slot>
      <slot name="headline"></slot>
      <slot name="subtitle"></slot>
      <div id="cta-row"></div>
      <div id="visual-slot"></div>
    </std-col>
  `;
}

export namespace LandingHero {
  export type Props = {
    kicker?: Option<string>;
    headline: string;
    subtitle?: Option<string>;
    ctas?: Option<Cta[]>;
    renderVisual?: Option<() => HTMLElement>;
  };
}
