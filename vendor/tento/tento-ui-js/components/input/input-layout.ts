import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Typography } from "../../ui/typography";

@component({
  name: "std-input-layout",
})
export class InputLayout extends LonaWebComponent {
  private $label = this.hydrate<HTMLLabelElement>("label");
  private $labelText = this.hydrate<HTMLSpanElement>("label-text");
  private $required = this.hydrate<HTMLSpanElement>("required");
  private $description = this.hydrate<HTMLParagraphElement>("description");
  private $caption = this.hydrate<HTMLParagraphElement>("caption");
  private $error = this.hydrate<HTMLParagraphElement>("error");

  bind(props: InputLayout.Props): this {
    const inputId =
      props.for ?? `input-${Math.random().toString(36).slice(2, 9)}`;
    const captionId = `${inputId}-caption`;

    // Label
    const hasLabel = props.label != null;
    this.$label.style.display = hasLabel ? "block" : "none";
    if (hasLabel) {
      this.$labelText.textContent = props.label!;
      this.$label.setAttribute("for", inputId);
    }

    // Required indicator
    this.$required.style.display = props.required ? "inline" : "none";

    // Description
    const hasDescription = props.description != null;
    this.$description.style.display = hasDescription ? "block" : "none";
    if (hasDescription) {
      this.$description.textContent = props.description!;
    }

    // Caption
    const hasCaption = props.caption != null;
    this.$caption.style.display = hasCaption ? "block" : "none";
    if (hasCaption) {
      this.$caption.textContent = props.caption!;
      this.$caption.id = captionId;
    }

    // Invalid state
    if (props.invalid) {
      this.setAttribute("invalid", "");
    } else {
      this.removeAttribute("invalid");
    }

    return this;
  }

  setInvalid(hasError: boolean, errorText?: Option<string>): void {
    if (hasError) {
      this.setAttribute("invalid", "");
      if (errorText) {
        this.$error.textContent = errorText;
        this.$error.style.display = "block";
      }
    } else {
      this.removeAttribute("invalid");
      this.$error.textContent = "";
      this.$error.style.display = "none";
    }
  }

  static $styles: Style.Compat[] = [
    Typography.$style,
    css`
      /* The field's frame, and the one number derived from it. The twin of the
         block in text-input.ts, and it has to stay the twin: a form renders its
         text rows as std-text-input and every other row as std-input-layout, so
         a form with a text field and a select is reading BOTH of these files at
         once and any disagreement between them shows up as two left edges in
         one column. */
      :host {
        display: block;
        position: relative;
        margin-bottom: var(--form-input-margin-bottom, 0px);
        --input-border-width: 2px;
        --input-pad-x: 10px;
        --input-text-inset: calc(var(--input-border-width) + var(--input-pad-x));
      }

      .label {
        display: block;
        margin-left: var(--input-text-inset);
        margin-bottom: 4px;
        color: var(--text-sec);
      }

      .required {
        color: var(--red);
      }

      .description {
        display: block;
        margin-left: var(--input-text-inset);
        margin-bottom: 8px;
        color: var(--text-ter);
      }

      /* The caption used to claim its own 10px, on the grounds that it was
         aligned to the field's text rather than to its edge. Measured, the
         field's text is at 12px — 10px is the padding with the border left
         out, so the line that said it was optically aligned was the only one
         that was not. It reads from the same inset as everything else now. */
      .caption {
        display: block;
        margin-top: 4px;
        margin-left: var(--input-text-inset);
        margin-bottom: 2px;
        color: var(--text-ter);
      }

      :host([invalid]) ::slotted(input),
      :host([invalid]) ::slotted(select),
      :host([invalid]) ::slotted(textarea) {
        border-color: var(--red) !important;
      }

      /* The error takes the caption's line, so it takes the caption's edge —
         which is now the field's own. See text-input.ts, which carries the twin
         rule: a form's text rows are std-text-input and everything else is
         std-input-layout, so moving one alone fixes half a form. */
      .error-text {
        display: none;
        position: absolute;
        left: var(--input-text-inset);
        top: 100%;
        color: var(--red);
        pointer-events: none;
        z-index: 1;
      }

      ::slotted(*) {
        width: 100%;
        box-sizing: border-box;
      }

      ::slotted(input),
      ::slotted(select) {
        background: var(--bg-surface-light);
        height: 38px;
        padding: 0 var(--input-pad-x);
        border: var(--input-border-width) solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
        --font-size: var(--p-size);
        transition: border-color 0.3s ease;
      }

      ::slotted(textarea) {
        background: var(--bg-surface-light);
        padding: var(--input-pad-x);
        border: var(--input-border-width) solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
        --font-size: var(--p-size);
        transition: border-color 0.3s ease;
      }

      ::slotted(input:focus),
      ::slotted(textarea:focus),
      ::slotted(select:focus) {
        outline: none;
        border-color: var(--blue);
      }

      ::slotted(textarea) {
        min-height: 80px;
        resize: vertical;
      }

      ::slotted(select) {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
        background-repeat: no-repeat;
        background-position: right 8px center;
        background-size: 20px;
        padding-right: 36px;
      }

      ::slotted(std-prosemirror) {
        border-radius: 8px;
        background: var(--bg-surface-light);
        --editor-padding: 14px 12px;
      }

      ::slotted(std-date-field),
      ::slotted(std-time-field),
      ::slotted(std-datetime-field),
      ::slotted(std-color-field) {
        --container-bg: var(--bg-surface-light);
        --form-input-margin-bottom: 0;
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label">
      <span id="label-text"></span>
      <span id="required" class="required"> *</span>
    </label>
    <p id="description" class="small description"></p>
    <slot></slot>
    <p id="caption" class="small caption"></p>
    <p id="error" class="small error-text"></p>
  `;
}

export namespace InputLayout {
  export type Props = {
    label?: Option<string>;
    description?: Option<string>;
    caption?: Option<string>;
    required?: Option<boolean>;
    invalid?: Option<boolean>;
    for?: Option<string>;
  };
}
