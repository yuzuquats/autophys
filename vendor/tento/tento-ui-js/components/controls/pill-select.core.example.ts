import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { InputLayout } from "../input/input-layout";
import { PillSelect } from "./pill-select";

type SortKey = "recent" | "title" | "size" | "owner";
type CalendarRange = "day" | "week" | "month" | "year";
type UnitSystem = "metric" | "imperial";

const SORT_OPTIONS: PillSelect.Item<SortKey>[] = [
  { identifier: "recent", label: "Recent" },
  { identifier: "title", label: "Title" },
  { identifier: "size", label: "Size" },
  { identifier: "owner", label: "Owner" },
];

const RANGES: PillSelect.Item<CalendarRange>[] = [
  { identifier: "day", label: "Day" },
  { identifier: "week", label: "Week" },
  { identifier: "month", label: "Month" },
  { identifier: "year", label: "Year" },
];

const DISTANCE_UNITS: Record<UnitSystem, PillSelect.Item<string>[]> = {
  metric: [
    { identifier: "m", label: "Meters" },
    { identifier: "km", label: "Kilometers" },
  ],
  imperial: [
    { identifier: "ft", label: "Feet" },
    { identifier: "yd", label: "Yards" },
    { identifier: "mi", label: "Miles" },
  ],
};

export class CorePillSelectStoryBook extends Storybook.Default {
  title(): string {
    return "Pill Select";
  }

  tags(): string[] {
    return ["std-pill-select"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sort order — exactly one pill is filled",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Sorted by Recent");

          const $pills = PillSelect.make() as PillSelect<SortKey>;
          $pills.bind("recent", SORT_OPTIONS);
          $pills.onSelected = (key) => {
            const label = SORT_OPTIONS.find((o) => o.identifier === key)?.label;
            $status.bindText(`Sorted by ${label}`);
          };
          return { $content: CorePillSelectStoryBook.$frame($pills), $status };
        },
      },
      {
        title: "In a labeled form row",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Remind 15 min before");

          const $pills = PillSelect.make() as PillSelect<string>;
          $pills.bind("15m", [
            { identifier: "none", label: "None" },
            { identifier: "5m", label: "5 min" },
            { identifier: "15m", label: "15 min" },
            { identifier: "1h", label: "1 hour" },
            { identifier: "1d", label: "1 day" },
          ]);
          $pills.onSelected = (value) => {
            $status.bindText(
              value === "none" ? "No reminder" : `Remind ${value} before`,
            );
          };

          const $layout = InputLayout.make().bind({
            label: "Reminder",
            caption: "Applies to new events on this calendar",
          });
          $layout.appendChild($pills);
          return { $content: CorePillSelectStoryBook.$frame($layout), $status };
        },
      },
      {
        title: "Many options wrap onto a second line",
        render: () =>
          CorePillSelectStoryBook.$frame(
            (PillSelect.make() as PillSelect<string>).bind("open", [
              { identifier: "all", label: "All" },
              { identifier: "open", label: "Open" },
              { identifier: "review", label: "In review" },
              { identifier: "blocked", label: "Blocked" },
              { identifier: "scheduled", label: "Scheduled" },
              { identifier: "done", label: "Done" },
              { identifier: "archived", label: "Archived" },
            ]),
            "280px",
          ),
      },
      {
        title: "Long labels truncate at 200px",
        render: () =>
          CorePillSelectStoryBook.$frame(
            (PillSelect.make() as PillSelect<string>).bind("shared", [
              { identifier: "mine", label: "Mine" },
              {
                identifier: "shared",
                label: "Shared with me in the last 30 days",
              },
              {
                identifier: "team",
                label: "Everything the design team can see",
              },
            ]),
          ),
      },
      {
        title: "Changed from code — setSelected skips onSelected by default",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $pills = PillSelect.make() as PillSelect<CalendarRange>;
          const report = (source: string) => {
            $status.bindText(`${source}: ${$pills.selectedIdentifier}`);
          };
          $pills.bind("week", RANGES);
          $pills.onSelected = () => report("onSelected");
          report("Initial");

          // Moving the selection programmatically is silent unless `notify`
          // is passed; a click always notifies.
          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Jump to Day", {
              type: "flat",
              onClick: () => {
                $pills.setSelected("day");
                report("setSelected (silent)");
              },
            }),
            Button.makeWith("Jump to Month, notify", {
              type: "flat",
              onClick: () => $pills.setSelected("month", true),
            }),
          );
          return {
            $content: CorePillSelectStoryBook.$frame($pills),
            $status,
            $controls,
          };
        },
      },
      {
        title: "Dependent choices — rebinding replaces the pills",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $system = PillSelect.make() as PillSelect<UnitSystem>;
          const $unit = PillSelect.make() as PillSelect<string>;
          const report = () => {
            $status.bindText(
              `${$system.selectedIdentifier}, ${$unit.selectedIdentifier}`,
            );
          };

          // `bind` re-renders every pill, so the second row can follow the
          // first: switching systems swaps the units and selects the largest.
          const bindUnits = (system: UnitSystem) => {
            const units = DISTANCE_UNITS[system];
            $unit.bind(units[units.length - 1]!.identifier, units);
          };
          $system.bind("metric", [
            { identifier: "metric", label: "Metric" },
            { identifier: "imperial", label: "Imperial" },
          ]);
          $system.onSelected = (system) => {
            bindUnits(system);
            report();
          };
          $unit.onSelected = report;
          bindUnits("metric");
          report();

          const $stack = Column.make();
          $stack.assignStyles({ gap: "12px" });
          $stack.append($system, $unit);
          return { $content: CorePillSelectStoryBook.$frame($stack), $status };
        },
      },
    ];
  }

  private static $frame(
    $child: HTMLElement,
    width: string = "360px",
  ): HTMLElement {
    const $frame = Column.make();
    $frame.assignStyles({ width: `min(${width}, 100%)` });
    $frame.appendChild($child);
    return $frame;
  }
}
