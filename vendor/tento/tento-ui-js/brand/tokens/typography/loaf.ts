import { css } from "../../../component-styles";

export const loafFonts: string[] = [];

export const loaf = css`
  :host {
    font-family: "Manrope", sans-serif;
    --loaf-size-headline: var(--text-28px);
    --loaf-size-headline-tablet: var(--loaf-size-headline);
    --loaf-size-headline-mobile: var(--loaf-size-headline);
    --loaf-size-page-heading: var(--text-24px);
    --loaf-size-section-heading: var(--text-20px);
    --loaf-size-section-title: var(--text-24px);
    --loaf-size-article-title: var(--text-28px);
    --loaf-size-article-title-mobile: var(--text-22px);
    --loaf-size-card-heading: var(--text-16px);
    --loaf-size-card-body: var(--text-11px);
    --loaf-size-quote: var(--text-14px);
    --loaf-size-body: var(--text-12px);
    --loaf-size-body-large: var(--text-13px);
    --loaf-size-meta: var(--text-10px);
    --loaf-size-meta-large: var(--text-11px);
    --loaf-size-search-input: var(--text-16px);
    --loaf-size-filter-label: var(--text-15px);
    --blog-search-input-size: var(--loaf-size-search-input);
    --blog-filter-pill-size: var(--loaf-size-filter-label);
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  p,
  ul,
  ol,
  blockquote,
  a,
  button,
  input,
  .headline,
  .section-title,
  .card-title,
  .card-subtitle,
  .card-description,
  .metric-value,
  .quote,
  .kicker,
  .subtitle,
  .meta,
  .company,
  .brand-nav-link,
  .brand-nav-title,
  .brand-footer-line,
  .blog-post-title,
  .blog-post-date,
  .blog-post-category,
  .tag,
  .back-link,
  .hero-title,
  .hero-subtitle,
  .simple-title,
  .simple-date,
  .simple-snippet,
  .filter-pill,
  .search-input {
    font-family: "Manrope", sans-serif;
    letter-spacing: 0;
  }

  .headline,
  .section-title,
  .card-title,
  .metric-value,
  .blog-post-title,
  .hero-title,
  .simple-title {
    font-weight: 400;
  }

  .kicker,
  .blog-post-category,
  .tag,
  .filter-pill {
    font-weight: 400;
  }

  blockquote,
  .quote {
    font-style: normal;
  }
`;
