import { css } from "../../../component-styles";

export const list = css`
  :host {
    --headline-size: var(--text-28px);
    --h1-size: var(--text-22px);
    --h2-size: var(--text-18px);
    --h3-size: var(--text-16px);
    --h4-size: var(--text-15px);
    --h5-size: var(--text-14px);
    --h6-size: var(--text-13px);
    --p-size: var(--text-12px);
    --small-size: var(--text-10px);
  }
  h1 {
    --margin-top: 48px;
    --margin-bottom: 28px;
  }
  h2 {
    --margin-top: 56px;
    --margin-bottom: 24px;
  }
  h3 {
    --margin-top: 36px;
    --margin-bottom: 24px;
  }
  h4 {
    --margin-top: 28px;
    --margin-bottom: 20px;
  }
  h5 {
    --margin-top: 24px;
    --margin-bottom: 16px;
  }
  h6 {
    --margin-top: 20px;
    --margin-bottom: 12px;
  }
  p {
    --line-height-ratio: 1.4;
    --margin-top: 12px;
    --margin-bottom: 12px;
  }
  > :last-child {
    --margin-bottom: 0px !important;
  }
  > :first-child {
    --margin-top: 0px !important;
  }
  ul,
  ol {
    padding-left: 24px;
    --line-height-ratio: 1.4;
    --margin-top: 12px;
    --margin-bottom: 12px;
  }
  blockquote {
    padding-left: 12px;
    --margin-top: 24px;
    --margin-bottom: 24px;
  }
  .blog-post-title {
    max-width: 760px;
    --margin-top: 0px;
    --margin-bottom: 24px;
  }
  .blog-post-meta {
    gap: 12px;
  }
  .blog-post-date {
    --margin-top: 0px;
    --margin-bottom: 0px;
  }
  .blog-post-category {
    --margin-top: 0px;
    --margin-bottom: 16px;
  }
  .tag {
    --margin-top: 0px;
    --margin-bottom: 0px;
  }
  .tag-list {
    gap: 8px;
    flex-wrap: wrap;
  }
  .brand-footer-line {
    --font-size: var(--text-12px);
  }
  .back-link {
    margin-left: -24px;
  }
`;
