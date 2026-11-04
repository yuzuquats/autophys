import { NaiveDate } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { DatePicker } from "./date-picker";

export class DatePickerStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-date-picker"];
  }

	title(): string {
		return "Date Picker Examples";
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "Default (Week starts on Sunday)",
				render: () => {
					const $c = DatePicker.make();
					const today = NaiveDate.today();
					$c.bindToDate(today, today);
					$c.onSelectedDate = (date) => {
						console.log("Selected:", date.toString());
						return true;
					};
					return $c;
				},
			},
			{
				title: "Week starts on Monday",
				render: () => {
					const $c = DatePicker.makeWith({
						startWeekOnMonday: true,
						onSelectedDate: (date) => {
							console.log("Selected:", date.toString());
							return true;
						},
					});
					const today = NaiveDate.today();
					$c.bindToDate(today, today);
					return $c;
				},
			},
			{
				title: "With viewport range highlighting",
				render: () => {
					const $c = DatePicker.makeWith({
						startWeekOnMonday: true,
						onSelectedDate: (date) => {
							console.log("Selected:", date.toString());
							return true;
						},
					});
					const today = NaiveDate.today();
					$c.bindToDate(today, today);

					// Highlight next week
					const nextWeekStart = today.add({
						days: 7 - today.dayOfWeek.dow + 1,
					});
					const nextWeekEnd = nextWeekStart.add({ days: 7 });
					const range = new NaiveDate.Range(nextWeekStart, nextWeekEnd);
					$c.updateViewport(range);

					return $c;
				},
			},
			{
				title: "Large size",
				render: () => {
					const $c = DatePicker.makeWith({
						size: "large",
						startWeekOnMonday: true,
						onSelectedDate: (date) => {
							console.log("Selected:", date.toString());
							return true;
						},
					});
					const today = NaiveDate.today();
					$c.bindToDate(today, today);
					return $c;
				},
			},
		];
	}
}
