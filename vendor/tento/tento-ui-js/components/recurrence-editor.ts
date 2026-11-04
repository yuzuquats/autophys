import "./controls/dropdown";
import "./input/number-input";
import "./input/dropdown-input";
import "./input/date-picker-input";
import "./input/radio-button";
import "./list/list-cell-layout";
import "./radio-button-cell";

import { IsoDate, NaiveDate, RRule, RRuleLike, Weekday } from "@tento-chrono";
import { Frequency } from "@tento-chrono/chrono/recurrence/frequency";
import { LonaWebComponent, html } from "../component";
import { Column, Row } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { Typography } from "../ui/typography";
import { Button } from "./button/button";
import { Dropdown } from "./controls/dropdown";
import { DatePickerInput } from "./input/date-picker-input";
import { NumberInput } from "./input/number-input";
import { ListCellLayout } from "./list/list-cell-layout";
import { RadioButtonCell } from "./radio-button-cell";

@component({
  name: "std-recurrence-editor",
})
export class RecurrenceEditor extends LonaWebComponent {
  private $intervalInput: NumberInput = this.hydrate("interval-input");
  private $frequencyDropdown: Dropdown<Frequency> =
    this.hydrate("frequency-dropdown");
  private $endDatePicker: DatePickerInput = this.hydrate("end-date-picker");
  private $occurrencesInput: NumberInput = this.hydrate("occurrences-input");

  private model: RecurrenceModel = RecurrenceEditor.getDefaultModel();
  private referenceDate: NaiveDate = NaiveDate.today();
  private onChange: Option<(model: RecurrenceModel) => void>;

  bind(options: {
    model?: RecurrenceModel;
    referenceDate: NaiveDate;
    onChange?: (model: RecurrenceModel) => void;
    modalContext?: Option<string>;
  }) {
    // Set reference date first as it's used for defaults
    this.referenceDate = options.referenceDate;

    // Initialize model with complete defaults or merge with provided model
    if (options.model) {
      this.model = RecurrenceEditor.mergeWithDefaults(
        options.model,
        this.referenceDate,
      );
    } else {
      this.model = RecurrenceEditor.getDefaultModel();
    }

    this.onChange = options.onChange;

    this.setupFrequencySection();
    this.updateFrequencyLabels(options.modalContext);
    this.updateRepeatOnSection();
    this.setupEndSection();
    this.updateRepeatOnSection();
  }

  static makeWith(options: {
    model?: RecurrenceModel;
    referenceDate: NaiveDate;
    onChange?: (model: RecurrenceModel) => void;
  }): RecurrenceEditor {
    const editor = RecurrenceEditor.make();
    editor.bind(options);
    return editor;
  }

  private setupFrequencySection() {
    // Setup interval input with centered text
    this.$intervalInput.bind(this.model.interval, {
      placeholder: "1",
    });
    this.$intervalInput.enableEditing();
    this.$intervalInput.style.setProperty("--text-align", "center");
    this.$intervalInput.setCallbacks({
      onChange: (value) => {
        this.model.interval = value ?? 1;
        this.updateFrequencyLabels();
        this.notifyChange();
      },
      onEditingFinished: (value) => {
        this.model.interval = value ?? 1;
        this.updateFrequencyLabels();
        this.notifyChange();
      },
    });
  }

  private updateFrequencyLabels(modalContext?: Option<string>) {
    const labels = RecurrenceEditor.getFrequencyLabels(this.model.interval);
    const frequencyRows = RecurrenceEditor.createFrequencyDropdownRows(
      this.model.interval,
      this.model.frequency,
    );

    let initial = true;
    const onSelectedRow = (row) => {
      if (initial) {
        initial = false;
        return;
      }

      const oldFrequency = this.model.frequency;
      this.model.frequency = row.data;

      // Early return if frequency didn't actually change
      if (oldFrequency === row.data) {
        this.notifyChange();
        return;
      }

      // Set appropriate defaults when frequency changes
      if (row.data === "weekly" && this.model.weekdays.length === 0) {
        this.model.weekdays = [this.referenceDate.dayOfWeek];
      } else if (row.data === "monthly") {
        if (
          this.model.monthDays.length === 0 &&
          this.model.monthWeekday === null
        ) {
          this.model.monthDays = [this.referenceDate.day];
        }
      }

      // When frequency changes, update repeat-on section and re-bind dropdown with new labels
      this.updateRepeatOnSection();
      this.updateFrequencyLabels();
      this.notifyChange();
    };
    this.$frequencyDropdown.bind({
      rows: frequencyRows,
      onSelectedRow,
      modalContext,
    });
    this.$frequencyDropdown.bindSelectedRow({
      content: labels[this.model.frequency],
      data: "weekly",
    });
  }

