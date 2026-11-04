import "./date-picker-modal";

import { NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons, TEMP_CALENDAR_ICON } from "../../ui/icons";
import { DatePickerModal } from "./date-picker-modal";

@component({
  name: "std-date-picker-input",
})
export class DatePickerInput extends LonaWebComponent {
  private $label: HTMLElement = this.hydrate("label");

  private selectedDate: Option<NaiveDate> = undefined;
  private onChange?: ((date: Option<NaiveDate>) => void) | undefined;
  private modalTitle: string = "Select Date";
  private placeholder: string = "Select a date";

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => {
        this.openDatePicker();
      },
    });
    this.$("svg-container").appendChild(LonaIcons.$svg(TEMP_CALENDAR_ICON));
  }

  static makeWith(options: {
    date?: Option<NaiveDate>;
    onChange?: (date: Option<NaiveDate>) => void;
    modalTitle?: string;
    placeholder?: string;
  }): DatePickerInput {
    const input = DatePickerInput.make();
    input.bind(options);
    return input;
  }

  bind(options?: {
    date?: Option<NaiveDate>;
    onChange?: (date: Option<NaiveDate>) => void;
    modalTitle?: string;
    placeholder?: string;
  }): this {
    this.selectedDate = options?.date;
    this.onChange = options?.onChange;
    this.modalTitle = options?.modalTitle ?? "Select Date";
    this.placeholder = options?.placeholder ?? "Select a date";

    this.updateLabel();
    return this;
  }

  private openDatePicker() {
    DatePickerModal.show(this.modalTitle, this.selectedDate, (date) => {
      this.selectedDate = date;
      this.updateLabel();
      this.onChange?.(date);
    });
  }

  private updateLabel() {
    if (this.selectedDate) {
      const today = NaiveDate.today();
      const relativeText = this.getRelativeDate(this.selectedDate, today);
      this.$label.textContent = relativeText;
      this.$label.classList.remove("placeholder");
    } else {
      this.$label.textContent = this.placeholder;
      this.$label.classList.add("placeholder");
    }
  }

  private getRelativeDate(date: NaiveDate, today: NaiveDate): string {
    const daysDiff = date.differenceInDays(today);

    if (daysDiff === 0) {
      return "Today";
    } else if (daysDiff === 1) {
      return "Tomorrow";
    } else if (daysDiff === -1) {
      return "Yesterday";
    } else if (daysDiff > 0 && daysDiff <= 7) {
      const weekday = date.dayOfWeek;
      return weekday.shortname;
    } else if (daysDiff > 7 && daysDiff <= 14) {
      const weekday = date.dayOfWeek;
      return `Next ${weekday.shortname}`;
    } else if (daysDiff < 0 && daysDiff >= -7) {
      const weekday = date.dayOfWeek;
      return `Last ${weekday.shortname}`;
    } else {
      // Format as "Mon, Jan 15" or "Mon, Jan 15, 2025" if different year
      const currentYear = today.yr;
      const dateYear = date.yr;
      const weekday = date.dayOfWeek.shortname;
      const monthIndex = date.month0; // 0-indexed month
      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const monthStr = monthNames[monthIndex];

      if (currentYear === dateYear) {
        return `${weekday}, ${monthStr} ${date.dayOfMonth}`;
      } else {
        return `${weekday}, ${monthStr} ${date.dayOfMonth}, ${dateYear}`;
      }
    }
  }

  get date(): Option<NaiveDate> {
    return this.selectedDate;
  }

  set date(value: Option<NaiveDate>) {
    this.selectedDate = value;
    this.updateLabel();
  }

  static $styles = [
    css`
      :host {
        display: inline-block;
        cursor: pointer;
      }

      #root {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-surface-light);
        border: 2px solid transparent;
        border-radius: 8px;
        transition: all 0.3s ease;
        min-width: 120px;
      }

      #root:hover {
        background: var(--bg-hover);
        border-color: var(--divider);
      }

      #root:active {
        border-color: var(--blue);
      }

      #label {
        flex: 1;
        margin: 0;
        font-size: var(--text-14px);
        color: var(--text-pri);
        user-select: none;
      }

      #label.placeholder {
        color: var(--text-ter);
      }

      #svg-container {
        color: var(--text-ter);
        flex-shrink: 0;
        height: 16px;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <p id="label" class="placeholder"></p>
      <div id=svg-container></div>
    </div>
  `;
}

export namespace DatePickerInput {
  export type Props = {
    date?: Option<NaiveDate>;
    onChange?: (date: Option<NaiveDate>) => void;
    modalTitle?: string;
    placeholder?: string;
  };
}
