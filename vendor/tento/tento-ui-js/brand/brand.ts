import type { Style } from "../component-styles";
import type { NavConfig, NavDetailsConfig } from "./blog/blog-design-system";
import type { BlogPost, CardLayout } from "./blog/blog-types";
import type {
  HeroSection,
  FeatureSection,
  IntegrationsSection,
  SocialProofSection,
  PricingSection,
  ComparisonSection,
  FaqSection,
  CtaSection,
  FooterSection,
  LandingPage as LandingPageModel,
} from "./@generated/models";

export namespace Brand {
  // ─── Data models ───

  export namespace Models {
    export namespace Navigation {
      export type Header = NavConfig;
      export type Breadcrumb = { links: { label: string; href: string }[] };
      export type Footer = FooterSection;
    }
  }

  // ─── Design system ───

  export type DesignSystem = {
    bg: Option<string>;
    fonts: string[];
    colors: Style.Compat;
    typography: Style.Compat;
    contentTypography: Option<Style.Compat>;
    spacing: Style.Compat;
    chrome: Style.Compat;
    nav: {
      header: ComponentFactory<HTMLElement, Models.Navigation.Header>;
      breadcrumb: ComponentFactory<HTMLElement, void>;
      footer: ComponentFactory<HTMLElement, void>;
    };
    layout: ChromeVisitor;
  };

  // ─── Chrome layout ───

  export type ChromeVisitor = {
    makeLayout(parts: {
      header: HTMLElement;
      breadcrumb: HTMLElement;
      footer: HTMLElement;
    }): HTMLElement;
  };

  // ─── Page types ───

  export type LandingPageParams = {
    slug: Option<string>;
    model: LandingPageModel;
  };

  export type LandingPage = {
    ds: DesignSystem;
    landing: {
      style: Style.Compat;
      sections: {
        hero: ComponentFactory<HTMLElement, HeroSection>;
        features: ComponentFactory<HTMLElement, FeatureSection>;
        integrations: ComponentFactory<HTMLElement, IntegrationsSection>;
        socialProof: ComponentFactory<HTMLElement, SocialProofSection>;
        pricing: ComponentFactory<HTMLElement, PricingSection>;
        comparison: ComponentFactory<HTMLElement, ComparisonSection>;
        faq: ComponentFactory<HTMLElement, FaqSection>;
        cta: ComponentFactory<HTMLElement, CtaSection>;
      };
      page: ComponentFactory<HTMLElement, LandingPageParams>;
    };
  };

  export type BlogPage = {
    ds: DesignSystem;
    blog: {
      style: Style.Compat;
      post: {
        title: ComponentFactory<HTMLElement, BlogPost>;
        meta: ComponentFactory<HTMLElement, BlogPost>;
        card: ComponentFactory<HTMLElement, { post: BlogPost; layout: CardLayout }>;
      };
      routes: {
        index: BlogIndexRoute;
        post: BlogPostRoute;
      };
    };
  };

  // ─── Blog route interfaces (kept for backward compat) ───

  export interface BlogIndexRoute {
    makePagelet(delegate: BlogPage.Delegate): BlogPageletFactory;
  }

  export interface BlogPostRoute {
    makePagelet(
      post: BlogPost,
      delegate: BlogPostPage.Delegate,
      content: BlogPage["blog"]["post"],
    ): HTMLElement | Promise<HTMLElement>;
  }

  export namespace BlogPage {
    export type Delegate = {
      onSearch: (query: string) => void;
      onFilterCategory: (category: string) => void;
      onSeeMore: () => void;
      onCardClick: (slug: string) => void;
    };
  }

  export namespace BlogPostPage {
    export type Delegate = {
      onBack: () => void;
    };
  }

  export type BlogPageletFactory<TPagelet extends HTMLElement = HTMLElement> =
    ComponentFactory<TPagelet, BlogPageletProps>;

  export type BlogPageletProps = {
    posts: BlogPost[];
    featuredPosts: BlogPost[];
    displayCount: number;
    searchQuery: string;
    categoryFilter: Option<string>;
  };

  // ─── Helpers ───

  export function collectTokens(ds: DesignSystem): Style.Compat[] {
    const tokens: Style.Compat[] = [ds.chrome, ds.colors, ds.typography, ds.spacing];
    if (ds.contentTypography) tokens.push(ds.contentTypography);
    return tokens;
  }

  export function collectBlogTokens(page: BlogPage): Style.Compat[] {
    return [...collectTokens(page.ds), page.blog.style];
  }

  export function collectLandingTokens(page: LandingPage): Style.Compat[] {
    return [...collectTokens(page.ds), page.landing.style];
  }
}
