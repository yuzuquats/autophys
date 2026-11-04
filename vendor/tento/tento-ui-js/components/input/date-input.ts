import "./date-field"; // Import to register the custom element
import "./input-layout"; // Import to register InputLayout

import { NaiveDate } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DateField } from "./date-field";
import { InputLayout } from "./input-layout";

/**
 * DateInput - A complete form field with label, caption, and required indicator.
 *
 * This component wraps DateField in InputLayout to provide a full form input experience.
 * Use DateField directly if you only need the bare date picker without label/layout.
 *
 * Naming convention:
 * - *Field = styled control without InputLayout (DateField, TimeField, DateTimeField)
 * - *Input = complete form field with InputLayout (DateInput, TimeInput, DateTimeInput)
 */
@component({
  name: "std-date-input",
})
export class DateInput extends LonaWebComponent {
  private $layout: InputLayout = this.hydrate("layout");
  private $field: DateField = this.hydrate("field");

  onChange?: (date: Option<NaiveDate>) => void;
  onInvalid?: (message: string) => void;

  get value(): Option<NaiveDate> {
    return this.$field.value;
  }

  static makeWith(props: DateInput.Props): DateInput {
    const $d = DateInput.make();
    $d.bind(props);
    return $d;
  }

  bind(props: DateInput.Props): this {
    // Bind the layout (label, caption, required)
    this.$layout.bind({
      label: props.label,
      caption: props.helperText,
      required: props.required,
    });

    // Bind the field
    this.$field.bind({
      value: props.value,
      placeholder: props.placeholder,
      min: props.min,
      max: props.max,
      showChevron: props.showChevron,
      onChange: (date) => {
        this.onChange?.(date);
        props.onChange?.(date);
      },
      onInvalid: (message) => {
        this.$layout.setInvalid(true, message);
        this.onInvalid?.(message);
        props.onInvalid?.(message);
      },
    });

    this.onChange = props.onChange;
    this.onInvalid = props.onInvalid;

    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      std-date-field {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-input-layout id="layout">
      <std-date-field id="field"></std-date-field>
    </std-input-layout>
  `;
}

export namespace DateInput {
  export interface Props {
    // InputLayout props
    label?: Option<string>;
    helperText?: Option<string>;
    required?: Option<boolean>;
    // DateField props
    value?: Option<NaiveDate>;
    placeholder?: string;
    min?: Option<NaiveDate>;
    max?: Option<NaiveDate>;
    showChevron?: boolean;
    onChange?: (date: Option<NaiveDate>) => void;
    onInvalid?: (message: string) => void;
  }
}
