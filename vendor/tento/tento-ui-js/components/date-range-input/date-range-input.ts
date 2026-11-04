import "../input/date-field";

import { NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { DateField } from "../input/date-field";
import { InputStyles } from "../input/input-styles";

// Two date fields that agree with each other. `std-datetimeregion-input` is a
// datetime with a timezone, not a range, and the range modal is a domain
// component. This hydrates two `std-date-field`s under `role=group` with a
// label, validates end ≥ start, and reports the range — or the reason it is
// invalid — through callbacks. `NaiveDate` is chrono, not a domain type; the
// precedent is `std-date-picker`.
@component({ name: "std-date-range-input" })
export class DateRangeInput extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $start: DateField = this.hydrate("start");
  private $end: DateField = this.hydrate("end");
  private $error: HTMLElement = this.$("error");
  private props: Option<DateRangeInput.Props>;
  private start: Option<NaiveDate>;
  private end: Option<NaiveDate>;

  bind(props: DateRangeInput.Props): this {
    this.props = props;
    this.start = props.start;
    this.end = props.end;
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", props.label);
    this.$label.textContent = props.label;
    this.$start.bind({
      value: props.start,
      placeholder: props.placeholders?.start ?? "Start",
      min: props.minDate,
      max: props.maxDate,
      onChange: (d) => { this.start = d; this.report(); },
    });
    this.$end.bind({
      value: props.end,
      placeholder: props.placeholders?.end ?? "End",
      min: props.minDate,
      max: props.maxDate,
      onChange: (d) => { this.end = d; this.report(); },
    });
    this.showError(null);
    return this;
  }

  private report(): void {
    const props = this.props;
    if (props == null) return;
    const s = this.start;
    const e = this.end;
    if (s != null && e != null && e.isBefore(s)) {
      const why = "The end is before the start.";
      this.showError(why);
      props.onInvalid?.(why);
      return;
    }
    this.showError(null);
    props.onChange(s != null && e != null ? { start: s, end: e } : null);
  }

  private showError(why: Option<string>): void {
    this.$error.textContent = why ?? "";
    this.$error.toggleAttribute("hidden", why == null);
    this.toggleAttribute("invalid", why != null);
    if (why == null) this.removeAttribute("aria-invalid");
    else this.setAttribute("aria-invalid", "true");
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.start = null;
    this.end = null;
    this.$label.textContent = "";
    this.$error.textContent = "";
    for (const a of ["role", "aria-label", "aria-invalid", "invalid"]) this.removeAttribute(a);
  }

  static makeWith(props: DateRangeInput.Props): DateRangeInput {
    return DateRangeInput.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    InputStyles.variables,
    InputStyles.labelStyle,
    css`
      :host {
        --date-range-gap: 8px;
        display: block;
        width: 100%;
      }

      #row {
        display: flex;
        align-items: center;
        gap: var(--date-range-gap);
      }

      #row > std-date-field {
        flex: 1;
        min-width: 0;
      }

      #dash {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #error {
        display: block;
        margin-top: 4px;
        margin-left: 10px;
        color: var(--red);
      }

      #error[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`
    <p id="label" class="label small"></p>
    <div id="row">
      <std-date-field id="start"></std-date-field>
      <p id="dash" aria-hidden="true">–</p>
      <std-date-field id="end"></std-date-field>
    </div>
    <p id="error" class="small" hidden></p>
  `;
}

export namespace DateRangeInput {
  export type Range = { start: NaiveDate; end: NaiveDate };
  export type Props = {
    start: Option<NaiveDate>;
    end: Option<NaiveDate>;
    /** Fires with the range when both ends are set and ordered, else `null`. */
    onChange: (range: Option<Range>) => void;
    onInvalid: Option<(why: string) => void>;
    placeholders: Option<{ start: string; end: string }>;
    minDate: Option<NaiveDate>;
    maxDate: Option<NaiveDate>;
    /** The group's accessible name. */
    label: string;
  };
}
