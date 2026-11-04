import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { FeatureCardHero } from "./feature-card-hero";
import { CuratedWashes } from "./curated-washes";
import { GradientSplatWash } from "./gradient-splat-wash";
import { FEATURE_CARD_TEXT } from "./landing-card-text";
import { LandingCard } from "./landing-card";

@component({ name: "std-landing-feature-grid" })
export class LandingFeatureGrid extends LonaWebComponent {
  private $layout: HTMLElement = this.$("layout");
  private features: LandingFeatureGrid.Feature[] = [];
  private assetRegistry: Option<LandingFeatureGrid.AssetRegistry> = null;
  private heroRegistry: Option<FeatureCardHero.Registry> = null;
  private rowUnits: LandingFeatureGrid.RowUnits = 2;
  // Whether a sole/hero card fits side-by-side at the current width: true while
  // its left/right image height (width / HERO_ROW_ASPECT) stays >= the minimum.
  // Below that the card tiles to top/bottom (stacked). See heroFitsSideBySide.
  private heroRow = true;
  private tileFormat: FeatureCardHero.TileFormat = "desktop";
  private cardTreatment: LandingFeatureGrid.CardTreatment = "default";

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    const rowUnits = LandingFeatureGrid.rowUnitsForWidth(size.width);
    const heroRow = LandingFeatureGrid.heroFitsSideBySide(size.width);
    const tileFormat = LandingFeatureGrid.tileFormatForWidth(size.width);
    if (
      rowUnits === this.rowUnits &&
      heroRow === this.heroRow &&
      tileFormat === this.tileFormat
    ) return;

