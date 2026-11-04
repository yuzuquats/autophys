import { css } from "../../../component-styles";

export const ui = css`
  .blog-post-title { max-width: 760px; font-weight: 700; }
  .blog-post-meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-ter);
    font-family: sans-serif;
  }

  .blog-post-meta-row > .small {
    --font-size: var(--text-12px);
    --margin-top: 0px;
    --margin-bottom: 0px;
    color: var(--text-ter);
    font-family: sans-serif;
  }

  .blog-post-meta-row > *:not(:first-child)::before {
    content: "·";
    margin-right: 8px;
    color: var(--text-ter);
  }

  .blog-post-category {
    text-transform: capitalize;
  }

  .tag { color: var(--text-ter); }
  .hero-title { margin: 0 0 20px; }
  .hero-subtitle { margin: 0; color: var(--text-sec); }
  .section-title { margin: 0 0 16px; }
  .search-input { --font-size: var(--text-12px); color: var(--text-sec); }
  .newsroom-category {
    color: var(--text-sec); letter-spacing: 0.01em;
    --font-size: var(--text-11px); --line-height-ratio: 1.2;
    --margin-top: 0px; --margin-bottom: 28px;
    width: 100%; text-align: center; font-family: sans-serif;
  }
  .newsroom-title {
    --font-size: var(--headline-size); --line-height-ratio: 1.08;
    --margin-top: 0px; --margin-bottom: 44px;
    width: 100%; text-align: center; font-family: sans-serif; font-weight: 500;
  }
  .newsroom-meta {
    color: var(--text-ter); --font-size: var(--text-11px); --line-height-ratio: 1.25;
    --margin-top: 0px; --margin-bottom: 0px;
    width: 100%; text-align: center; font-family: sans-serif;
  }
`;
