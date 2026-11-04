//! Copied from `tento-web-brand/src/brand.rs` at tento 7518a92b86 (lines 1-412,
//! its tests dropped). The only edit: each `ToSchema` derive became
//! `tento_openapi::ToSchema, tento_openapi::ToSchema`.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum HeroMediaType {
  Screenshot,
  Video,
  Animation,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FeatureMediaType {
  Screenshot,
  Illustration,
  Video,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FeatureSectionTheme {
  Light,
  Dark,
  Accent,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SocialPlatform {
  Twitter,
  Linkedin,
  Github,
  Youtube,
  Instagram,
  Facebook,
  Discord,
  Bluesky,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PricePeriod {
  Month,
  Year,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
pub enum SchemaType {
  #[serde(rename = "FAQ")]
  Faq,
  #[serde(rename = "Product")]
  Product,
  #[serde(rename = "Organization")]
  Organization,
  #[serde(rename = "SoftwareApplication")]
  SoftwareApplication,
  #[serde(rename = "WebSite")]
  WebSite,
  #[serde(rename = "BreadcrumbList")]
  BreadcrumbList,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cta {
  pub label: String,
  pub href: String,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CtaSection {
  pub heading: String,
  pub subtext: Option<String>,
  pub primary_cta: Cta,
  pub secondary_cta: Option<Cta>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeroMedia {
  #[serde(rename = "type")]
  pub media_type: HeroMediaType,
  pub src: String,
  pub alt: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeroSection {
  pub badge: Option<String>,
  pub headline: String,
  pub subheadline: String,
  pub primary_cta: Cta,
  pub secondary_cta: Option<Cta>,
  pub media: Option<HeroMedia>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeatureMedia {
  #[serde(rename = "type")]
  pub media_type: FeatureMediaType,
  pub src: String,
  pub alt: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeatureHero {
  pub kind: String,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
  pub name: String,
  pub description: String,
  pub span: Option<u8>,
  pub hero: Option<FeatureHero>,
  pub icon: Option<String>,
  pub media: Option<FeatureMedia>,
  pub badge: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeatureSection {
  pub heading: String,
  pub subtext: Option<String>,
  pub theme: Option<FeatureSectionTheme>,
  pub features: Vec<Feature>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
  pub value: String,
  pub label: String,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Logo {
  pub name: String,
  pub logo_url: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Testimonial {
  pub quote: String,
  pub author_name: String,
  pub author_title: Option<String>,
  pub company: Option<String>,
  pub avatar_url: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaseStudy {
  pub company: String,
  pub metric: String,
  pub description: Option<String>,
  pub logo_url: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Award {
  pub label: String,
  pub source: String,
  pub year: Option<u32>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SocialProofSection {
  pub stats: Option<Vec<Stat>>,
  pub logos: Option<Vec<Logo>>,
  pub testimonials: Option<Vec<Testimonial>>,
  pub case_studies: Option<Vec<CaseStudy>>,
  pub awards: Option<Vec<Award>>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
  pub feature: String,
  pub ours: String,
  pub theirs: Option<String>,
  pub competitor: Option<String>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonTable {
  pub columns: Vec<String>,
  pub rows: Vec<ComparisonRow>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonSection {
  pub heading: Option<String>,
  pub subtext: Option<String>,
  pub comparisons: Option<Vec<ComparisonRow>>,
  pub table: Option<ComparisonTable>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FaqItem {
  pub question: String,
  pub answer: String,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FaqSection {
  pub heading: Option<String>,
  pub items: Vec<FaqItem>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavLink {
  pub label: String,
  pub href: String,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavDropdownItem {
  pub label: String,
  pub href: String,
  pub description: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavDropdownColumn {
  pub title: String,
  pub items: Vec<NavDropdownItem>,
  pub bold: Option<bool>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavDropdownImage {
  pub src: String,
  pub alt: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavDropdown {
  pub header: Option<String>,
  pub columns: Vec<NavDropdownColumn>,
  pub footer: Option<NavLink>,
  pub image: Option<NavDropdownImage>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiteNavItem {
  pub label: String,
  pub href: String,
  pub details: Option<NavDropdown>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiteNav {
  pub items: Vec<SiteNavItem>,
  pub cta: Option<NavLink>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SocialLink {
  pub platform: SocialPlatform,
  pub href: String,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FooterGroup {
  pub label: String,
  pub links: Vec<NavLink>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FooterSection {
  pub groups: Vec<FooterGroup>,
  pub legal: Vec<NavLink>,
  pub social: Option<Vec<SocialLink>>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
  pub name: String,
  pub logo_url: Option<String>,
  pub category: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsSection {
  pub heading: Option<String>,
  pub subtext: Option<String>,
  pub integrations: Vec<Integration>,
  pub view_all_href: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
  pub title: String,
  pub description: String,
  pub og_title: Option<String>,
  pub og_description: Option<String>,
  pub og_image: Option<String>,
  pub canonical_url: Option<String>,
  pub primary_keyword: String,
  pub secondary_keywords: Vec<String>,
  pub long_tail_keywords: Option<Vec<String>>,
  pub schema_types: Option<Vec<SchemaType>>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Price {
  Free,
  Fixed {
    amount: f64,
    currency: String,
    period: PricePeriod,
    note: Option<String>,
  },
  Custom {
    label: String,
  },
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PricingTier {
  pub name: String,
  pub tagline: Option<String>,
  pub price: Price,
  pub features: Vec<String>,
  pub cta: Cta,
  pub highlighted: Option<bool>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PricingSection {
  pub heading: Option<String>,
  pub subtext: Option<String>,
  pub tiers: Vec<PricingTier>,
  pub billing_note: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LandingPage {
  pub meta: PageMeta,
  pub hero: HeroSection,
  pub social_proof: SocialProofSection,
  pub features: Vec<FeatureSection>,
  pub integrations: Option<IntegrationsSection>,
  pub pricing: Option<PricingSection>,
  pub comparison: Option<ComparisonSection>,
  pub faq: Option<FaqSection>,
  pub cta: Option<CtaSection>,
  pub footer: FooterSection,
}
