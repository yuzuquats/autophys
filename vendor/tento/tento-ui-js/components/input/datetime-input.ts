import "./datetime-field"; // Import to register the custom element
import "./input-layout"; // Import to register InputLayout

import { NaiveDateTime } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DateTimeField } from "./datetime-field";
import { InputLayout } from "./input-layout";

/**
 * DateTimeInput - A complete form field with label, caption, and required indicator.
 *
 * This component wraps DateTimeField in InputLayout to provide a full form input experience.
 * Use DateTimeField directly if you only need the bare date/time picker without label/layout.
 *
 * Naming convention:
 * - *Field = styled control without InputLayout (DateField, TimeField, DateTimeField)
 * - *Input = complete form field with InputLayout (DateInput, TimeInput, DateTimeInput)
 */
@component({
  name: "std-datetime-input",
})
export class DateTimeInput extends LonaWebComponent {
  private $layout: InputLayout = this.hydrate("layout");
  private $field: DateTimeField = this.hydrate("field");

  onChange?: (datetime: NaiveDateTime) => void;
  onInvalid?: (message: string) => void;

  get value(): Option<NaiveDateTime> {
    return this.$field.value;
  }

  static makeWith(props: DateTimeInput.Props): DateTimeInput {
    const $dt = DateTimeInput.make();
    $dt.bind(props);
    return $dt;
  }

  bind(props: DateTimeInput.Props): this {
    // Bind the layout (label, caption, required)
    this.$layout.bind({
      label: props.label,
      caption: props.helperText,
      required: props.required,
    });

    // Bind the field
    this.$field.bind({
      value: props.value,
      datePlaceholder: props.datePlaceholder,
      timePlaceholder: props.timePlaceholder,
      showDateChevron: props.showDateChevron,
      showTimeChevron: props.showTimeChevron,
      spacing: props.spacing,
      modalContext: props.modalContext,
      onChange: (datetime) => {
        this.onChange?.(datetime);
        props.onChange?.(datetime);
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

  setTimeDisabled(disabled: boolean): void {
    this.$field.setTimeDisabled(disabled);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      std-datetime-field {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-input-layout id="layout">
      <std-datetime-field id="field"></std-datetime-field>
    </std-input-layout>
  `;
}

export namespace DateTimeInput {
  export interface Props {
    // InputLayout props
    label?: Option<string>;
    helperText?: Option<string>;
    required?: Option<boolean>;
    // DateTimeField props
    value?: Option<NaiveDateTime>;
    datePlaceholder?: string;
    timePlaceholder?: string;
    showDateChevron?: boolean;
    showTimeChevron?: boolean;
    spacing?: number;
    onChange?: (datetime: NaiveDateTime) => void;
    onInvalid?: (message: string) => void;
    modalContext?: Option<string>;
  }
}
