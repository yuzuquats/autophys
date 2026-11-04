import "./date-field"; // Import to register the custom element
import "./time-field"; // Import to register the custom element

import { NaiveDate, NaiveDateTime, TimeOfDay } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Row } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DateField } from "./date-field";
import { TimeField } from "./time-field";

@component({
  name: "std-datetime-field",
})
export class DateTimeField extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $dateField: DateField = this.hydrate("date-field");
  private $timeField: TimeField = this.hydrate("time-field");

  private currentDate: Option<NaiveDate> = null;
  private currentTime: Option<TimeOfDay> = null;

  onChange?: ((datetime: NaiveDateTime) => void) | undefined;
  onInvalid?: ((message: string) => void) | undefined;

  get value(): Option<NaiveDateTime> {
    if (!this.currentDate || !this.currentTime) {
      return null;
    }
    return new NaiveDateTime(this.currentDate, this.currentTime);
  }

  static makeWith(props: DateTimeField.Props): DateTimeField {
    const $dt = DateTimeField.make();
    $dt.bind(props);
    return $dt;
  }

  constructor() {
    super();

    // Set up date field handler
    this.$dateField.onChange = (date) => {
      this.currentDate = date;
      this.emitDateTimeIfComplete();
    };

    this.$dateField.onInvalid = (message) => {
      this.onInvalid?.(`Date: ${message}`);
    };

    // Set up time field handler
    this.$timeField.onChange = (time) => {
      this.currentTime = time;
      this.emitDateTimeIfComplete();
    };

    this.$timeField.onInvalid = (message) => {
      this.onInvalid?.(`Time: ${message}`);
    };
  }

  bind(props: DateTimeField.Props): this {
    // Extract date and time from datetime if provided
    let dateValue: Option<NaiveDate> = null;
    let timeValue: Option<TimeOfDay> = null;

    if (props.value) {
      dateValue = props.value.date;
      timeValue = props.value.time;
      this.currentDate = dateValue;
      this.currentTime = timeValue;
    }

    // Bind to child fields
    this.$dateField.bind({
      value: dateValue,
      placeholder: props.datePlaceholder ?? "YYYY-MM-DD",
      showChevron: props.showDateChevron ?? false,
      onChange: this.$dateField.onChange,
      onInvalid: this.$dateField.onInvalid,
      modalContext: props.modalContext,
    });

    this.$timeField.bind({
      value: timeValue,
      placeholder: props.timePlaceholder ?? "HH:MM",
      showChevron: props.showTimeChevron ?? false,
      use24Hour: props.use24Hour,
      onChange: this.$timeField.onChange,
      onInvalid: this.$timeField.onInvalid,
      modalContext: props.modalContext,
    });

    this.onChange = props.onChange;
    this.onInvalid = props.onInvalid;

    return this;
  }

  private emitDateTimeIfComplete(): void {
    if (!this.currentDate || !this.currentTime) return;
    const datetime = new NaiveDateTime(this.currentDate, this.currentTime);
    this.onChange?.(datetime);
  }

  setTimeDisabled(disabled: boolean): void {
    this.$timeField.toggleAttribute("disabled", disabled);
  }

  static $styles = [
    css`
      :host {
        display: block;
        margin-bottom: var(--form-input-margin-bottom, 0px);
      }

      #container {
        align-items: center;
        gap: 8px;
      }

      /* Ensure fields have equal width when side by side */
      std-date-field {
        min-width: 140px;
        flex-grow: 1;
      }

      std-time-field {
        min-width: 96px;
        flex-grow: 1;
      }

      std-time-field[disabled] {
        text-decoration: line-through;
        opacity: 0.5;
        pointer-events: none;
      }
    `,
  ];

  static $html = html`
    <std-row id="container">
      <std-date-field id="date-field"></std-date-field>
      <std-time-field id="time-field"></std-time-field>
    </std-row>
  `;
}

export namespace DateTimeField {
  export interface Props {
    value?: Option<NaiveDateTime>;
    datePlaceholder?: string;
    timePlaceholder?: string;
    showDateChevron?: boolean;
    showTimeChevron?: boolean;
    use24Hour?: boolean;
    spacing?: number;
    onChange?: ((datetime: NaiveDateTime) => void) | undefined;
    onInvalid?: ((message: string) => void) | undefined;
    modalContext?: Option<string>;
  }
}
