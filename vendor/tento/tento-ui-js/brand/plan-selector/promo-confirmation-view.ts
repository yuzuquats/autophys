import "../../components/button/button";
import "../../components/round";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { Carousel } from "../../components/carousel/carousel";
import { PageIndiciatorDots } from "../../components/page-indicator-dots";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { FeatureCardHero } from "../landing/feature-card-hero";
import { PresentationAssetRegistry } from "../../components/presentation/presentation-asset-registry";
import { CheckCircleFilledIcon, LonaIcons } from "../../ui/icons";

type PromoAssetViewModel = {
  kind: FeatureCardHero.HeroKind;
  assetScale: number;
  tile: FeatureCardHero.TileAnchor;
};

type PromoAssetPageViewModel = {
  label: string;
  heroProps: FeatureCardHero.Props;
};

const PROMO_ASSET_VIEW_MODELS: PromoAssetViewModel[] = [
  {
    kind: "hero/feature/calendar-list",
    assetScale: 0.8,
    tile: "top-center-inset",
  },
  {
    kind: "hero/feature/tasks",
    assetScale: 0.8,
    tile: "center",
  },
  {
    kind: "hero/feature/quick-add",
    assetScale: 0.8,
    tile: "center",
  },
  {
    kind: "hero/feature/scheduling-link",
    assetScale: 0.8,
    tile: "inset-bottom-right-bleed",
  },
  {
    kind: "hero/feature/spotlight",
    assetScale: 0.8,
    tile: "center",
  },
  {
    kind: "hero/feature/themes",
    assetScale: 0.8,
    tile: "scaled-bottom",
  },
];

@component({
  name: "std-promo-confirmation-view",
})
export class PromoConfirmationView extends LonaWebComponent {
  private $assetCarousel: Carousel = this.hydrate("asset-carousel");
  private $assetDots: PageIndiciatorDots = this.hydrate("asset-dots");

  private onChooseAnother: Option<() => void> = null;

  static makeWith(props: PromoConfirmationView.Props): PromoConfirmationView {
    return PromoConfirmationView.make().bind(props);
  }

  bind(props: PromoConfirmationView.Props): this {
    this.onChooseAnother = props.onChooseAnother ?? null;
    this.bindAssetCarousel();

    // Set header
    this.$("header").textContent = props.grantedPlan;

    // Set description paragraph with first few words bolded
    const words = props.description.split(" ");
    const boldCount = Math.min(3, words.length);
    const boldWords = words.slice(0, boldCount).join(" ");
    const remainingWords = words.slice(boldCount).join(" ");
    this.$("description").innerHTML =
      `<strong>${boldWords}</strong> ${remainingWords}`;

    // Set promo code in round
    this.$("promo-code").textContent = props.promoCode;

    // Add checkmark icon
    const $checkmark = this.$("promo-checkmark");
    DomUtils.clearChildren($checkmark);
    const $icon = LonaIcons.make(CheckCircleFilledIcon, {
      sizePx: 20,
      color: "var(--text-pri)",
    });
    $checkmark.appendChild($icon);

    // Handle button click
    const $button = this.$("choose-another-btn");
    GESTURE_MANAGER.addPointerEvent($button, {
      onClick: () => {
        this.onChooseAnother?.();
      },
    });

    return this;
  }

  private bindAssetCarousel(): void {
    const $pageContainer = this.$assetCarousel.$("page-container");
    DomUtils.clearChildren($pageContainer, false);

    const $pages = this.$assetPages();
    this.$assetDots.bind(0, $pages.length);
    if ($pages.length === 0) return;
    this.bindAssetDotsTint(0);

    this.$assetDots.onChange = (idx) => this.$assetCarousel.setPage(idx);

    this.$assetCarousel.domBind($pages, $pages.length, {
      onScroll: (_from, to) => {
        this.bindAssetDotsSelectedIndex(Math.round(to));
      },
    });
    this.$assetCarousel.setPage(0, $pages.length, false);
  }

  private bindAssetDotsSelectedIndex(selectedIndex: number): void {
    this.$assetDots.bindSelectedIndex(selectedIndex);
    this.bindAssetDotsTint(selectedIndex);
  }

  private bindAssetDotsTint(selectedIndex: number): void {
    this.$assetDots.toggleAttribute("first-item", selectedIndex === 0);
  }

  private $assetPages(): HTMLElement[] {
    const $pages: HTMLElement[] = [];
    for (const viewModel of PROMO_ASSET_VIEW_MODELS) {
      const asset = PresentationAssetRegistry.LANDING.featureHeroAsset(
        viewModel.kind,
      );
      const resolved = PresentationAssetRegistry.LANDING.resolve(
        viewModel.kind,
      );
      if (!asset || !resolved || resolved.kind !== "hero") continue;
      $pages.push(
        this.$assetPage(
          this.assetPageViewModel(asset.label, viewModel, resolved.props),
        ),
      );
    }
    return $pages;
  }

  private assetPageViewModel(
    label: string,
    viewModel: PromoAssetViewModel,
    props: FeatureCardHero.Props,
  ): PromoAssetPageViewModel {
    return {
      label,
      heroProps: {
        ...props,
        assetScale: viewModel.assetScale,
        items: props.items.map((item): FeatureCardHero.Item => ({
          ...item,
          tile: viewModel.tile,
        })),
      },
    };
  }

