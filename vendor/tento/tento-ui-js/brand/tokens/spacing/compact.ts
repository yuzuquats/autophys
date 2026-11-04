import { css } from "../../../component-styles";

export const compact = css`
  :host {
    --max-width: 960px;
    --brand-inline-padding: 32px;
    --headline-size: var(--text-36px);
    --h1-size: var(--text-22px);
    --h2-size: var(--text-18px);
    --h3-size: var(--text-16px);
    --h4-size: var(--text-14px);
    --h5-size: var(--text-13px);
    --h6-size: var(--text-12px);
    --p-size: var(--text-11px);
    --small-size: var(--text-10px);
  }
  .headline {
    --font-size: var(--text-36px);
    --line-height-ratio: 1.12;
    --margin-top: 0px;
    --margin-bottom: 32px;
    max-width: 640px;
  }
  .section-title {
    --font-size: var(--text-22px);
    --line-height-ratio: 1.04;
    --margin-top: 0px;
    --margin-bottom: 36px;
  }
  .card-title {
    --font-size: var(--h2-size);
    --margin-top: 0px;
    --margin-bottom: 20px;
    color: var(--text-pri);
  }
  .kicker {
    --font-size: var(--text-10px);
    --margin-top: 0px;
    --margin-bottom: 16px;
    font-weight: 500;
    letter-spacing: 0.05em;
    color: var(--text-ter);
  }
  .subtitle {
    --font-size: var(--text-12px);
    --line-height-ratio: 1.55;
    --margin-top: 0px;
    --margin-bottom: 32px;
    max-width: 520px;
    letter-spacing: -0.01em;
    color: var(--text-sec);
  }
  .card-description {
    --font-size: var(--text-11px);
    --line-height-ratio: 1.5;
    --margin-top: 0px;
    --margin-bottom: 20px;
    color: var(--text-sec);
  }
  .meta {
    --font-size: var(--text-10px);
    --margin-top: 4px;
    --margin-bottom: 0px;
    color: var(--text-ter);
  }
  .metric-value {
    --font-size: var(--text-22px);
    --margin-top: 0px;
    --margin-bottom: 0px;
    color: var(--text-pri);
  }
  .quote {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.45;
    --margin-top: 0px;
    --margin-bottom: 16px;
    color: var(--text-pri);
  }
  .company {
    --font-size: var(--text-11px);
    --margin-top: 0px;
    --margin-bottom: 6px;
    font-weight: 600;
    color: var(--text-pri);
  }
  @media (max-width: 768px) {
    .headline { --font-size: var(--text-28px); }
  }
`;
