import { css } from "../../../component-styles";

export const serifFonts = ["dm-serif-display-font.css", "inter-font.css"];

export const serif = css`
  .headline {
    font-family: "DM Serif Display", serif;
    font-weight: 400;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .section-title {
    font-family: "DM Serif Display", serif;
    letter-spacing: -0.01em;
  }
  .card-title {
    font-family: "DM Serif Display", serif;
    letter-spacing: -0.01em;
  }
  .metric-value {
    font-family: "DM Serif Display", serif;
    letter-spacing: -0.02em;
  }
  .quote {
    font-family: "DM Serif Display", serif;
    font-style: italic;
  }
  .kicker, .subtitle, .card-description, .meta, .company {
    font-family: "Inter", sans-serif;
  }
  .brand-nav-link, .brand-nav-title, .brand-footer-line {
    font-family: "Inter", sans-serif;
  }
`;
