import { css } from "../component-styles";

export namespace Placeholder {
  export const style = /* css */ `
    [placeholder] {
      --placeholder-size: var(--font-size);
      position: relative;
    }
    [placeholder][empty]::before,
    [placeholder]:empty::before {
      position: absolute;
      top: var(--placeholder-top, 0px);
      left: var(--placeholder-left, 0px);
      right: var(--placeholder-right, 0px);
      content: attr(placeholder);
      color: var(--placeholder-text-color, var(--text-ter));
      pointer-events: none;
      user-select: none;
      transform: translateY(calc(-1 * var(--rmargin-top)));
      display: block;
    }
    [placeholder][hide-placeholder-on-focus][empty]:focus::before,
    [placeholder][hide-placeholder-on-focus]:empty:focus::before {
      content: "";
    }
  `;
  export const $placeholderOnHover = css`
    [placeholder]:hover[empty]::before,
    [placeholder]:hover:empty::before {
      content: attr(placeholder);
      color: var(--placeholder-text-color, var(--text-ter));
      pointer-events: none;
      user-select: none;
    }
  `;
  export const $placeholderOnEmptyFocus = css`
    [placeholder][empty]:focus::before,
    [placeholder]:empty:focus::before {
      content: "";
    }
  `;

  export const $style = css(style);
}
