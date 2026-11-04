import { css } from "../../../component-styles";

export const comfortable = css`
  :host {
    --max-width: 1080px;
    --brand-inline-padding: 40px;
    --headline-size: var(--text-48px);
    --h1-size: var(--text-28px);
    --h2-size: var(--text-22px);
    --h3-size: var(--text-18px);
    --h4-size: var(--text-15px);
    --h5-size: var(--text-14px);
    --h6-size: var(--text-13px);
    --p-size: var(--text-12px);
    --small-size: var(--text-10px);
  }
  .headline {
    --font-size: var(--text-48px);
    --line-height-ratio: 1.15;
    --margin-top: 0px;
    --margin-bottom: 44px;
    max-width: 720px;
  }
  .section-title {
    --font-size: var(--text-28px);
    --line-height-ratio: 1.04;
    --margin-top: 0px;
    --margin-bottom: 52px;
  }
  .card-title {
    --font-size: var(--h2-size);
    --margin-top: 0px;
    --margin-bottom: 28px;
    color: var(--text-pri);
  }
  .kicker {
    --font-size: var(--text-11px);
    --margin-top: 0px;
    --margin-bottom: 24px;
    font-weight: 500;
    letter-spacing: 0.05em;
    color: var(--text-ter);
  }
  .subtitle {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.6;
    --margin-top: 0px;
    --margin-bottom: 48px;
    max-width: 580px;
    letter-spacing: -0.01em;
    color: var(--text-sec);
  }
  .card-description {
    --font-size: var(--text-13px);
    --line-height-ratio: 1.55;
    --margin-top: 0px;
    --margin-bottom: 28px;
    color: var(--text-sec);
  }
  .meta {
    --font-size: var(--text-11px);
    --margin-top: 4px;
    --margin-bottom: 0px;
    color: var(--text-ter);
  }
  .metric-value {
    --font-size: var(--text-28px);
    --margin-top: 0px;
    --margin-bottom: 0px;
    color: var(--text-pri);
  }
  .quote {
    --font-size: var(--text-16px);
    --line-height-ratio: 1.5;
    --margin-top: 0px;
    --margin-bottom: 20px;
    color: var(--text-pri);
    position: relative;
  }
  .quote::before {
    content: "\\201C";
    position: absolute;
    top: -10px;
    left: -4px;
    font-size: 3.5em;
    line-height: 1;
    color: var(--text-ter);
    font-style: normal;
    pointer-events: none;
    opacity: 0.3;
  }
  .company {
    --font-size: var(--text-12px);
    --margin-top: 0px;
    --margin-bottom: 8px;
    font-weight: 600;
    color: var(--text-pri);
    letter-spacing: -0.01em;
  }
  @media (max-width: 1024px) {
    .headline { --font-size: var(--text-36px); }
  }
  @media (max-width: 768px) {
    .headline { --font-size: var(--text-28px); }
    .subtitle { --font-size: var(--text-12px); }
  }
`;