  private updateRepeatOnSection() {
    // Clear containers
    const $weekdayContainer = this.$("weekday-container");
    const $monthDayContainer = this.$("monthday-container");
    DomUtils.clearChildren($weekdayContainer);
    DomUtils.clearChildren($monthDayContainer);

    // Hide entire section for Daily and Yearly
    const $repeatOnSection = this.$("repeat-on-section");
    if (
      this.model.frequency !== "weekly" &&
      this.model.frequency !== "monthly"
    ) {
      $repeatOnSection.style.display = "none";
      $weekdayContainer.style.display = "none";
      $monthDayContainer.style.display = "none";
      return;
    }

    if (this.model.frequency === "weekly") {
      // Show the repeat-on section
      $repeatOnSection.style.display = "flex";
      // Show weekday selection
      $weekdayContainer.style.display = "flex";
      $monthDayContainer.style.display = "none";

      // If no weekdays selected, default to reference date's weekday
      if (this.model.weekdays.length === 0) {
        this.model.weekdays = [this.referenceDate.dayOfWeek];
      }

      for (const day of Weekday.DOW1) {
        const $button = RecurrenceEditor.createWeekdayButton(
          day,
          this.model.weekdays.includes(day),
          day === this.referenceDate.dayOfWeek,
          (selectedDay, button) => {
            const index = this.model.weekdays.indexOf(selectedDay);
            if (index >= 0) {
              this.model.weekdays.splice(index, 1);
              button.classList.remove("selected");
            } else {
              this.model.weekdays.push(selectedDay);
              button.classList.add("selected");
            }
            this.notifyChange();
          },
        );

        $weekdayContainer.appendChild($button);
      }
    } else if (this.model.frequency === "monthly") {
      // Show the repeat-on section
      $repeatOnSection.style.display = "flex";
      // Show month day options
      $weekdayContainer.style.display = "none";
      $monthDayContainer.style.display = "flex";

      const weekOfMonth = Math.ceil(this.referenceDate.day / 7);

      // Create radio button group for monthly options
      const monthGroup = new RadioButtonCell.Group({
        onSelected: (cell) => {
          const value = cell.getAttribute("value");
          if (value === "day") {
            this.model.monthWeekday = null;
            this.model.monthDays = [this.referenceDate.day];
          } else if (value === "nth") {
            this.model.monthWeekday = this.model.monthWeekday ?? {
              n: weekOfMonth,
              weekday: this.referenceDate.dayOfWeek,
            };
            this.model.monthDays = [];
          }
          this.notifyChange();
          return true;
        },
      });

      // Create "Day of month" option
      const dayText = `Day ${this.referenceDate.day} of month`;
      const dayCell = RadioButtonCell.makeWith({
        title: dayText,
        options: {
          value: "day",
          name: "month-repeat",
        },
      });

      // Create "Nth weekday" option
      const nthText = `${RecurrenceEditor.getNthString(weekOfMonth)} ${this.referenceDate.dayOfWeek.shortname} of month`;
      const nthCell = RadioButtonCell.makeWith({
        title: nthText,
        options: {
          value: "nth",
          name: "month-repeat",
        },
      });

      // Bind cells to group
      monthGroup.bind([dayCell, nthCell]);

      // Add cells to container
      $monthDayContainer.appendChild(dayCell);
      $monthDayContainer.appendChild(nthCell);

      // Select the current option
      if (this.model.monthWeekday === null) {
        monthGroup.select(dayCell);
      } else {
        monthGroup.select(nthCell);
      }
    }

    // Show the section if we have options
    $repeatOnSection.style.display = "flex";
  }

