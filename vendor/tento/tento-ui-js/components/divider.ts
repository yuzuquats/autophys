import { Hr } from "../component-builtin";
import { css } from "../component-styles";
import { DomUtils } from "../dom";

export namespace Divider {
  export const $hr = css`
    std-hr,
    hr {
      flex-shrink: 0;
      background-color: var(--divider);
      height: 1px;
      width: 100%;
      outline: none;
      border: none;
      margin-block: 4px;
    }
  `;
  export const $vr = css`
    std-vr {
      border-right: 1px solid var(--divider);
      margin-inline: 4px;
    }
  `;

  export function make(): HTMLHRElement {
    return Hr.make().assignStyles({
      alignSelf: "stretch",
      marginInline: "6px",
      height: "1px",
      backgroundColor: "var(--divider)",
      outline: "none",
      border: "none",
      marginBlock: "4px",
    });
  }
}
