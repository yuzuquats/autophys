import { css } from "../../component-styles";

export namespace Link {
  export const style = /* css */ `
    a {
      text-decoration: none;
      color: var(--text-pri);
    }
    a:hover {
      text-decoration: underline;
    }
    a:visited {
      color: var(--text-pri);
    }
  `;

  export const $style = css(style);

  export const make = () => document.createElement("link");
}
