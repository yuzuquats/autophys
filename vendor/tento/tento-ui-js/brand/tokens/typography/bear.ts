import { css } from "../../../component-styles";

export const bearFonts: string[] = [];

export const bear = css`
  :host {
    --bear-font-main: Verdana, Geneva, sans-serif;
  }
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  p,
  li,
  span,
  time,
  a,
  input,
  button,
  label {
    font-family: var(--bear-font-main);
  }
  blockquote {
    font-style: italic;
  }
  time,
  .bear-date {
    font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
`;
