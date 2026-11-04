import { css } from "../../../component-styles";

/**
 * Claude blog palette: a warm cream page background. Only `--bg` is overridden
 * so the nav, footer, and page surface read as one consistent color; elevated
 * surfaces (`--bg-elevated`) and text colors keep inheriting the global tokens.
 */
export const cream = css`
  :host {
    --bg: #faf9f5;
  }
`;
