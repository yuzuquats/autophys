import { css } from "../../../component-styles";

export const listFonts: string[] = [];

export const list = css`
  :host {
    font-family: sans-serif;
  }
  p {
    font-family: "Times New Roman", Georgia, "Nimbus Roman No9 L", serif;
  }
  ul,
  ol {
    font-family: "Times New Roman", Georgia, "Nimbus Roman No9 L", serif;
  }
  blockquote {
    font-style: italic;
    font-family: "Times New Roman", Georgia, "Nimbus Roman No9 L", serif;
  }
  .blog-post-title,
  .blog-post-date,
  .blog-post-category,
  .tag,
  .brand-footer-line,
  .back-link {
    font-family: sans-serif;
  }
  .blog-post-category {
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
`;
