import "./datetime-field";
import "@tento-ui/components/timezone-dropdown";

import {
  DateTimeRegion,
  NaiveDateTime,
  TimezoneRegion,
  Tzname,
} from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { TimezoneDropdown } from "../timezone-dropdown";
import { Toast } from "../toast/toast";
import { DateTimeField } from "./datetime-field";

@component({
  name: "std-datetimeregion-input",
})
export class DateTimeRegionInput extends LonaWebComponent {
  private $datetimeField: DateTimeField = this.hydrate("datetime-field");
  private $timezoneDropdown: TimezoneDropdown =
    this.hydrate("timezone-dropdown");

  private currentNdt: Option<NaiveDateTime> = null;
  private currentTz: Option<Tzname> = null;

  onChange?: ((dtr: Option<DateTimeRegion>) => void) | undefined;
  onInvalid?: ((message: string) => void) | undefined;

  static makeWith(props: DateTimeRegionInput.Props): DateTimeRegionInput {
    const $dtr = DateTimeRegionInput.make();
    $dtr.bind(props);
    return $dtr;
  }

  constructor() {
    super();

    this.$datetimeField.onChange = (datetime) => {
      this.currentNdt = datetime;
      this.emitDateTimeRegionIfComplete();
    };

    this.$datetimeField.onInvalid = (message) => {
      this.onInvalid?.(message);
    };

    // Set up timezone dropdown handler
    this.$timezoneDropdown.bind({
      onChange: (tzEntry) => {
        this.currentTz = tzEntry?.id;
        if (tzEntry) this.emitDateTimeRegionIfComplete();
      },
    });
  }

  bind(props: DateTimeRegionInput.Props): this {
    const wallclock = props.value?.asWallClock();
    this.currentNdt = wallclock?.ndt;
    this.currentTz = props.value?.tz.fullname;

    // Bind to datetime field
    this.$datetimeField.bind({
      value: this.currentNdt,
      datePlaceholder: props.options?.placeholders?.date ?? "YYYY-MM-DD",
      timePlaceholder: props.options?.placeholders?.time ?? "HH:MM",
      showDateChevron: false,
      showTimeChevron: false,
      use24Hour: props.options?.use24Hour ?? false,
      onChange: this.$datetimeField.onChange,
      onInvalid: this.$datetimeField.onInvalid,
      modalContext: props.options?.modalContext,
    });

    // Bind to timezone dropdown
    this.$timezoneDropdown.bind({
      value: this.currentTz,
      placeholder: props.options?.placeholders?.timezone ?? "Timezone",
      commonOnly: false,
      allowNull: false,
      showSelectedCaption: false,
      onChange: (tzEntry) => {
        if (tzEntry) {
          this.currentTz = tzEntry.id;
          this.emitDateTimeRegionIfComplete();
        } else {
          this.currentTz = null;
        }
      },
      modalContext: props.options?.modalContext,
      disabled: props.options?.disableTimezone ?? false,
    });

    this.onChange = props.onChange;
    this.onInvalid = props.onInvalid;

    return this;
  }

  private async emitDateTimeRegionIfComplete() {
    if (!this.currentNdt || !this.currentTz) return;
    const tz = await TimezoneRegion.getOpt(this.currentTz);
    if (!tz) {
      Toast.error(`Unknown Timezone: ${this.currentTz}`);
      return;
    }
    this.onChange?.(new DateTimeRegion(this.currentNdt, tz));
  }

  setTimeDisabled(disabled: boolean): void {
    this.$datetimeField.setTimeDisabled(disabled);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #container {
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      std-datetime-field {
        flex-grow: 1;
        flex-shrink: 1;
        flex-basis: 0;
      }

      std-timezone-dropdown {
        flex-grow: 1;
        flex-shrink: 1;
        flex-basis: 0;

        min-width: 200px;
        --timezone-search-row-height: 26px;
        --dropdown-border-width: 1px;
        --dropdown-outline-color: transparent;
        --dropdown-outline-active-color: #aaa;
      }
    `,
  ];

  static $html = html`
    <std-row id="container">
      <std-datetime-field id="datetime-field"></std-datetime-field>
      <std-timezone-dropdown id="timezone-dropdown"></std-timezone-dropdown>
    </std-row>
  `;
}

export namespace DateTimeRegionInput {
  export interface Props {
    value?: Option<DateTimeRegion>;
    onChange?: (dtr: Option<DateTimeRegion>) => void;
    onInvalid?: (message: string) => void;

    options?: Options;
  }

  export type Options = Optional<{
    placeholders: Optional<{
      date: string;
      time: string;
      timezone: string;
    }>;
    modalContext: string;
    disableTimezone: boolean;
    use24Hour: boolean;
  }>;
}
