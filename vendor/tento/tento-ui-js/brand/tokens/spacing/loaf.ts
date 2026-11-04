import { css } from "../../../component-styles";

export const loaf = css`
  :host {
    --max-width: 1080px;
    --brand-inline-padding: 40px;
    --brand-inline-padding-mobile: 16px;
    --headline-size: var(--loaf-size-headline);
    --h1-size: var(--loaf-size-page-heading);
    --h2-size: var(--loaf-size-section-heading);
    --h3-size: var(--text-16px);
    --h4-size: var(--text-15px);
    --h5-size: var(--text-14px);
    --h6-size: var(--text-13px);
    --p-size: var(--loaf-size-body);
    --small-size: var(--loaf-size-meta);
  }

  .headline {
    --font-size: var(--headline-size);
    --line-height-ratio: 1.08;
    --margin-top: 40px;
    --margin-bottom: 40px;
    max-width: 880px;
  }

  .subtitle {
    --font-size: var(--loaf-size-body-large);
    --line-height-ratio: 1.62;
    --margin-top: 0px;
    --margin-bottom: 42px;
    max-width: 650px;
  }

  .kicker {
    --font-size: var(--loaf-size-meta);
    --margin-top: 0px;
    --margin-bottom: 20px;
  }

  .section-title {
    --font-size: var(--loaf-size-section-title);
    --line-height-ratio: 1.08;
    --margin-top: 0px;
    --margin-bottom: 44px;
  }

  .card-title {
    --font-size: var(--loaf-size-card-heading);
    --line-height-ratio: 1.18;
    --margin-top: 0px;
    --margin-bottom: 16px;
  }

  .card-description,
  .card-subtitle {
    --font-size: var(--loaf-size-card-body);
    --line-height-ratio: 1.52;
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .metric-value {
    --font-size: var(--loaf-size-page-heading);
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .quote {
    --font-size: var(--loaf-size-quote);
    --line-height-ratio: 1.5;
    --margin-top: 0px;
    --margin-bottom: 18px;
  }

  .company {
    --font-size: var(--loaf-size-meta-large);
    --margin-top: 0px;
    --margin-bottom: 8px;
  }

  h1 {
    --font-size: var(--h1-size);
    --line-height-ratio: 1.12;
    --margin-top: 48px;
    --margin-bottom: 32px;
  }

  h2 {
    --font-size: var(--h2-size);
    --line-height-ratio: 1.16;
    --margin-top: 52px;
    --margin-bottom: 30px;
  }

  h3 {
    --font-size: var(--h3-size);
    --line-height-ratio: 1.22;
    --margin-top: 34px;
    --margin-bottom: 28px;
  }

  h4 {
    --margin-top: 32px;
    --margin-bottom: 18px;
  }

  h5,
  h6 {
    --margin-top: 24px;
    --margin-bottom: 14px;
  }

  p,
  ul,
  ol {
    --line-height-ratio: 1.6;
    --margin-top: 0px;
    --margin-bottom: 26px;
  }

  blockquote {
    /* top/bottom 18 = a little internal breathing room; left 14 sits the text
       closer to the bar (less left inset); right 20. */
    padding: 18px 20px 18px 14px;
    --line-height-ratio: 1.62;
    --margin-top: 36px;
    --margin-bottom: 36px;
  }

  /* Neutralize the inner paragraph's leading/trailing margins so the blockquote's
     own 14px top/bottom padding is what shows — symmetric block padding, with the
     bar's rounded caps evenly placed. */
  blockquote > :first-child {
    --margin-top: 0px;
  }

  blockquote > :last-child {
    --margin-bottom: 0px;
  }

  .blog-post-title {
    max-width: 780px;
    /* Match the section headers (e.g. "See what the week can hold" = --text-22px). */
    --font-size: var(--text-22px);
    --line-height-ratio: 1.12;
    --margin-top: 0px;
    --margin-bottom: 22px;
  }

  .blog-post-meta {
    gap: 12px;
  }

  .blog-post-category,
  .tag {
    --font-size: var(--loaf-size-meta);
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .blog-post-date {
    --font-size: var(--text-10px);
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .tag-list {
    gap: 8px;
    flex-wrap: wrap;
  }

  .hero-title {
    /* Match the "See what the week can hold" section heading
       (LandingSectionIntro #heading = --text-22px). */
    --font-size: var(--text-22px);
    --line-height-ratio: 1.12;
    --margin-top: 0px;
    --margin-bottom: 16px;
  }

  .hero-subtitle {
    --font-size: var(--text-12px);
    --line-height-ratio: 1.52;
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .simple-title {
    --font-size: var(--loaf-size-body-large);
    --line-height-ratio: 1.38;
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .simple-date,
  .simple-snippet {
    --font-size: var(--loaf-size-meta);
    --line-height-ratio: 1.42;
    --margin-top: 0px;
    --margin-bottom: 0px;
  }

  .brand-footer-line {
    --font-size: var(--text-11px);
  }

  .back-link {
    margin-left: -28px;
  }

  @media (max-width: 1024px) {
    .headline {
      --font-size: var(--loaf-size-headline-tablet);
    }
  }

  @media (max-width: 768px) {
    .headline {
      --font-size: var(--loaf-size-headline-mobile);
    }

    .subtitle {
      --font-size: var(--text-12px);
    }

    .blog-post-title,
    .hero-title {
      --font-size: var(--loaf-size-article-title-mobile);
    }

    /* Drop the hanging indent on mobile: the reduced header padding (16px) is
       smaller than the -28px pull, so the arrow would bleed off the left edge.
       Align the whole link to the content edge instead. */
    .back-link {
      margin-left: 0;
    }
  }
`;
