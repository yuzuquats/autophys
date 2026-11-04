import { LiveData } from "@tento-core/livedata";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { FeatureCardReviewState } from "./feature-card-review-state";

@component({ name: "std-feature-card-hero-image-placeholder" })
export class FeatureCardHeroImagePlaceholder extends LonaWebComponent {
  private $placeholder: Option<HTMLElement>;
  private mode: FeatureCardHeroImagePlaceholder.Mode = "content";
  private placeholder: Option<FeatureCardHeroImagePlaceholder.PlaceholderSpec>;
  // True only on review surfaces (/gtm). When set, this asset follows the shared
  // review-toolbar content/placeholder state instead of its bound mode.
  private reviewControlled = false;

  static makeWith(
    props: FeatureCardHeroImagePlaceholder.Props,
  ): FeatureCardHeroImagePlaceholder {
    return (FeatureCardHeroImagePlaceholder.make() as FeatureCardHeroImagePlaceholder)
      .bind(props);
  }

  bind(props: FeatureCardHeroImagePlaceholder.Props): this {
    this.mode = props.mode;
    this.reviewControlled = props.reviewControlled;
    this.placeholder = props.placeholder;

    this.applyPlaceholderTokens(props.placeholder);
    this.syncMode();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // On review surfaces, follow the shared toolbar's content/placeholder state.
    // Immediate trigger so a card mounted while "placeholder" is selected adopts
    // it. Elsewhere (e.g. /landing) the asset stays on its bound mode.
    if (this.reviewControlled) {
      FeatureCardReviewState.mode.addListener(
        this,
        (mode) => {
          this.mode = mode;
          this.syncMode();
        },
        LiveData.TriggerImmediately,
      );
    }
  }

  disconnectedCallback(): void {
    FeatureCardReviewState.mode.removeListener(this);
    super.disconnectedCallback();
  }

  onRecycle(): void {
    FeatureCardReviewState.mode.removeListener(this);
    this.removePlaceholder();
    this.mode = "content";
    this.placeholder = null;
    this.reviewControlled = false;
    super.onRecycle();
  }

  private applyPlaceholderTokens(
    placeholder: FeatureCardHeroImagePlaceholder.PlaceholderSpec,
  ): void {
    this.style.setProperty("--hero-image-placeholder-fill", placeholder.fill);
    this.style.setProperty("--hero-image-placeholder-text", placeholder.textColor);
  }

  private syncPlaceholder(): void {
    const placeholder = this.placeholder;
    if (placeholder == null || !this.shouldRenderPlaceholder()) {
      this.removePlaceholder();
      return;
    }

    const $placeholder = this.ensurePlaceholder();

    DomUtils.clearChildren($placeholder);

    const $label = Typography.small(placeholder.label);
    $label.assignStyles({
      "--font-size": "var(--text-48px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      fontWeight: "700",
    });

    const $id = Typography.small(`hero/${placeholder.id}`);
    $id.assignStyles({
      "--font-size": "var(--text-20px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      opacity: "0.72",
    });

    const $layout = Typography.small(placeholder.layout);
    $layout.assignStyles({
      "--font-size": "var(--text-24px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      opacity: "0.72",
    });

    $placeholder.append($label, $layout, $id);
  }

  private syncMode(): void {
    this.setAttribute("mode", this.mode);
    this.syncPlaceholder();
  }

  private shouldRenderPlaceholder(): boolean {
    return this.mode === "placeholder" || this.reviewControlled;
  }

  private ensurePlaceholder(): HTMLElement {
    if (this.$placeholder != null) return this.$placeholder;
    const $placeholder = document.createElement("div");
    $placeholder.id = "placeholder";
    this.shadowRoot?.appendChild($placeholder);
    this.$placeholder = $placeholder;
    return $placeholder;
  }

  private removePlaceholder(): void {
    this.$placeholder?.remove();
    this.$placeholder = null;
  }

  static $styles = [
    Typography.$style,
    css`
      /* Shrink-wrap the slotted asset at its intrinsic size; the hero (or any
         host) measures + scales it. The placeholder-block overlays without
         changing the size, so toggling modes doesn't reflow. */
      :host {
        display: inline-block;
        position: relative;
        /* NO overflow:hidden here. This wrapper shrink-wraps the slotted asset to
           its box, and the asset's own drop-shadow extends PAST that box — clipping
           here cuts the shadow flush at the card edges. The #placeholder overlay
           clips its own rounded corners, and the hero stage clips intended bleeds,
           so this host must not clip. */
        --hero-image-placeholder-fill: color-mix(
          in srgb,
          var(--bg) 86%,
          var(--text-pri) 14%
        );
        --hero-image-placeholder-text: var(--text-pri);
      }

      #content {
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }

      #content > slot {
        display: contents;
      }

      ::slotted(*) {
        display: block;
      }

      #placeholder {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 28px;
        border-radius: 18px;
        overflow: hidden;
        box-sizing: border-box;
        background: var(--hero-image-placeholder-fill);
        color: var(--hero-image-placeholder-text);
      }

      :host([mode="content"]) #placeholder {
        display: none;
      }

      :host([mode="placeholder"]) #content {
        visibility: hidden;
      }
    `,
  ];

  static $html = html`
    <div id="content"><slot></slot></div>
  `;
}

export namespace FeatureCardHeroImagePlaceholder {
  export type Mode = FeatureCardReviewState.Mode;

  export type PlaceholderSpec = {
    label: string;
    id: string;
    layout: string;
    fill: string;
    textColor: string;
  };

  export type Props = {
    placeholder: PlaceholderSpec;
    mode: Mode;
    reviewControlled: boolean;
  };
}
