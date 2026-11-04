import type { Brand } from "../brand";
import type {
  ComparisonRow,
  ComparisonSection,
  CtaSection,
  FaqSection,
  FeatureSection,
  HeroSection,
  PricingSection,
} from "../@generated/models";
import type { Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LandingBrowserDemo } from "./landing-browser-demo";
import { LandingComparisonTable } from "./landing-comparison-table";
import { LandingContentFrame } from "./landing-content-frame";
import { LandingCtaBlock } from "./landing-cta-block";
import { LandingFaq } from "./landing-faq";
import { LandingFeatureIcon } from "./landing-feature-icon";
import { LandingFeatureGrid } from "./landing-feature-grid";
import { LandingHero } from "./landing-hero";
import { LandingIntegrations } from "./landing-integrations";
import { LandingSection } from "./landing-section";
import { LandingSectionIntro } from "./landing-section-intro";
import { LandingSocialProof } from "./landing-social-proof";

export type LandingSectionKind =
  | "hero"
  | "features"
  | "integrations"
  | "socialProof"
  | "comparison"
  | "pricing"
  | "faq"
  | "cta";

export type LandingSectionTreatment = {
  paddingY: number;
  background: string;
  gap: number;
  border: boolean;
  first: boolean;
  maxWidth: Option<number>;
};

export type LandingDesignSystem = {
  style: Style.Compat;
  assets: {
    mainScreenshot: string;
    /**
     * Intrinsic { width, height } per asset basename (e.g. "feature-x.webp").
     * Lets the hero reserve the image box up-front (aspect-ratio) so the initial
     * load has no layout shift. Optional — falls back to natural sizing.
     */
    imageDimensions?: Record<string, { width: number; height: number }>;
  };
  sections: Record<LandingSectionKind, LandingSectionTreatment>;
  comparison: {
    markStyle: LandingComparisonTable.MarkStyle;
    fallbackDescriptions: Record<string, string>;
  };
};

export type LandingSectionFactoryConfig = {
  designSystem: LandingDesignSystem;
  renderPricingContent: (section: PricingSection) => HTMLElement;
  presentationAssetRegistry: Option<LandingFeatureGrid.AssetRegistry>;
};

type ComparisonSectionMarkConfig = {
  markStyle: Option<LandingComparisonTable.MarkStyle>;
};

type ComparisonLegend = {
  title: string;
  description: Option<string>;
};

const defaultComparisonHeadings: LandingComparisonTable.Headings = [
  "Capability",
  "Lona",
  "Other tools",
];

function normalizeLandingAsset(
  src: Option<string>,
  designSystem: LandingDesignSystem,
): string {
  if (!src) return designSystem.assets.mainScreenshot;
  if (src.startsWith("/@/")) return src;
  if (src.startsWith("/static/img/landing/")) return `/@${src}`;
  // Extracted/embedded sites serve their copied assets from their own root.
  // A root-relative URL is already normalized; rejecting it made every Acme
  // Lona page silently fall back to the calendar screenshot.
  if (src.startsWith("/")) return src;
  return designSystem.assets.mainScreenshot;
}

function landingSectionProps(
  treatment: LandingSectionTreatment,
): LandingSection.Props {
  return {
    paddingY: treatment.paddingY,
    background: treatment.background,
    gap: treatment.gap,
    border: treatment.border,
    first: treatment.first,
    maxWidth: treatment.maxWidth,
  };
}

function landingComparisonDescription(
  title: string,
  designSystem: LandingDesignSystem,
): string {
  return designSystem.comparison.fallbackDescriptions[title] ?? "";
}

function comparisonRows(section: ComparisonSection): ComparisonRow[] {
  if (section.comparisons) return section.comparisons;
  if (section.table) return section.table.rows;
  return [];
}

function comparisonHeadings(
  section: ComparisonSection,
): LandingComparisonTable.Headings {
  const columns = section.table?.columns;
  if (!columns || columns.length < 3) return defaultComparisonHeadings;
  return [
    columns[0] || defaultComparisonHeadings[0],
    columns[1] || defaultComparisonHeadings[1],
    columns[2] || defaultComparisonHeadings[2],
  ];
}

