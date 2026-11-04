import { Tzname } from "@tento-chrono";
import { Storybook } from "../ui/storybook";
import { TimezoneDropdown } from "./timezone-dropdown";
import { Toast } from "./toast/toast";

function toast(tz: Option<TimezoneDropdown.Entry>) {
  if (tz) {
    Toast.info(`Selected: ${tz.id} (${tz.abbreviations.join(", ")})`);
  } else {
    Toast.info("No timezone selected");
  }
}

export class TimezoneDropdownStoryBook extends Storybook.Default {
  title(): string {
    return "Timezone Dropdown";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Timezone Dropdown",
        render: () => {
          return TimezoneDropdown.makeWith({
            onChange: toast,
          }).assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Common Timezones Only",
        render: () => {
          return TimezoneDropdown.makeWith({
            commonOnly: true,
            placeholder: "Select a common timezone...",
            onChange: toast,
          }).assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Pre-selected Value",
        render: () => {
          return TimezoneDropdown.makeWith({
            value: "America/New_York" as Tzname,
            commonOnly: true,
            onChange: toast,
          }).assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Second Line",
        render: () => {
          return TimezoneDropdown.makeWith({
            value: "America/New_York" as Tzname,
            commonOnly: true,
            onChange: toast,
            showSelectedCaption: true,
          }).assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
    ];
  }
}
