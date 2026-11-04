import { css } from "../../../component-styles";

export const bear = css`
  h1 {
    --font-size: var(--text-18px);
    --line-height-ratio: 1.3;
    --margin-top: 40px;
    --margin-bottom: 40px;
  }
  h2 {
    --font-size: var(--text-16px);
    --line-height-ratio: 1.35;
    --margin-top: 36px;
    --margin-bottom: 24px;
  }
  h3,
  h4,
  h5,
  h6 {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.4;
    --margin-top: 30px;
    --margin-bottom: 20px;
  }
  .p, p,
  li {
    --font-size: var(--text-12px);
    --line-height-ratio: var(--bear-line-height);
    --margin-top: 0px;
    --margin-bottom: 20px;
  }
  ul,
  ol {
    padding-left: 20px;
    --margin-top: 0px;
    --margin-bottom: 16px;
  }
  blockquote {
    border-left: 1px solid #999;
    padding-left: 16px;
    --margin-top: 24px;
    --margin-bottom: 24px;
  }
  a {
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  > :last-child {
    --margin-bottom: 0px !important;
  }
  > :first-child {
    --margin-top: 0px !important;
  }
`;
