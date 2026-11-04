import { css } from "../../../component-styles";

export const bear = css`
  :host {
    --max-width: 720px;
    --bear-line-height: 1.5;
  }
  .brand-nav-link {
    --font-size: var(--text-12px);
  }
  .search-input {
    --font-size: var(--text-12px);
  }
  .blog-post-title {
    --font-size: var(--text-18px);
    --line-height-ratio: 1.3;
    --margin-top: 40px;
    --margin-bottom: 40px;
  }
  .blog-post-date {
    --font-size: var(--text-12px);
    margin: 0;
  }
  time,
  .bear-date {
    --font-size: var(--text-11px);
    display: inline-block;
  }
  time {
    --margin-top: 0px;
    --margin-bottom: 0px;
  }
  .brand-footer-line {
    margin: 0;
  }
`;