  private $assetPage(viewModel: PromoAssetPageViewModel): HTMLElement {
    const $page = document.createElement("div");
    $page.setAttribute("aria-label", viewModel.label);

    const $frame = document.createElement("div");
    $frame.setAttribute("aria-hidden", "true");
    $frame.setAttribute("inert", "");
    $frame.assignStyles({
      width: "calc(100% - 5px)",
      height: "calc(100% - 4px)",
      margin: "2px 3px 2px 2px",
      overflow: "hidden",
      borderRadius: "8px",
      background: "var(--bg)",
      boxSizing: "border-box",
      pointerEvents: "none",
    });

    const $hero = FeatureCardHero.makeWith(viewModel.heroProps);
    $hero.assignStyles({
      width: "100%",
      height: "100%",
    });

    $frame.appendChild($hero);
    $page.appendChild($frame);
    return $page;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        container-type: inline-size;
      }

      #root {
        border-radius: 8px;
        border: 1px solid var(--divider);
        overflow: hidden;
        height: 100%;
      }

      .column {
        flex: 1;
        position: relative;
      }

      #visual-column {
        flex: 2;
        min-width: 0;
        justify-content: stretch;
      }

      #visual-column::after {
        content: "";
        position: absolute;
        right: -0.5px;
        top: 0;
        width: 1px;
        height: 100%;
        background: var(--divider);
      }

      #details-column {
        min-height: 400px;
        gap: 32px;
        padding: 40px;
        align-items: flex-start;
      }

      #asset-carousel {
        align-self: stretch;
        flex: 1;
        width: 100%;
        height: auto;
        min-height: 280px;
        --std-carousel-background-color: transparent;
        --std-carousel-border: none;
        --std-carousel-border-radius: 8px;
        --std-carousel-card-box-shadow: none;
        --std-carousel-container-box-shadow: none;
        --std-carousel-focus-outline: none;
        --std-carousel-focus-outline-offset: 0px;
        --std-carousel-page-background-color: transparent;
        --std-carousel-page-margin: 0px;
        --std-carousel-page-padding: 0px;
      }

      #asset-dots {
        position: absolute;
        left: 50%;
        bottom: 6px;
        z-index: 2;
        padding: 6px 8px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--bg) 88%, transparent);
        margin-top: 0px;
        transform: translateX(-50%);
        --selected-width: 14px;
        --size: 5px;
      }

      #asset-dots[first-item] {
        background: color-mix(in srgb, var(--blue) 14%, var(--bg) 86%);
      }

      #header {
        color: var(--text-pri);
        --margin-bottom: 0px;
        --margin-top: 40px;
        --font-size: var(--h1-size);
      }

      #description {
        color: var(--text-sec);
        --margin-bottom: 0px;
        --line-height-ratio: 1.5;
      }

      #promo-section {
        gap: 8px;
        align-self: stretch;
      }

      #promo-label {
        color: var(--text-ter);
        --margin-bottom: 0px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        --font-size: var(--text-9px);
      }

      #promo-code-container {
        position: relative;
        align-self: stretch;
        padding: 16px 16px;
      }

      #promo-code-round {
        align-self: stretch;
      }

      #promo-code-layout {
        position: relative;
        z-index: 1;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-width: 0;
      }

      #promo-code-column {
        flex: 1;
        min-width: 0;
        align-items: center;
      }

      #promo-code {
        color: var(--text-pri);
        align-self: stretch;
        min-width: 0;
        max-width: 100%;
        --font-size: var(--text-10px);
        font-weight: 500;
        letter-spacing: 0.5px;
        text-align: center;
        --margin-bottom: 0px;
        overflow-wrap: anywhere;
        word-break: break-all;
      }

      #promo-checkmark {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }

      #promo-actions {
        gap: 2px;
        align-self: stretch;
      }

      #choose-another-btn {
        width: 100%;
      }

      @container (width < 700px) {
        #root {
          flex-direction: column;
        }

        #visual-column::after {
          right: 0;
          top: auto;
          bottom: -0.5px;
          width: 100%;
          height: 1px;
        }

        #visual-column {
          min-height: 240px;
        }

        #asset-carousel {
          min-height: 220px;
        }

        #asset-dots {
          bottom: 6px;
        }

        #details-column {
          flex: unset;
          min-height: unset;
          gap: 12px;
          padding: 24px;
        }
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <std-col class="column" id="visual-column">
        <std-carousel id="asset-carousel"></std-carousel>
        <std-page-indicator-dots id="asset-dots"></std-page-indicator-dots>
      </std-col>
      <std-col class="column" id="details-column">
        <h3 id="header"></h3>

        <p id="description"></p>

        <std-col id="promo-actions">
          <std-col id="promo-section">
            <p id="promo-label" class="small">Promo Code</p>
            <div id="promo-code-container">
              <std-round id="promo-code-round" bg="var(--bg-hover)" radius="8" floating></std-round>
              <std-row id="promo-code-layout">
                <std-col id="promo-code-column">
                  <p id="promo-code"></p>
                </std-col>
                <div id="promo-checkmark"></div>
              </std-row>
            </div>
          </std-col>

          <std-button id="choose-another-btn" flat>Choose another option</std-button>
        </std-col>
      </std-col>
    </std-row>
  `;
}

export namespace PromoConfirmationView {
  export interface Props {
    promoCode: string;
    grantedPlan: string;
    description: string;
    onChooseAnother?: Option<() => void>;
  }
}
