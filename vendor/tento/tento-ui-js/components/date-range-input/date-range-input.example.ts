import { NaiveDate } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { DateRangeInput } from "./date-range-input";

export class DateRangeInputStoryBook extends Storybook.Default {
  title(): string {
    return "Date Range Input";
  }

  tags(): string[] {
    return ["std-date-range-input"];
  }

  examples(): Storybook.Example[] {
    const today = NaiveDate.today();
    return [
      { title: "Empty", render: () => DateRangeInput.makeWith({ start: null, end: null, onChange: () => {}, onInvalid: null, placeholders: null, minDate: null, maxDate: null, label: "Trip" }) },
      { title: "Preset week (set the end before the start to see the error)", render: () => DateRangeInput.makeWith({ start: today, end: today.addDays(7), onChange: () => {}, onInvalid: null, placeholders: { start: "Check-in", end: "Check-out" }, minDate: null, maxDate: null, label: "Stay" }) },
    ];
  }
}
