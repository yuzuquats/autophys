import { css } from "../../../component-styles";

export const editorial = css`
  :host {
    --headline-size: var(--text-28px);
  }
  h1 { --font-size: var(--h1-size); --margin-top: 48px; --margin-bottom: 28px; }
  h2 { --font-size: var(--text-18px); --margin-top: 56px; --margin-bottom: 20px; color: var(--text-pri); }
  h3 { --font-size: var(--text-16px); --margin-top: 44px; --margin-bottom: 16px; color: var(--text-pri); }
  h4 { --font-size: var(--text-15px); --margin-top: 32px; --margin-bottom: 16px; color: var(--text-pri); }
  h5 { --font-size: var(--text-14px); --margin-top: 24px; --margin-bottom: 12px; color: var(--text-pri); }
  h6 { --font-size: var(--text-13px); --margin-top: 20px; --margin-bottom: 12px; color: var(--text-pri); }
  p {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.4;
    --margin-top: 12px;
    --margin-bottom: 12px;
    color: var(--text-pri);
    font-family: "Times New Roman", Georgia, "Nimbus Roman No9 L", serif;
  }
  > :last-child { --margin-bottom: 0px !important; }
  > :first-child { --margin-top: 0px !important; }
  ul, ol {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.4;
    --margin-top: 12px;
    --margin-bottom: 12px;
    padding-left: 24px;
    font-family: "Times New Roman", Georgia, "Nimbus Roman No9 L", serif;
  }
  blockquote {
    border-left: 3px solid var(--divider);
    padding-left: 12px;
    color: var(--text-ter);
    font-style: italic;
    --margin-top: 24px;
    --margin-bottom: 24px;
  }
  a { color: var(--text-pri); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { opacity: 0.8; }
`;
