import { css } from "../../../component-styles";

export const loaf = css`
  :host {
    --bg: #f7f3eb;
    --bg-elevated: #fffdf8;
    --bg-surface-light: #fffaf1;
    --bg-hover: rgba(36, 45, 38, 0.045);
    --hover-color: rgba(36, 45, 38, 0.045);
    --divider: rgba(36, 45, 38, 0.11);
    --text-pri: #1c211c;
    --text-sec: #62685e;
    --text-ter: #97998e;
    --blue: #2d5f8d;
    --blue-dimmed: #e7eef6;
    --green: #45775c;
    --green-dimmed: #e4ece5;
    --yellow: #c9a34d;
    --yellow-dimmed: #f4ead0;
    --red: #a64f45;
    --red-dimmed: #f1ded9;
    --orange: #b16f38;
    --orange-dimmed: #f0e1d0;
    --purple: #6d5f8f;
    --purple-dimmed: #e7e2f1;
    --gray: #7a7a70;
    --gray-dimmed: #ebe8df;
    --teal: #3f7f7b;
    --teal-dimmed: #dfeceb;

    /* std-code (CodeMirror/Lezer) reads these; loaf defines neither
       --bg-surface nor the syntax tokens. colors.css derives --fg-syntax-* from
       --fg-<color>, which mixes the base hue toward --text-pri — and loaf's base
       palette is intentionally muted, so that route stays too faint. Instead use
       the well-known Atom One Light theme (vivid on a light surface). Custom
       properties inherit into std-code's nested shadow. */
    --bg-surface: var(--bg-elevated);
    --fg-syntax-keyword: #a626a4;
    --fg-syntax-function: #4078f2;
    --fg-syntax-string: #50a14f;
    --fg-syntax-number: #986801;
    --fg-syntax-comment: #a0a1a7;
    --fg-syntax-punctuation: #696c77;
    --fg-syntax-operator: #0184bc;
    --fg-syntax-variable: #383a42;
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  p,
  a {
    color: var(--text-pri);
  }

  blockquote,
  .blog-post-date,
  .simple-date,
  .meta-text {
    color: var(--text-ter);
  }

  .blog-post-category,
  .tag,
  .simple-snippet,
  .hero-subtitle,
  .search-input {
    color: var(--text-sec);
  }
`;