  private setupEndSection() {
    // Clear the container
    const $endRadioContainer = this.$("end-radio-container");
    DomUtils.clearChildren($endRadioContainer);

    // Create radio button group
    const endGroup = new RadioButtonCell.Group({
      onSelected: (cell) => {
        const value = cell.getAttribute("value") as RecurrenceEndType;
        this.model.endType = value;

        // Set default values when selecting end type
        if (value === "on-date" && !this.model.endDate) {
          this.model.endDate = NaiveDate.today().add({ days: 30 });
        } else if (value === "after-occurrences" && !this.model.occurrences) {
          this.model.occurrences = 10;
        }

        // Re-render to show/hide sub-options
        this.setupEndSection();
        this.notifyChange();
        return true;
      },
    });

    const endCells: RadioButtonCell[] = [];

    // Create "Never" option
    const $neverSubtitle = Typography.caption("Event repeats indefinitely");
    $neverSubtitle.style.color = "var(--text-ter)";

    const neverCell = RadioButtonCell.makeWith({
      title: "Never",
      options: {
        $subtitle: $neverSubtitle,
        value: "never",
        name: "end-type",
      },
    });
    endCells.push(neverCell);

    // Create "On date" option with date picker
    let $onDateSubtitle: HTMLElement;
    if (this.model.endType === "on-date") {
      const $dateContainer = Column.make();
      $dateContainer.style.gap = "4px";

      const $caption = Typography.caption("Choose a specific end date");
      $caption.style.color = "var(--text-ter)";
      $dateContainer.appendChild($caption);

      this.$endDatePicker.style.display = "block";
      $dateContainer.appendChild(this.$endDatePicker);
      $onDateSubtitle = $dateContainer;
    } else {
      $onDateSubtitle = Typography.caption("Choose a specific end date");
      $onDateSubtitle.style.color = "var(--text-ter)";
    }

    const onDateCell = RadioButtonCell.makeWith({
      title: "On date",
      options: {
        $subtitle: $onDateSubtitle,
        value: "on-date",
        name: "end-type",
      },
    });
    endCells.push(onDateCell);

    // Create "After" option with occurrences input
    let $afterSubtitle: HTMLElement;
    if (this.model.endType === "after-occurrences") {
      const $afterContainer = Column.make();
      $afterContainer.style.gap = "4px";

      const $caption = Typography.caption("Stop after a number of occurrences");
      $caption.style.color = "var(--text-ter)";
      $afterContainer.appendChild($caption);

      const $occRow = Row.make();
      $occRow.assignStyles({
        gap: "8px",
        alignItems: "center",
        marginTop: "4px",
      });

      this.$occurrencesInput.style.display = "flex";
      this.$occurrencesInput.toggleAttribute("opaque", true);
      this.$occurrencesInput.assignStyles({
        height: "32px",
        width: "60px",
      });
      $occRow.appendChild(this.$occurrencesInput);

      const $occLabel = Typography.caption("occurrences");
      $occLabel.style.color = "var(--text-sec)";
      $occRow.appendChild($occLabel);

      $afterContainer.appendChild($occRow);
      $afterSubtitle = $afterContainer;
    } else {
      $afterSubtitle = Typography.caption("Stop after a number of occurrences");
      $afterSubtitle.style.color = "var(--text-ter)";
    }

    const afterCell = RadioButtonCell.makeWith({
      title: "After",
      options: {
        $subtitle: $afterSubtitle,
        value: "after-occurrences",
        name: "end-type",
      },
    });
    endCells.push(afterCell);

    // Bind cells to group
    endGroup.bind(endCells);

    // Add cells to container
    for (const cell of endCells) {
      $endRadioContainer.appendChild(cell);
    }

    // Select the current option
    const currentCell = endCells.find(
      (cell) => cell.getAttribute("value") === this.model.endType,
    );
    if (currentCell) {
      endGroup.select(currentCell);
    }

    // Setup date picker
    const today = NaiveDate.today();
    this.$endDatePicker.bind({
      date: this.model.endDate || today.add({ days: 30 }),
      onChange: (date) => {
        this.model.endDate = date || null;
        this.notifyChange();
      },
      placeholder: "Select end date",
    });

    // Setup occurrences input
    this.$occurrencesInput.bind(this.model.occurrences ?? 10, {
      placeholder: "10",
    });
    this.$occurrencesInput.enableEditing();
    this.$occurrencesInput.setCallbacks({
      onChange: (value) => {
        this.model.occurrences = value;
        this.notifyChange();
      },
      onEditingFinished: (value) => {
        this.model.occurrences = value;
        this.notifyChange();
      },
    });
  }

  private notifyChange() {
    this.onChange?.(this.model);
  }

  rrule(): RRule {
    return new RRule(RecurrenceModel.toRRuleLike(this.model));
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
        padding: 12px;
        background: var(--bg);
        border-radius: 8px;
      }