function comparisonMarkStyle(
  section: ComparisonSection,
  designSystem: LandingDesignSystem,
): LandingComparisonTable.MarkStyle {
  const configured = (section as ComparisonSection & ComparisonSectionMarkConfig)
    .markStyle;
  return configured === "unicode"
    ? "unicode"
    : designSystem.comparison.markStyle;
}

function parseComparisonCell(
  raw: string,
  fallbackTone: LandingComparisonTable.CellTone,
): LandingComparisonTable.Cell {
  if (raw.startsWith("[yes] ")) {
    return { tone: "positive", label: raw.slice("[yes] ".length) };
  }
  if (raw.startsWith("[no] ")) {
    return { tone: "negative", label: raw.slice("[no] ".length) };
  }
  if (raw.startsWith("[partial] ")) {
    return { tone: "partial", label: raw.slice("[partial] ".length) };
  }
  if (raw.trim()) {
    return { tone: fallbackTone, label: raw };
  }
  return { tone: "neutral", label: raw };
}

function parseComparisonLegend(
  raw: string,
  designSystem: LandingDesignSystem,
): ComparisonLegend {
  const [title, description] = raw.split("::", 2);
  const cleanTitle = title.trim();
  return {
    title: cleanTitle,
    description: ((
      description
      ?? landingComparisonDescription(cleanTitle, designSystem)
    )
      .trim()) || null,
  };
}

function comparisonTableProps(
  section: ComparisonSection,
  designSystem: LandingDesignSystem,
): LandingComparisonTable.Props {
  return {
    headings: comparisonHeadings(section),
    markStyle: comparisonMarkStyle(section, designSystem),
    rows: comparisonRows(section).map((row) => {
      const legend = parseComparisonLegend(row.feature, designSystem);
      return {
        feature: legend.title,
        description: legend.description,
        ours: parseComparisonCell(row.ours, "positive"),
        theirs: parseComparisonCell(row.theirs ?? "", "partial"),
      };
    }),
  };
}

function makeSection(
  treatment: LandingSectionTreatment,
): LandingSection {
  return LandingSection.makeWith(landingSectionProps(treatment));
}

