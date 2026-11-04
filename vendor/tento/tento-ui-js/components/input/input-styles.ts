import { css } from "../../component-styles";

/**
 * Shared CSS variables and style fragments for input components.
 *
 * Usage:
 * - Import InputStyles and spread into your component's $styles array
 * - Use CSS variables to customize appearance
 *
 * Form margin inheritance:
 * - Components use `margin-bottom: var(--form-input-margin-bottom, 0px)`
 * - When placed inside a std-form, they inherit 16px margin
 * - When used standalone, they have no margin (0px)
 */
export namespace InputStyles {
  /**
   * CSS custom properties for input styling.
   * These are inherited by child components.
   */
  export const variables = css`
    :host {
      /* Padding */
      --input-padding-block: 8px;
      --input-padding-inline: 10px;

      /* Border */
      --input-border-width: 2px;
      --input-border-radius: 8px;

      /* Colors */
      --input-bg: var(--bg-surface-light);
      --input-focus-border-color: var(--blue);
      --input-invalid-border-color: var(--red);

      /* Label positioning */
      --input-label-margin: 0 0 4px 12px;

      /* Form margin - inherited from std-form when nested */
      --form-input-margin-bottom: 0px;
    }
  `;

  /**
   * Base styles for input/select/textarea elements.
   */
  export const fieldStyle = css`
    input,
    select,
    textarea {
      background: var(--input-bg, var(--bg-surface-light));
      padding: var(--input-padding-block, 8px) var(--input-padding-inline, 10px);
      border: var(--input-border-width, 2px) solid transparent;
      border-radius: var(--input-border-radius, 8px);
      color: var(--text-pri);
      font-family: inherit;
      --font-size: var(--p-size);
      width: 100%;
      box-sizing: border-box;
      transition: border-color 0.3s ease;
    }

    input:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: var(--input-focus-border-color, var(--blue));
    }

    input::placeholder,
    textarea::placeholder {
      color: var(--text-ter);
    }

    input:disabled,
    select:disabled,
    textarea:disabled {
      opacity: 1;
      cursor: not-allowed;
    }
  `;

  /**
   * Invalid/error state styling.
   * Components should use the [invalid] attribute (matches HTML5 constraint validation).
   */
  export const invalidState = css`
    :host([invalid]) input,
    :host([invalid]) select,
    :host([invalid]) textarea {
      border-color: var(--input-invalid-border-color, var(--red));
    }

    :host([invalid]) .helper-text {
      color: var(--red);
    }
  `;

  /**
   * Standard label styling for *-input components.
   */
  export const labelStyle = css`
    .label {
      display: block;
      margin: var(--input-label-margin, 0 0 4px 12px);
      color: var(--text-sec);
    }

    .required {
      color: var(--red);
    }
  `;

  /**
   * Helper text styling.
   */
  export const helperStyle = css`
    .helper-text {
      display: block;
      margin-top: 4px;
      margin-left: 10px;
      margin-bottom: 2px;
      color: var(--text-ter);
    }
  `;

  /**
   * Form margin inheritance.
   * Include this in components that should have margin when inside a form.
   */
  export const formMargin = css`
    :host {
      margin-bottom: var(--form-input-margin-bottom, 0px);
    }
  `;
}