    this.rowUnits = rowUnits;
    this.heroRow = heroRow;
    this.tileFormat = tileFormat;
    this.renderFeatures();
  };

  static makeWith(props: LandingFeatureGrid.Props): LandingFeatureGrid {
    return (LandingFeatureGrid.make() as LandingFeatureGrid).bind(props);
  }

  bind(props: LandingFeatureGrid.Props): this {
    this.features = props.features;
    this.assetRegistry = props.assetRegistry ?? null;
    this.heroRegistry = props.heroRegistry;
    this.cardTreatment = props.cardTreatment ?? "default";
    this.setAttribute("card-treatment", this.cardTreatment);
    if (this.offsetWidth > 0) {
      this.rowUnits = LandingFeatureGrid.rowUnitsForWidth(this.offsetWidth);
      this.heroRow = LandingFeatureGrid.heroFitsSideBySide(this.offsetWidth);
      this.tileFormat = LandingFeatureGrid.tileFormatForWidth(this.offsetWidth);
    }
    this.renderFeatures();
    return this;
  }

  // Append a card to an already-bound grid and re-render. Used to inject an
  // extra card (e.g. the Themes demo) into an existing CMS-driven grouping.
  appendFeature(feature: LandingFeatureGrid.Feature): void {
    this.features = [...this.features, feature];
    if (this.offsetWidth > 0) {
      this.rowUnits = LandingFeatureGrid.rowUnitsForWidth(this.offsetWidth);
      this.heroRow = LandingFeatureGrid.heroFitsSideBySide(this.offsetWidth);
      this.tileFormat = LandingFeatureGrid.tileFormatForWidth(this.offsetWidth);
    }
    this.renderFeatures();
  }

  private renderFeatures(): void {
    DomUtils.clearChildren(this.$layout);

    const rows = LandingFeatureGrid.rowsFor(this.features, this.rowUnits);
    for (const row of rows) {
      const $row = document.createElement("div");
      $row.className = "feature-row";

      // A sole card tiles side-by-side only while its image stays tall enough
      // (heroRow); below that it stacks. Decoupled from rowUnits (packing).
      const isStretchedSingle = row.features.length === 1 && this.heroRow;
      for (const rowFeature of row.features) {
        $row.appendChild(this.makeCard(rowFeature, row, isStretchedSingle));
      }

      this.$layout.appendChild($row);
    }
  }

  private makeCard(
    rowFeature: LandingFeatureGrid.RowFeature,
    row: LandingFeatureGrid.Row,
    isStretchedSingle: boolean,
  ): LandingCard {
    const heroProps = this.heroPropsFor(rowFeature.feature);
    const customVisual = rowFeature.feature.renderVisual ?? null;
    const usesFeatureHero = customVisual == null && heroProps != null;
    const renderVisual = customVisual
      ?? this.defaultHeroVisualFor(heroProps, rowFeature, isStretchedSingle);
    const renderCardBackdrop = renderVisual == null
      ? null
      : () => LandingFeatureGrid.makeGradientBackdrop(rowFeature);
    const imagePosition = this.imagePositionFor(isStretchedSingle);
    const $card = LandingCard.makeWith({
      title: rowFeature.feature.title,
      description: rowFeature.feature.description,
      imagePosition,
      renderCardBackdrop,
      renderVisual,
      renderIcon: rowFeature.feature.renderIcon ?? null,
      renderAccessory: rowFeature.feature.renderAccessory ?? null,
      showPlaceholderVisual: renderVisual == null,
    });
    $card.classList.add("feature-card", `feature-card-span-${rowFeature.span}`);
    if (usesFeatureHero) {
      $card.style.setProperty(
        "--feature-card-hero-min-height",
        `${LandingFeatureGrid.MIN_HERO_IMAGE_HEIGHT}px`,
      );
    }

    if (isStretchedSingle) {
      // Side-by-side hero: a landscape card whose media fills the full height, so
      // the image height (= cardWidth / HERO_ROW_ASPECT) is >= MIN by
      // construction (the same width test gates isStretchedSingle).
      $card.style.setProperty(
        "--feature-card-aspect-ratio",
        `${LandingFeatureGrid.HERO_ROW_ASPECT}`,
      );
      $card.style.removeProperty("--media-min-height");
      $card.style.removeProperty("--feature-card-min-height");
      $card.classList.add(
        "feature-card-stretched",
        `feature-card-stretched-${this.rowUnits}`,
      );
    } else if (row.features.length === 1) {
      // Stacked hero (too narrow for side-by-side): drop the fixed aspect so the
      // height is content-driven, and floor the media at MIN_HERO_IMAGE_HEIGHT so
      // the stacked image never gets too small either.
      $card.style.setProperty("--feature-card-aspect-ratio", "auto");
      $card.style.setProperty(
        "--media-min-height",
        `${LandingFeatureGrid.MIN_HERO_IMAGE_HEIGHT}px`,
      );
      if (usesFeatureHero) {
        $card.style.setProperty(
          "--feature-card-min-height",
          `${LandingFeatureGrid.MIN_HERO_CARD_HEIGHT}px`,
        );
      }
    } else {
      // Packed (multi-card row): keep the fixed aspect, but let live feature
      // heroes reserve enough media height to stay readable in narrow two-up rows.
      $card.style.setProperty(
        "--feature-card-aspect-ratio",
        LandingFeatureGrid.aspectRatioFor(
          rowFeature.span,
          row.units,
          this.rowUnits,
        ),
      );
      if (usesFeatureHero) {
        $card.style.setProperty(
          "--media-min-height",
          "var(--feature-card-hero-min-height)",
        );
        $card.style.setProperty(
          "--feature-card-min-height",
          `${LandingFeatureGrid.MIN_HERO_CARD_HEIGHT}px`,
        );
      } else {
        $card.style.removeProperty("--media-min-height");
        $card.style.removeProperty("--feature-card-min-height");
      }
    }

    return $card;
  }

  private imagePositionFor(
    isStretchedSingle: boolean,
  ): LandingCard.Props["imagePosition"] {
    return isStretchedSingle ? "right" : "bottom";
  }

  private defaultHeroVisualFor(
    heroProps: Option<FeatureCardHero.Props>,
    rowFeature: LandingFeatureGrid.RowFeature,
    isStretchedSingle: boolean,
  ): Option<() => HTMLElement> {
    if (heroProps == null) return null;

    const washId = LandingFeatureGrid.washIdFor(rowFeature);
    return () => {
      const $hero = FeatureCardHero.makeWith({
        ...heroProps,
        tileFormat: this.tileFormat,
      });
      $hero.style.setProperty(
        "--feature-card-hero-soft-bg",
        CuratedWashes.byIdOr(washId, CuratedWashes.ALL[0]).softBackground,
      );
      if (!isStretchedSingle) {
        $hero.style.setProperty(
          "--feature-card-hero-soft-bg-opacity",
          "0.06",
        );
      }
      return $hero;
    };
  }

  // The curated wash id for a feature's wash (and its complementing hero soft-bg).
  private static washIdFor(
    rowFeature: LandingFeatureGrid.RowFeature,
  ): string {
    return LandingFeatureGrid.FEATURE_WASH_SEQUENCE[
      rowFeature.index % LandingFeatureGrid.FEATURE_WASH_SEQUENCE.length
    ];
  }

  private static makeGradientBackdrop(
    rowFeature: LandingFeatureGrid.RowFeature,
  ): HTMLElement {
    const $wash = GradientSplatWash.makeWith({
      wash: LandingFeatureGrid.washIdFor(rowFeature),
    });
    $wash.classList.add("feature-gradient-wash");
    return $wash;
  }

  private heroPropsFor(
    feature: LandingFeatureGrid.Feature,
  ): Option<FeatureCardHero.Props> {
    const assetSrc = feature.assetSrc ?? null;
    if (assetSrc != null && this.assetRegistry != null) {
      const resolved = this.assetRegistry.resolve(assetSrc);
      if (resolved && resolved.kind === "hero") return resolved.props ?? null;
    }

    const hero = feature.hero;
    if (hero == null || this.heroRegistry == null) return null;
    return this.heroRegistry.resolveHero(hero);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #layout {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .feature-row {
        display: flex;
        gap: 4px;
        align-items: flex-start;
      }

      .feature-card {
        min-width: 0;
        max-width: 100%;
        aspect-ratio: var(--feature-card-aspect-ratio, 1 / 1);
        --media-min-height: 0px;
      }

      :host([card-treatment="app-colors"]) .feature-card {
        --card-bg: var(--bg);
        --card-border: 1px solid var(--divider);
        --card-shadow: var(--box-shadow-very-light, 0 1px 2px rgba(0, 0, 0, 0.04));
        --card-hover-shadow: var(--box-shadow-light, 0 6px 20px rgba(0, 0, 0, 0.08));
        --feature-card-hero-bg: color-mix(
          in srgb,
          var(--bg) 96%,
          var(--text-pri) 4%
        );
      }

      .feature-card-span-1 {
        flex: 1 1 0;
        --feature-card-aspect-ratio: 1 / 1;
      }

      .feature-card-span-2 {
        flex: 2 1 0;
        --feature-card-aspect-ratio: 2 / 1;
      }

      .feature-card-stretched-2 {
        --feature-card-aspect-ratio: 2 / 1;
      }

      /* Typography comes from FEATURE_CARD_TEXT; the grid only adds the
         fixed-aspect cards' two-line clamp. */
      .feature-card .card-title,
      .feature-card .card-subtitle {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Reserve a full two lines for the subtitle so the title(1 line) +
         subtitle(2 lines) block is the same height across every card in a row,
         even when a description comes up one line short. This is exactly 2x the
         element's computed line-height (line-height itself is
         calc(--rfont-size * --line-height-ratio) — see Typography.$style), so it
         tracks the baseline-capheight metrics and overrides the built-in
         one-line floor (min-height: var(--font-size)). */
      .feature-card .card-subtitle {
        min-height: calc(2 * var(--rfont-size) * var(--line-height-ratio));
      }

      @media (max-width: 768px) {
        .feature-card {
          --feature-card-aspect-ratio: 1 / 1;
        }
      }
    `,
    FEATURE_CARD_TEXT,
  ];

  static $html = html`<div id="layout"></div>`;
}

export namespace LandingFeatureGrid {
  /** The narrow capability the grid needs from a presentation registry.
   *  Keeping it structural prevents this reusable landing component from
   *  importing the concrete all-product asset catalogue and its SDK graph. */
  export type AssetRegistry = {
    resolve(src: string): Option<{
      kind: string;
      props?: Option<FeatureCardHero.Props>;
    }>;
  };
  // One curated wash per family, ordered for hue variety down the feature grid.
  export const FEATURE_WASH_SEQUENCE: readonly string[] = [
    "citrus-1",
    "reef-1",
    "rose-pine-1",
    "sunset-1",
    "carnival-1",
    "meadow-1",
    "prism-1",
    "ember-1",
    "coral-1",
    "primary-1",
    "dusk-1",
    "sunset-sea-1",
  ];

  export type CardTreatment = "default" | "app-colors";

  export type Span = 1 | 2 | 3;
  export type RowSpan = 1 | 2;
  export type RowUnits = RowSpan;

  export type Feature = {
    title: string;
    description: string;
    span: Option<number>;
    assetSrc?: Option<string>;
    hero: Option<FeatureCardHero.HeroRef>;
    // Per-card overrides for interactive cards (e.g. Themes). When `renderVisual`
    // is set it replaces the registry hero as the card media; `renderAccessory`
    // renders under the title/description in the card's accessory slot.
    renderVisual?: Option<() => HTMLElement>;
    renderIcon?: Option<() => HTMLElement>;
    renderAccessory?: Option<() => HTMLElement>;
    // Layout affinity: when true, this card takes its own full-width row instead
    // of packing alongside siblings.
    ownRow?: Option<boolean>;
  };

  export type Props = {
    features: Feature[];
    assetRegistry?: Option<AssetRegistry>;
    heroRegistry: Option<FeatureCardHero.Registry>;
    cardTreatment: Option<CardTreatment>;
  };

  export type RowFeature = {
    feature: Feature;
    span: RowSpan;
    index: number;
  };

  export type Row = {
    features: RowFeature[];
    units: number;
  };

  // Below this grid width multi-card rows collapse to a single column (PACKING
  // only). Kept at 480 so the two small span-1 cards stay 2-up (compact,
  // image-bottom) through ~480–560px. NOTE: a sole/hero card's top/bottom ↔
  // left/right tiling is NOT governed by this — that's the image-height
  // constraint (heroFitsSideBySide / MIN_HERO_IMAGE_HEIGHT), applied per-card.
  export const TWO_UNIT_MIN_WIDTH = 480;
  export const DESKTOP_TILE_MIN_WIDTH = 1180;

  // The landscape aspect a card uses tiled side-by-side (left/right). Equals
  // aspectRatioFor for a stretched single (2 × 2 × 1.28 / 2 = 2.56), span-
  // independent. In left/right the media fills the card height, so the image
  // height is cardWidth / HERO_ROW_ASPECT.
  export const HERO_ROW_ASPECT = 2.56;

  // The image-height constraint: a sole/hero card stays side-by-side only while
  // its left/right image height would be >= this; below it the card tiles to
  // top/bottom (stacked), where --media-min-height is the media's preferred
  // height but can still shrink inside fixed-height cards. The single tunable
  // knob: ~200 puts the switch at ~viewport 560.
  export const MIN_HERO_IMAGE_HEIGHT = FeatureCardHero.MIN_HEIGHT;
  export const MIN_HERO_CARD_HEIGHT = MIN_HERO_IMAGE_HEIGHT + 112;

  export function normalizeSpan(span: Option<number>): Span {
    if (span === 2) return 2;
    if (span === 3) return 3;
    return 1;
  }

  export function rowUnitsForWidth(width: number): RowUnits {
    if (width < TWO_UNIT_MIN_WIDTH) return 1;
    return 2;
  }

  export function tileFormatForWidth(
    width: number,
  ): FeatureCardHero.TileFormat {
    if (width < TWO_UNIT_MIN_WIDTH) return "mobile";
    if (width < DESKTOP_TILE_MIN_WIDTH) return "tablet";
    return "desktop";
  }

  // True while a sole/hero card's left/right image height stays >= the minimum;
  // drives the top/bottom ↔ left/right tiling switch (see onSizeChange).
  export function heroFitsSideBySide(width: number): boolean {
    return width / HERO_ROW_ASPECT >= MIN_HERO_IMAGE_HEIGHT;
  }

  export function clampSpanToUnits(span: Span, rowUnits: RowUnits): RowSpan {
    if (rowUnits === 1) return 1;
    if (span === 3) return 2;
    return span;
  }

  export function aspectRatioFor(
    span: RowSpan,
    occupiedUnits: number,
    rowUnits: RowUnits,
  ): string {
    const widthRatio = span * rowUnits * rowHeightCompression(rowUnits);
    return `${widthRatio} / ${occupiedUnits}`;
  }

  function rowHeightCompression(rowUnits: RowUnits): number {
    if (rowUnits === 1) return 1.18;
    return 1.28;
  }

  export function rowsFor(features: Feature[], rowUnits: RowUnits): Row[] {
    const rows: Row[] = [];
    let row: Row = { features: [], units: 0 };
    let index = 0;

    for (const feature of features) {
      // An own-row card flushes the current row and takes a full-width row alone.
      if (feature.ownRow) {
        if (row.features.length > 0) {
          rows.push(row);
          row = { features: [], units: 0 };
        }
        rows.push({
          features: [{ feature, span: rowUnits, index }],
          units: rowUnits,
        });
        index++;
        continue;
      }

      const span = clampSpanToUnits(normalizeSpan(feature.span), rowUnits);
      if (row.features.length > 0 && row.units + span > rowUnits) {
        rows.push(row);
        row = { features: [], units: 0 };
      }

      row.features.push({ feature, span, index });
      row.units += span;
      index++;

      if (row.units >= rowUnits) {
        rows.push(row);
        row = { features: [], units: 0 };
      }
    }

    if (row.features.length > 0) rows.push(row);
    return rows;
  }
}
