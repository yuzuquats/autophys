import { css } from "../component-styles";

export namespace Flexbox {
  export const style = /* css */ `
    .row,
    std-row {
      display: flex;
      flex-direction: row;
      align-items: stretch;
    }
    .col,
    std-col {
      display: flex;
      flex-direction: column;
      align-items: stretch;
    }
    std-center {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    std-spacer {
      flex-grow: 1;
    }
    std-flex {
      display: flex;
    }
    std-block {
      display: block
    }
  `;

  export const $style = css(style);
}
