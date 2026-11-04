import "./time-field"; // Import to register the custom element
import "./input-layout"; // Import to register InputLayout

import { TimeOfDay } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { TimeField } from "./time-field";
import { InputLayout } from "./input-layout";

/**
 * TimeInput - A complete form field with label, caption, and required indicator.
 *
 * This component wraps TimeField in InputLayout to provide a full form input experience.
 * Use TimeField directly if you only need the bare time picker without label/layout.
 *
 * Naming convention:
 * - *Field = styled control without InputLayout (DateField, TimeField, DateTimeField)
 * - *Input = complete form field with InputLayout (DateInput, TimeInput, DateTimeInput)
 */
@component({
  name: "std-time-input",
})
export class TimeInput extends LonaWebComponent {
  private $layout: InputLayout = this.hydrate("layout");
  private $field: TimeField = this.hydrate("field");

  onChange?: (time: TimeOfDay) => void;
  onInvalid?: (message: string) => void;

  get value(): Option<TimeOfDay> {
    return this.$field.value;
  }

  static makeWith(props: TimeInput.Props): TimeInput {
    const $t = TimeInput.make();
    $t.bind(props);
    return $t;
  }

  bind(props: TimeInput.Props): this {
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
      showChevron: props.showChevron,
      modalContext: props.modalContext,
      onChange: (time) => {
        this.onChange?.(time);
        props.onChange?.(time);
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

      std-time-field {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-input-layout id="layout">
      <std-time-field id="field"></std-time-field>
    </std-input-layout>
  `;
}

export namespace TimeInput {
  export interface Props {
    // InputLayout props
    label?: Option<string>;
    helperText?: Option<string>;
    required?: Option<boolean>;
    // TimeField props
    value?: Option<TimeOfDay>;
    placeholder?: string;
    showChevron?: boolean;
    onChange?: (time: TimeOfDay) => void;
    onInvalid?: (message: string) => void;
    modalContext?: Option<string>;
  }
}
