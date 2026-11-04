import { css } from "../../component-styles";

/** Markdown-table styling, as `dev.lona.so/docs/*` renders it: full-width,
 * collapsed borders, a single hairline under each row, and the label/value
 * colour split between header and body.
 *
 * It lives in its own module because two surfaces need it and their module
 * graphs must not meet. `std-documentation` pulls in the code viewer, the
 * lisp-example view and the rich-text editor; a transcript row rendering
 * one agent message must not carry any of that, and a storybook card built
 * from a turn primitive cannot — a separate bun bundle dies on the first
 * `.svg` import in that graph. Importing the sheet is free; importing the
 * component that used to own it is not.
 *
 * Rules are unscoped so a caller can adopt the sheet wherever its tables
 * actually live — for the turn primitives, inside the editor's shadow root
 * via `addStyle`. */
export const MARKDOWN_TABLE_STYLE = css`
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
    margin-bottom: 32px;
  }
  th, td {
    font-size: 13px;
    padding: 10px 8px;
    margin-block: 4px;
    text-align: left;
    border-bottom: 1px solid var(--divider);
  }
  th {
    color: var(--text-pri);
    font-weight: 600;
    padding-inline: 16px;
  }
  td {
    color: var(--text-sec);
    padding-inline: 16px;
  }

  @media (max-width: 768px) {
    table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    th, td {
      padding-inline: 12px;
    }
  }
`;