      #root {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .section-label {
        margin-left: 4px;
        margin-bottom: 4px;
        color: var(--text-sec);
        font-size: var(--text-14px);
        font-weight: 500;
      }

      .frequency-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      #frequency-dropdown {
        flex: 1;
        min-width: 150px;
        max-width: 200px;
        height: 36px;
      }

      .weekday-container {
        gap: 8px;
        flex-wrap: wrap;
      }

      .weekday-button {
        padding: 8px 12px;
        cursor: pointer;
        color: var(--text-pri);
        text-align: center;
      }

      .weekday-button:hover {
        border-color: var(--divider);
      }

      .weekday-button.selected {
        background: var(--blue);
        color: var(--text-pri-on-solid);
        border-color: var(--blue);
      }

      .weekday-button.reference-day.selected {
        border-color: var(--blue);
      }

      .monthday-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .end-radio-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      #end-date-picker {
        max-width: 200px;
        margin-top: 8px;
      }

      std-list-cell-layout {
        --list-cell-layout-hover-color: transparent;
        cursor: default;
      }

      #occurrences-input {
        --margin-top: 0px;
        padding-inline: 8px;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <div class="section">
        <label class="section-label">Repeat every</label>
        <div class="frequency-row">
          <std-number-input id="interval-input" opaque></std-number-input>
          <std-dropdown id="frequency-dropdown"></std-dropdown>
        </div>
      </div>

      <div id="repeat-on-section" class="section repeat-on-section">
        <label class="section-label">Repeat on</label>
        <std-row id="weekday-container" class="weekday-container"></std-row>
        <div id="monthday-container" class="monthday-container"></div>
      </div>

      <div class="section">
        <label class="section-label">Ends</label>
        <div id="end-radio-container" class="end-radio-container"></div>
        <std-date-picker-input id="end-date-picker" style="display: none;"></std-date-picker-input>
        <std-number-input id="occurrences-input" opaque style="display: none;"></std-number-input>
      </div>
    </div>
  `;
}

type RecurrenceEndType = "never" | "on-date" | "after-occurrences";

export interface RecurrenceModel {
  interval: number;
  frequency: Frequency;
  weekdays: Weekday[];
  monthDays: number[];
  monthWeekday: Option<Weekday.Nth>;
  endType: RecurrenceEndType;
  endDate: Option<NaiveDate>;
  occurrences: Option<number>;
}

export namespace RecurrenceModel {
  export function toRRule(model: RecurrenceModel): RRule {
    return new RRule(RecurrenceModel.toRRuleLike(model));
  }

  export function toRRuleLike(model: RecurrenceModel): RRuleLike {
    const rrule: RRuleLike = {
      freq: model.frequency,
      options: {
        interval: model.interval,
      },
    };

    // Add weekdays for weekly frequency
    if (model.frequency === "weekly" && model.weekdays.length > 0) {
      rrule.options!.byday = model.weekdays;
    }

    // Add month options for monthly frequency
    if (model.frequency === "monthly") {
      if (model.monthWeekday) {
        rrule.options!.bynthday = [model.monthWeekday];
      } else if (model.monthDays.length > 0) {
        rrule.options!.bymonthday = model.monthDays;
      }
    }

    // Add end conditions
    if (model.endType === "on-date" && model.endDate) {
      rrule.options!.until = new IsoDate(model.endDate, null, null);
    } else if (model.endType === "after-occurrences" && model.occurrences) {
      rrule.options!.count = model.occurrences;
    }

    return rrule;
  }

  /**
   * Inverse of {@link toRRuleLike}: read a parsed RRULE back into the editor
   * model so an EXISTING recurring event displays its rule (e.g. "Weekly")
   * instead of the "Does not repeat" placeholder. Unsupported options fall back
   * to the model defaults.
   */
  export function fromRRule(rrule: RRule): RecurrenceModel {
    const options = rrule.inner.options ?? {};
    const model: RecurrenceModel = {
      interval: options.interval ?? 1,
      frequency: rrule.inner.freq,
      weekdays: options.byday ?? [],
      monthDays: options.bymonthday ?? [],
      monthWeekday: options.bynthday?.[0] ?? null,
      endType: "never",
      endDate: null,
      occurrences: null,
    };
    if (options.count != null) {
      model.endType = "after-occurrences";
      model.occurrences = options.count;
    } else if (options.until != null) {
      model.endType = "on-date";
      model.endDate = options.until.trunc();
    }
    return model;
  }
}

export namespace RecurrenceEditor {
  export type Model = RecurrenceModel;
  export type Props = {
    model?: RecurrenceModel;
    referenceDate: NaiveDate;
    onChange?: (model: RecurrenceModel) => void;
  };

  export function getNthString(n: number): string {
    const suffixes = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  }

  export function createFrequencyDropdownRows(
    interval: number,
    selectedFrequency: Frequency,
  ): Dropdown.Row<Frequency>[] {
    const isPlural = interval > 1;

    return [
      {
        data: "daily",
        content: ListCellLayout.makeText(isPlural ? "days" : "day", {
          size: "small",
        }).assignStyles({ "--list-cell-layout-hover-color": "none" }),
        searchIndicies: ["day", "days", "daily"],
        selected: selectedFrequency === "daily",
      },
      {
        data: "weekly",
        content: ListCellLayout.makeText(isPlural ? "weeks" : "week", {
          size: "small",
        }).assignStyles({ "--list-cell-layout-hover-color": "none" }),
        searchIndicies: ["week", "weeks", "weekly"],
        selected: selectedFrequency === "weekly",
      },
      {
        data: "monthly",
        content: ListCellLayout.makeText(isPlural ? "months" : "month", {
          size: "small",
        }).assignStyles({ "--list-cell-layout-hover-color": "none" }),
        searchIndicies: ["month", "months", "monthly"],
        selected: selectedFrequency === "monthly",
      },
      {
        data: "yearly",
        content: ListCellLayout.makeText(isPlural ? "years" : "year", {
          size: "small",
        }).assignStyles({ "--list-cell-layout-hover-color": "none" }),
        searchIndicies: ["year", "years", "yearly"],
        selected: selectedFrequency === "yearly",
      },
    ];
  }

  export function getFrequencyLabels(
    interval: number,
  ): Record<Frequency, string> {
    const isPlural = interval > 1;
    return {
      secondly: isPlural ? "seconds" : "second",
      minutely: isPlural ? "minutes" : "minute",
      hourly: isPlural ? "hours" : "hour",
      daily: isPlural ? "days" : "day",
      weekly: isPlural ? "weeks" : "week",
      monthly: isPlural ? "months" : "month",
      yearly: isPlural ? "years" : "year",
    };
  }

  export function createWeekdayButton(
    day: Weekday,
    isSelected: boolean,
    isReferenceDay: boolean,
    onToggle: (day: Weekday, button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const $button = document.createElement("button");
    $button.className = "weekday-button";
    $button.textContent = day.shortname;
    $button.dataset.weekday = String(day.dow);

    if (isReferenceDay) {
      $button.classList.add("reference-day");
    }

    if (isSelected) {
      $button.classList.add("selected");
    }

    $button.addEventListener("click", () => {
      onToggle(day, $button);
    });

    return $button;
  }

  export function getDefaultModel(): RecurrenceModel {
    return {
      interval: 1,
      frequency: "daily",
      weekdays: [],
      monthDays: [],
      monthWeekday: null,
      endType: "never",
      endDate: null,
      occurrences: null,
    };
  }

  export function mergeWithDefaults(
    partial: Partial<RecurrenceModel>,
    referenceDate: NaiveDate,
  ): RecurrenceModel {
    const defaults = getDefaultModel();
    const model = { ...defaults, ...partial };

    // Ensure frequency-specific defaults are set based on the merged model
    if (model.frequency === "weekly" && model.weekdays.length === 0) {
      model.weekdays = [referenceDate.dayOfWeek];
    } else if (model.frequency === "monthly") {
      // If switching to monthly and no month config exists, set day of month
      if (model.monthDays.length === 0 && model.monthWeekday === null) {
        model.monthDays = [referenceDate.day];
      }
    }

    // Ensure end defaults are set
    if (model.endType === "on-date" && !model.endDate) {
      model.endDate = NaiveDate.today().add({ days: 30 });
    } else if (model.endType === "after-occurrences" && !model.occurrences) {
      model.occurrences = 10;
    }

    return model;
  }

  export function createStyledLabel(text: string): HTMLElement {
    const $label = Typography.p(text);
    $label.assignStyles({
      "--margin-bottom": "0px",
      "--margin-top": "4px",
      fontSize: "var(--text-14px)",
    });
    return $label;
  }
}