export function createLandingSectionFactories(
  config: LandingSectionFactoryConfig,
): Brand.LandingPage["landing"]["sections"] {
  const designSystem = config.designSystem;

  return {
    hero: {
      make(hero) {
        const $section = makeSection(designSystem.sections.hero);
        return this.bind($section, hero);
      },
      bind($section, hero) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.hero),
        );
        DomUtils.clearChildren($section);
        const heroSrc = normalizeLandingAsset(
          hero.media?.src ?? null,
          designSystem,
        );
        const heroDims =
          designSystem.assets.imageDimensions?.[
            heroSrc.split("/").pop() ?? ""
          ] ?? null;
        $section.appendChild(LandingHero.makeWith({
          // Brand heroes don't render an eyebrow kicker/badge.
          kicker: null,
          headline: hero.headline,
          subtitle: hero.subheadline,
          ctas: [
            {
              label: hero.primaryCta.label,
              href: hero.primaryCta.href,
              primary: true,
            },
            ...(hero.secondaryCta
              ? [{
                label: hero.secondaryCta.label,
                href: hero.secondaryCta.href,
              }]
              : []),
          ],
          renderVisual: () => LandingBrowserDemo.makeWith({
            src: heroSrc,
            alt: hero.media?.alt ?? null,
            // Reserve the box from the asset's intrinsic size (per-page aspect),
            // so the hero doesn't reflow when the screenshot decodes. Falls back
            // to natural sizing when the asset has no registered dimensions.
            width: heroDims?.width ?? null,
            height: heroDims?.height ?? null,
            fetchPriority: "high",
          }),
        }));
        return $section;
      },
    },
    features: {
      make(section) {
        const $section = makeSection(designSystem.sections.features);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.features),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingSectionIntro.makeWith({
          heading: section.heading,
          subtext: section.subtext ?? null,
        }));
        $section.appendChild(
          LandingFeatureGrid.makeWith({
            features: section.features.map((feature) => ({
              title: feature.name,
              description: feature.description,
              span: LandingFeatureGrid.normalizeSpan(feature.span ?? null),
              assetSrc: feature.hero?.kind ?? null,
              hero: null,
              renderIcon: LandingFeatureIcon.renderer(feature.icon ?? null),
            })),
            assetRegistry: config.presentationAssetRegistry,
            heroRegistry: null,
            cardTreatment: null,
          }),
        );
        return $section;
      },
    },
    integrations: {
      make(section) {
        const $section = makeSection(designSystem.sections.integrations);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.integrations),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingIntegrations.makeWith({
          heading: section.heading ?? "integrations",
          integrations: section.integrations.map((integration) => ({
            name: integration.name,
            logoUrl: integration.logoUrl ?? null,
          })),
        }));
        return $section;
      },
    },
    socialProof: {
      make(section) {
        const $section = makeSection(designSystem.sections.socialProof);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.socialProof),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingSocialProof.makeWith({
          testimonials: section.testimonials ?? [],
        }));
        return $section;
      },
    },
    pricing: {
      make(section) {
        const $section = makeSection(designSystem.sections.pricing);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.pricing),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingSectionIntro.makeWith({
          heading: section.heading ?? "Simple pricing",
          subtext: section.subtext ?? section.billingNote ?? null,
        }));
        $section.appendChild(LandingContentFrame.makeWith({
          variant: "pricing",
          content: config.renderPricingContent(section),
        }));
        return $section;
      },
    },
    comparison: {
      make(section) {
        const $section = makeSection(designSystem.sections.comparison);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.comparison),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingSectionIntro.makeWith({
          heading: section.heading ?? "Built for time from the start",
          subtext: section.subtext ?? null,
        }));
        $section.appendChild(LandingComparisonTable.makeWith(
          comparisonTableProps(section, designSystem),
        ));
        return $section;
      },
    },
    faq: {
      make(section) {
        const $section = makeSection(designSystem.sections.faq);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.faq),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingSectionIntro.makeWith({
          heading: section.heading ?? "Questions",
          subtext: null,
        }));
        $section.appendChild(LandingFaq.makeWith({
          items: section.items,
        }));
        return $section;
      },
    },
    cta: {
      make(section) {
        const $section = makeSection(designSystem.sections.cta);
        return this.bind($section, section);
      },
      bind($section, section) {
        ($section as LandingSection).bind(
          landingSectionProps(designSystem.sections.cta),
        );
        DomUtils.clearChildren($section);
        $section.appendChild(LandingCtaBlock.makeWith({
          heading: section.heading,
          subtext: section.subtext ?? null,
          primaryCta: section.primaryCta,
          secondaryCta: section.secondaryCta ?? null,
        }));
        return $section;
      },
    },
  };
}

export function createLandingPageFactory(
  sections: Brand.LandingPage["landing"]["sections"],
): ComponentFactory<HTMLElement, Brand.LandingPageParams> {
  return {
    make(params) {
      const $pagelet = document.createElement("div");
      return this.bind($pagelet, params);
    },
    bind($pagelet, { model }) {
      $pagelet.className = "landing-pagelet";
      DomUtils.clearChildren($pagelet);

      $pagelet.appendChild(sections.hero.make(model.hero));
      if (model.integrations) {
        $pagelet.appendChild(sections.integrations.make(model.integrations));
      }
      for (let i = 0; i < model.features.length; i++) {
        $pagelet.appendChild(sections.features.make(model.features[i]));
      }
      if (model.comparison) {
        $pagelet.appendChild(sections.comparison.make(model.comparison));
      }
      $pagelet.appendChild(sections.socialProof.make(model.socialProof));
      if (model.pricing) {
        $pagelet.appendChild(sections.pricing.make(model.pricing));
      }
      if (model.faq) {
        $pagelet.appendChild(sections.faq.make(model.faq));
      }
      if (model.cta) {
        $pagelet.appendChild(sections.cta.make(model.cta));
      }

      return $pagelet;
    },
  };
}
