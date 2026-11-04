import "./color-field"; // Import to register the custom element
import "./input-layout"; // Import to register InputLayout

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { ColorField } from "./color-field";
import { InputLayout } from "./input-layout";

/**
 * ColorInput - A complete form field with label, caption, and required indicator.
 *
 * This component wraps ColorField in InputLayout to provide a full form input experience.
 * Use ColorField directly if you only need the bare color picker without label/layout.
 *
 * Naming convention:
 * - *Field = styled control without InputLayout (ColorField)
 * - *Input = complete form field with InputLayout (ColorInput)
 */
@component({
  name: "std-color-input",
})
export class ColorInput extends LonaWebComponent {
  private $layout: InputLayout = this.hydrate("layout");
  private $field: ColorField = this.hydrate("field");

  onChange?: (color: string) => void;

  get value(): string {
    return this.$field.value;
  }

  static makeWith(props: ColorInput.Props): ColorInput {
    const $c = ColorInput.make();
    $c.bind(props);
    return $c;
  }

  bind(props: ColorInput.Props): this {
    // Bind the layout (label, caption, required)
    this.$layout.bind({
      label: props.label,
      caption: props.helperText,
      required: props.required,
    });

    // Bind the field
    this.$field.bind({
      value: props.value,
      onChange: (color) => {
        this.onChange?.(color);
        props.onChange?.(color);
      },
    });

    this.onChange = props.onChange;

    return this;
  }

  /**
   * Set the invalid state for this input.
   */
  setInvalid(hasError: boolean, errorText?: Option<string>): void {
    this.$layout.setInvalid(hasError, errorText);
    this.$field.setInvalid(hasError);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      std-color-field {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-input-layout id="layout">
      <std-color-field id="field"></std-color-field>
    </std-input-layout>
  `;
}

export namespace ColorInput {
  export interface Props {
    // InputLayout props
    label?: Option<string>;
    helperText?: Option<string>;
    required?: Option<boolean>;
    // ColorField props
    value?: Option<string>;
    onChange?: (color: string) => void;
  }
}
