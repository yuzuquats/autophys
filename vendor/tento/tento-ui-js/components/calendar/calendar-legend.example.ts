import "./calendar-legend";

import { TimeOfDay } from "@tento-chrono";
import { Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { PropertyList } from "../input/property-list";
import { CalendarLegend } from "./calendar-legend";

export class CalendarLegendStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Legend";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Calendar Legend",
        render: () => {
          const $legend = CalendarLegend.make();
          const startTime = TimeOfDay.wrap({ hrs: 9 });
          const endTime = TimeOfDay.wrap({ hrs: 17 });
          $legend.bind("EST", new TimeOfDay.Range(startTime, endTime, true));
          return $legend.assignStyles({
            height: "384px",
            background: "var(--bg)",
            overflow: "hidden",
            borderRadius: "8px",
            "--sticky-top": "10px",
          });
        },
      },
      {
        title: "Full Day (12am - 12am)",
        render: () => {
          const $legend = CalendarLegend.make();
          $legend.bind("PST", TimeOfDay.Range.DAY);
          return $legend.assignStyles({
            height: "1152px",
            background: "var(--bg)",
            overflow: "hidden",
            borderRadius: "8px",
            "--sticky-top": "10px",
          });
        },
      },
      {
        title: "Custom Time Range (6am - 10pm)",
        render: () => {
          const $legend = CalendarLegend.make();
          const startTime = TimeOfDay.wrap({ hrs: 6 });
          const endTime = TimeOfDay.wrap({ hrs: 22 });
          $legend.bind("CST", new TimeOfDay.Range(startTime, endTime, true));

          const cursorTime = TimeOfDay.wrap({ hrs: 14, mins: 30 });
          $legend.bindCursor(cursorTime);
          $legend.bindCursorDisplay(true);

          return $legend.assignStyles({
            height: "768px",
            background: "var(--bg)",
            overflow: "hidden",
            borderRadius: "8px",
            "--sticky-top": "10px",
          });
        },
      },
      CalendarLegendStoryBook.INTERACTIVE_CURSOR_EXAMPLE,
    ];
  }
}

export namespace CalendarLegendStoryBook {
  export const INTERACTIVE_CURSOR_EXAMPLE = {
    title: "Interactive Cursor",
    render: () => {
      const $legend = CalendarLegend.make();
      $legend.bind("UTC", TimeOfDay.Range.DAY);
      $legend.assignStyles({
        height: "1152px",
        background: "var(--bg)",
        overflow: "hidden",
        borderRadius: "8px",
        "--sticky-top": "10px",
      });

      const $status = Storybook.Card.StatusLine.make();
      $status.style.minHeight = "unset";

      const times = [
        { label: "9a", time: TimeOfDay.wrap({ hrs: 9, mins: 0 }) },
        { label: "12:30p", time: TimeOfDay.wrap({ hrs: 12, mins: 30 }) },
        { label: "3:45p", time: TimeOfDay.wrap({ hrs: 15, mins: 45 }) },
        { label: "6p", time: TimeOfDay.wrap({ hrs: 18, mins: 0 }) },
      ];

      const updateStatus = (time: Option<TimeOfDay>, visible: boolean) => {
        if (!time) {
          $status.bindText("No cursor");
        } else if (!visible) {
          $status.bindText(
            `Cursor at ${time.format({ includeSeconds: false, includeAmPm: true })} (hidden)`,
          );
        } else {
          $status.bindText(
            `Cursor at ${time.format({ includeSeconds: false, includeAmPm: true })}`,
          );
        }
      };

      let currentTime: Option<TimeOfDay> = undefined;
      let currentVisible: boolean = false;

      const record: PropertyList.Items = {
        position: {
          $e: (() => {
            const $row = Row.make();
            $row.style.gap = "8px";
            $row.style.flexWrap = "wrap";

            for (const { label, time } of times) {
              $row.appendChild(
                Button.makeWithLight(label, {
                  type: "secondary",
                  onClick: () => {
                    currentTime = time;
                    currentVisible = true;
                    $legend.bindCursor(time);
                    $legend.bindCursorDisplay(true);
                    updateStatus(currentTime, currentVisible);
                  },
                }).assignStyles({
                  padding: "4px 12px",
                }),
              );
            }

            return $row;
          })(),
          label: "Set Position:",
          order: 0,
        },
        visibility: {
          $e: (() => {
            const $row = Row.make();
            $row.style.gap = "8px";

            $row.appendChild(
              Button.makeWithLight("Show", {
                type: "secondary",
                onClick: () => {
                  currentVisible = true;
                  $legend.bindCursorDisplay(true);
                  updateStatus(currentTime, currentVisible);
                },
              }).assignStyles({
                padding: "4px 12px",
              }),
            );

            $row.appendChild(
              Button.makeWithLight("Hide", {
                type: "secondary",
                onClick: () => {
                  currentVisible = false;
                  $legend.bindCursorDisplay(false);
                  updateStatus(currentTime, currentVisible);
                },
              }).assignStyles({
                padding: "4px 12px",
              }),
            );

            $row.appendChild(
              Button.makeWithLight("Remove", {
                type: "secondary",
                onClick: () => {
                  currentTime = undefined;
                  currentVisible = false;
                  $legend.bindCursor(undefined);
                  updateStatus(currentTime, currentVisible);
                },
              }).assignStyles({
                padding: "4px 12px",
              }),
            );

            return $row;
          })(),
          label: "Visibility:",
          order: 1,
        },
      };

      updateStatus(currentTime, currentVisible);

      return {
        $status,
        $controls: PropertyList.makeWith(record),
        $content: $legend,
      };
    },
  };
}
