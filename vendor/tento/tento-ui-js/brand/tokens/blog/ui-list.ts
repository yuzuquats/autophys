import { css } from "../../../component-styles";

export const uiList = css`
  a {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  a:hover {
    opacity: 0.8;
  }
  blockquote {
    border-left: 3px solid var(--divider);
  }
`;
