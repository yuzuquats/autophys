import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Dropdown } from "../controls/dropdown";
import { DropdownInput } from "./dropdown-input";

const TIMEZONES: Dropdown.Row<string>[] = [
  { content: "Los Angeles", data: "America/Los_Angeles", selected: true },
  { content: "Denver", data: "America/Denver" },
  { content: "Chicago", data: "America/Chicago" },
  { content: "New York", data: "America/New_York" },
  { content: "London", data: "Europe/London" },
  { content: "Tokyo", data: "Asia/Tokyo" },
];

// Airport codes and nicknames go in `searchIndicies`, so typing "sfo" or
// "big apple" ranks the right city first even though neither is the label.
const OFFICES: Dropdown.Row<string>[] = [
  { content: "Amsterdam", data: "ams", searchIndicies: ["AMS", "Schiphol"] },
  { content: "Austin", data: "aus", searchIndicies: ["AUS"] },
  { content: "Berlin", data: "ber", searchIndicies: ["BER"] },
  { content: "Lisbon", data: "lis", searchIndicies: ["LIS"] },
  { content: "London", data: "lhr", searchIndicies: ["LHR", "Heathrow"] },
  {
    content: "New York",
    data: "jfk",
    searchIndicies: ["JFK", "NYC", "Big Apple"],
  },
  {
    content: "San Francisco",
    data: "sfo",
    searchIndicies: ["SFO", "SF", "Bay Area"],
  },
  { content: "Seoul", data: "icn", searchIndicies: ["ICN"] },
  { content: "Singapore", data: "sin", searchIndicies: ["SIN", "Changi"] },
  { content: "Sydney", data: "syd", searchIndicies: ["SYD"] },
  { content: "Toronto", data: "yyz", searchIndicies: ["YYZ"] },
  { content: "Zurich", data: "zrh", searchIndicies: ["ZRH"] },
];

export class CoreDropdownInputStoryBook extends Storybook.Default {
  title(): string {
    return "Dropdown Input";
  }

  tags(): string[] {
    return ["std-dropdown-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Timezone — the label row echoes the stored value",
        render: () => {
          const $dropdown = Dropdown.make() as Dropdown<string>;
          const $input = DropdownInput.makeWith({
            label: "Timezone",
            currentValue: "America/Los_Angeles",
            dropdown: $dropdown,
          });
          // The rows show a city; the echo on the right shows the IANA id the
          // setting actually stores. DropdownInput never reads the dropdown,
          // so the caller keeps the echo in sync on every selection.
          $dropdown.bind({
            rows: TIMEZONES,
            placeholder: "Search timezones",
            onSelectedRow: (row) => $input.updateCurrentValue(row.data),
          });
          return CoreDropdownInputStoryBook.$frame($input);
        },
      },
      {
        title: "Nothing chosen yet — placeholder until the first pick",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("No project assigned");

          const $dropdown = Dropdown.make() as Dropdown<string>;
          const $input = DropdownInput.makeWith({
            label: "Project",
            currentValue: "Not set",
            dropdown: $dropdown,
          });
          $dropdown.bind({
            rows: [
              { content: "Website relaunch", data: "web" },
              { content: "Q4 planning", data: "q4" },
              { content: "Hiring", data: "hiring" },
              { content: "Office move", data: "office" },
            ],
            placeholder: "Choose a project",
            onSelectedRow: (row) => {
              $input.updateCurrentValue(String(row.content));
              $status.bindText(`Assigned to ${row.data}`);
            },
          });
          return {
            $content: CoreDropdownInputStoryBook.$frame($input),
            $status,
          };
        },
      },
      {
        title: "Long list — type to rank by name, code or nickname",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Try typing “sfo” or “big apple”");

          const $dropdown = Dropdown.make() as Dropdown<string>;
          const $input = DropdownInput.makeWith({
            label: "Home office",
            currentValue: "Lisbon",
            dropdown: $dropdown,
          });
          // Search reorders rather than filters: every row stays in the list,
          // sorted by edit distance, and the closest one is pre-highlighted
          // so Enter picks it.
          $dropdown.bind({
            rows: OFFICES.map((row) => ({
              ...row,
              selected: row.data === "lis",
            })),
            placeholder: "City or airport code",
            onSelectedRow: (row) => {
              $input.updateCurrentValue(String(row.content));
              $status.bindText(`Home office ${row.data.toUpperCase()}`);
            },
          });
          return {
            $content: CoreDropdownInputStoryBook.$frame($input),
            $status,
          };
        },
      },
      {
        title: "Disabled — value managed elsewhere",
        render: () => {
          const $dropdown = Dropdown.make() as Dropdown<string>;
          const $input = DropdownInput.makeWith({
            label: "Billing currency",
            currentValue: "Set by your workspace",
            dropdown: $dropdown,
          });
          $dropdown.bind({
            rows: [
              { content: "US Dollar (USD)", data: "usd", selected: true },
              { content: "Euro (EUR)", data: "eur" },
            ],
            disabled: true,
          });
          return CoreDropdownInputStoryBook.$frame($input);
        },
      },
      {
        title: "A settings group — several rows stacked",
        render: () => {
          const settings = {
            language: "English",
            weekStart: "Monday",
            clock: "12-hour",
          };
          const $status = Storybook.Card.StatusLine.make();
          const report = () =>
            $status.bindText([
              `${settings.language}, ${settings.clock} clock`,
              `Week starts on ${settings.weekStart}`,
            ]);
          report();

          const $group = Column.make();
          $group.assignStyles({ width: "min(360px, 100%)" });
          $group.append(
            CoreDropdownInputStoryBook.$setting(
              "Language",
              ["English", "Deutsch", "Español", "日本語"],
              settings.language,
              (value) => {
                settings.language = value;
                report();
              },
            ),
            CoreDropdownInputStoryBook.$setting(
              "Week starts on",
              ["Saturday", "Sunday", "Monday"],
              settings.weekStart,
              (value) => {
                settings.weekStart = value;
                report();
              },
            ),
            CoreDropdownInputStoryBook.$setting(
              "Clock",
              ["12-hour", "24-hour"],
              settings.clock,
              (value) => {
                settings.clock = value;
                report();
              },
            ),
          );
          return { $content: $group, $status };
        },
      },
    ];
  }

  /** One labeled setting whose rows are plain strings (label = value). */
  private static $setting(
    label: string,
    options: string[],
    initial: string,
    onChange: (value: string) => void,
  ): DropdownInput {
    const $dropdown = Dropdown.make() as Dropdown<string>;
    const $input = DropdownInput.makeWith({
      label,
      currentValue: initial,
      dropdown: $dropdown,
    });
    $dropdown.bind({
      rows: options.map((option) => ({
        content: option,
        data: option,
        selected: option === initial,
      })),
      onSelectedRow: (row) => {
        $input.updateCurrentValue(row.data);
        onChange(row.data);
      },
    });
    return $input;
  }

  /** The input has no host display of its own, so it sits in a column that
   * gives it a block box and a settings-panel measure. */
  private static $frame($input: DropdownInput): HTMLElement {
    const $frame = Column.make();
    $frame.assignStyles({ width: "min(360px, 100%)" });
    $frame.appendChild($input);
    return $frame;
  }
}
