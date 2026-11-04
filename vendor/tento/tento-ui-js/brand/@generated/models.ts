export interface Award {
  label: string;
  source: string;
  year?: Option<number>;
}
export namespace Award {
  export function parse(raw: UntypedJson): Award {
    return raw;
  }
}
export interface CaseStudy {
  company: string;
  description?: Option<string>;
  logoUrl?: Option<string>;
  metric: string;
}
export namespace CaseStudy {
  export function parse(raw: UntypedJson): CaseStudy {
    return raw;
  }
}
export interface ComparisonRow {
  competitor?: Option<string>;
  feature: string;
  ours: string;
  theirs?: Option<string>;
}
export namespace ComparisonRow {
  export function parse(raw: UntypedJson): ComparisonRow {
    return raw;
  }
}
export interface ComparisonTable {
  columns: string[];
  rows: ComparisonRow[];
}
export namespace ComparisonTable {
  export function parse(raw: UntypedJson): ComparisonTable {
    raw.rows && (raw.rows = raw.rows.map(ComparisonRow.parse));
    return raw;
  }
}
export interface ComparisonSection {
  comparisons?: Option<ComparisonRow[]>;
  heading?: Option<string>;
  subtext?: Option<string>;
  table?: Option<ComparisonTable>;
}
export namespace ComparisonSection {
  export function parse(raw: UntypedJson): ComparisonSection {
    raw.comparisons && (raw.comparisons = raw.comparisons.map(ComparisonRow.parse));
    raw.table && (raw.table = ComparisonTable.parse(raw.table));
    return raw;
  }
}
export interface Cta {
  href: string;
  label: string;
}
export namespace Cta {
  export function parse(raw: UntypedJson): Cta {
    return raw;
  }
}
export interface CtaSection {
  heading: string;
  primaryCta: Cta;
  secondaryCta?: Option<Cta>;
  subtext?: Option<string>;
}
export namespace CtaSection {
  export function parse(raw: UntypedJson): CtaSection {
    raw.primaryCta && (raw.primaryCta = Cta.parse(raw.primaryCta));
    raw.secondaryCta && (raw.secondaryCta = Cta.parse(raw.secondaryCta));
    return raw;
  }
}
export interface FaqItem {
  answer: string;
  question: string;
}
export namespace FaqItem {
  export function parse(raw: UntypedJson): FaqItem {
    return raw;
  }
}
export interface FaqSection {
  heading?: Option<string>;
  items: FaqItem[];
}
export namespace FaqSection {
  export function parse(raw: UntypedJson): FaqSection {
    raw.items && (raw.items = raw.items.map(FaqItem.parse));
    return raw;
  }
}
export type FeatureMediaType = "screenshot" | "illustration" | "video";
export interface FeatureMedia {
  alt?: Option<string>;
  src: string;
  type: FeatureMediaType;
}
export namespace FeatureMedia {
  export function parse(raw: UntypedJson): FeatureMedia {
    return raw;
  }
}
export interface FeatureHero {
  kind: string;
}
export namespace FeatureHero {
  export function parse(raw: UntypedJson): FeatureHero {
    return raw;
  }
}
export interface Feature {
  badge?: Option<string>;
  description: string;
  hero?: Option<FeatureHero>;
  icon?: Option<string>;
  media?: Option<FeatureMedia>;
  name: string;
  span?: Option<number>;
}
export namespace Feature {
  export function parse(raw: UntypedJson): Feature {
    raw.hero && (raw.hero = FeatureHero.parse(raw.hero));
    raw.media && (raw.media = FeatureMedia.parse(raw.media));
    return raw;
  }
}
export type FeatureSectionTheme = "light" | "dark" | "accent";
export interface FeatureSection {
  features: Feature[];
  heading: string;
  subtext?: Option<string>;
  theme?: Option<FeatureSectionTheme>;
}
export namespace FeatureSection {
  export function parse(raw: UntypedJson): FeatureSection {
    raw.features && (raw.features = raw.features.map(Feature.parse));
    return raw;
  }
}
export interface NavLink {
  href: string;
  label: string;
}
export namespace NavLink {
  export function parse(raw: UntypedJson): NavLink {
    return raw;
  }
}
export interface FooterGroup {
  label: string;
  links: NavLink[];
}
export namespace FooterGroup {
  export function parse(raw: UntypedJson): FooterGroup {
    raw.links && (raw.links = raw.links.map(NavLink.parse));
    return raw;
  }
}
export type SocialPlatform = "twitter" | "linkedin" | "github" | "youtube" | "instagram" | "facebook" | "discord" | "bluesky";
export interface SocialLink {
  href: string;
  platform: SocialPlatform;
}
export namespace SocialLink {
  export function parse(raw: UntypedJson): SocialLink {
    return raw;
  }
}
export interface FooterSection {
  groups: FooterGroup[];
  legal: NavLink[];
  social?: Option<SocialLink[]>;
}
export namespace FooterSection {
  export function parse(raw: UntypedJson): FooterSection {
    raw.groups && (raw.groups = raw.groups.map(FooterGroup.parse));
    raw.legal && (raw.legal = raw.legal.map(NavLink.parse));
    raw.social && (raw.social = raw.social.map(SocialLink.parse));
    return raw;
  }
}
export type HeroMediaType = "screenshot" | "video" | "animation";
export interface HeroMedia {
  alt?: Option<string>;
  src: string;
  type: HeroMediaType;
}
export namespace HeroMedia {
  export function parse(raw: UntypedJson): HeroMedia {
    return raw;
  }
}
export interface HeroSection {
  badge?: Option<string>;
  headline: string;
  media?: Option<HeroMedia>;
  primaryCta: Cta;
  secondaryCta?: Option<Cta>;
  subheadline: string;
}
export namespace HeroSection {
  export function parse(raw: UntypedJson): HeroSection {
    raw.media && (raw.media = HeroMedia.parse(raw.media));
    raw.primaryCta && (raw.primaryCta = Cta.parse(raw.primaryCta));
    raw.secondaryCta && (raw.secondaryCta = Cta.parse(raw.secondaryCta));
    return raw;
  }
}
export interface Integration {
  category?: Option<string>;
  logoUrl?: Option<string>;
  name: string;
}
export namespace Integration {
  export function parse(raw: UntypedJson): Integration {
    return raw;
  }
}
export interface IntegrationsSection {
  heading?: Option<string>;
  integrations: Integration[];
  subtext?: Option<string>;
  viewAllHref?: Option<string>;
}
export namespace IntegrationsSection {
  export function parse(raw: UntypedJson): IntegrationsSection {
    raw.integrations && (raw.integrations = raw.integrations.map(Integration.parse));
    return raw;
  }
}
export type SchemaType = "FAQ" | "Product" | "Organization" | "SoftwareApplication" | "WebSite" | "BreadcrumbList";
export interface PageMeta {
  canonicalUrl?: Option<string>;
  description: string;
  longTailKeywords?: Option<string[]>;
  ogDescription?: Option<string>;
  ogImage?: Option<string>;
  ogTitle?: Option<string>;
  primaryKeyword: string;
  schemaTypes?: Option<SchemaType[]>;
  secondaryKeywords: string[];
  title: string;
}
export namespace PageMeta {
  export function parse(raw: UntypedJson): PageMeta {
    return raw;
  }
}
export type PricePeriod = "month" | "year";
export type Price = {
  type: "free";
} | {
  amount: number;
  currency: string;
  note?: Option<string>;
  period: PricePeriod;
  type: "fixed";
} | {
  label: string;
  type: "custom";
};
export interface PricingTier {
  cta: Cta;
  features: string[];
  highlighted?: Option<boolean>;
  name: string;
  price: Price;
  tagline?: Option<string>;
}
export namespace PricingTier {
  export function parse(raw: UntypedJson): PricingTier {
    raw.cta && (raw.cta = Cta.parse(raw.cta));
    return raw;
  }
}
export interface PricingSection {
  billingNote?: Option<string>;
  heading?: Option<string>;
  subtext?: Option<string>;
  tiers: PricingTier[];
}
export namespace PricingSection {
  export function parse(raw: UntypedJson): PricingSection {
    raw.tiers && (raw.tiers = raw.tiers.map(PricingTier.parse));
    return raw;
  }
}
export interface Logo {
  logoUrl?: Option<string>;
  name: string;
}
export namespace Logo {
  export function parse(raw: UntypedJson): Logo {
    return raw;
  }
}
export interface Stat {
  label: string;
  value: string;
}
export namespace Stat {
  export function parse(raw: UntypedJson): Stat {
    return raw;
  }
}
export interface Testimonial {
  authorName: string;
  authorTitle?: Option<string>;
  avatarUrl?: Option<string>;
  company?: Option<string>;
  quote: string;
}
export namespace Testimonial {
  export function parse(raw: UntypedJson): Testimonial {
    return raw;
  }
}
export interface SocialProofSection {
  awards?: Option<Award[]>;
  caseStudies?: Option<CaseStudy[]>;
  logos?: Option<Logo[]>;
  stats?: Option<Stat[]>;
  testimonials?: Option<Testimonial[]>;
}
export namespace SocialProofSection {
  export function parse(raw: UntypedJson): SocialProofSection {
    raw.awards && (raw.awards = raw.awards.map(Award.parse));
    raw.caseStudies && (raw.caseStudies = raw.caseStudies.map(CaseStudy.parse));
    raw.logos && (raw.logos = raw.logos.map(Logo.parse));
    raw.stats && (raw.stats = raw.stats.map(Stat.parse));
    raw.testimonials && (raw.testimonials = raw.testimonials.map(Testimonial.parse));
    return raw;
  }
}
export interface LandingPage {
  comparison?: Option<ComparisonSection>;
  cta?: Option<CtaSection>;
  faq?: Option<FaqSection>;
  features: FeatureSection[];
  footer: FooterSection;
  hero: HeroSection;
  integrations?: Option<IntegrationsSection>;
  meta: PageMeta;
  pricing?: Option<PricingSection>;
  socialProof: SocialProofSection;
}
export namespace LandingPage {
  export function parse(raw: UntypedJson): LandingPage {
    raw.comparison && (raw.comparison = ComparisonSection.parse(raw.comparison));
    raw.cta && (raw.cta = CtaSection.parse(raw.cta));
    raw.faq && (raw.faq = FaqSection.parse(raw.faq));
    raw.features && (raw.features = raw.features.map(FeatureSection.parse));
    raw.footer && (raw.footer = FooterSection.parse(raw.footer));
    raw.hero && (raw.hero = HeroSection.parse(raw.hero));
    raw.integrations && (raw.integrations = IntegrationsSection.parse(raw.integrations));
    raw.meta && (raw.meta = PageMeta.parse(raw.meta));
    raw.pricing && (raw.pricing = PricingSection.parse(raw.pricing));
    raw.socialProof && (raw.socialProof = SocialProofSection.parse(raw.socialProof));
    return raw;
  }
}
export interface NavDropdownItem {
  description?: Option<string>;
  href: string;
  label: string;
}
export namespace NavDropdownItem {
  export function parse(raw: UntypedJson): NavDropdownItem {
    return raw;
  }
}
export interface NavDropdownColumn {
  bold?: Option<boolean>;
  items: NavDropdownItem[];
  title: string;
}
export namespace NavDropdownColumn {
  export function parse(raw: UntypedJson): NavDropdownColumn {
    raw.items && (raw.items = raw.items.map(NavDropdownItem.parse));
    return raw;
  }
}
export interface NavDropdownImage {
  alt?: Option<string>;
  src: string;
}
export namespace NavDropdownImage {
  export function parse(raw: UntypedJson): NavDropdownImage {
    return raw;
  }
}
export interface NavDropdown {
  columns: NavDropdownColumn[];
  footer?: Option<NavLink>;
  header?: Option<string>;
  image?: Option<NavDropdownImage>;
}
export namespace NavDropdown {
  export function parse(raw: UntypedJson): NavDropdown {
    raw.columns && (raw.columns = raw.columns.map(NavDropdownColumn.parse));
    raw.footer && (raw.footer = NavLink.parse(raw.footer));
    raw.image && (raw.image = NavDropdownImage.parse(raw.image));
    return raw;
  }
}
export interface SiteNavItem {
  details?: Option<NavDropdown>;
  href: string;
  label: string;
}
export namespace SiteNavItem {
  export function parse(raw: UntypedJson): SiteNavItem {
    raw.details && (raw.details = NavDropdown.parse(raw.details));
    return raw;
  }
}
export interface SiteNav {
  cta?: Option<NavLink>;
  items: SiteNavItem[];
}
export namespace SiteNav {
  export function parse(raw: UntypedJson): SiteNav {
    raw.cta && (raw.cta = NavLink.parse(raw.cta));
    raw.items && (raw.items = raw.items.map(SiteNavItem.parse));
    return raw;
  }
}
