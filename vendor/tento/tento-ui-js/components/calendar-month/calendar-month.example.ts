import {
  DateTime,
  Month,
  NaiveDate,
  TimezoneRegion,
  Weekday,
} from "@tento-chrono";
import { Div, Row } from "../../component-builtin";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { CalendarMonth } from "./calendar-month";
import { CalendarMonthSpan } from "./calendar-month-span";
import { EntryList } from "../entry-list/entry-list";
import { EntryDisplay } from "../entry-list/list-item";
import { Toast } from "../toast/toast";

function makeSpanRenderer(color: string, title: string) {
  return (info: CalendarMonth.SpanSegmentInfo) => {
    const $span = CalendarMonthSpan.makeWith({
      title,
      color,
      segment: info,
    });

    GESTURE_MANAGER.addPointerEvent($span, {
      onClick: () => Toast.info(`Span: ${title}`),
    });

    return $span;
  };
}

function renderSpanStacking(
  month: NaiveDate,
  spanConfigs: [number, number, string, string][],
  options: { exampleTime: DateTime<any>; timezone: TimezoneRegion },
): CalendarMonth {
  const firstOfMonth = NaiveDate.fromYmd1(month.yr, month.mth, 1).exp();

  const spans: CalendarMonth.Span[] = spanConfigs.map(
    ([startOffset, endOffset, color, title], i) => ({
      key: `example-span-${i}`,
      contentSig: `${title}|${color}`,
      range: new NaiveDate.Range(
        firstOfMonth.addDays(startOffset),
        firstOfMonth.addDays(endOffset),
      ),
      render: makeSpanRenderer(color, title),
    }),
  );

  const $calendar = CalendarMonth.make();
  $calendar.style.setProperty("--span-lane-height", "20px");

  return $calendar.bind({
    month,
    cellHeight: 120,
    bind: ($cell, date, isCurrentMonth) => {
      $cell.clearChildren();
      if (!isCurrentMonth) return;

      const $eventList = EntryList.makeWith({
        items: [
          {
            title: `Event ${date.day1}`,
            accentColor: "var(--red)",
            at: options.exampleTime,
            timezone: options.timezone,
          },
        ],
        display: EntryDisplay.DEFAULT,
      });
      $cell.appendChild($eventList);
    },
    options: {
      cellWidth: 180,
      startOfWeek: Weekday.SUN,
      today: month,
      spans,
    },
  });
}

export class CalendarMonthStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Month";
  }

  examples(): Storybook.Example[] {
    const exampleTime = DateTime.utc.now();
    const timezone = TimezoneRegion.UTC;

    return [
      {
        title: "Calendar",
        render: () => {
          const today = NaiveDate.today();
          return CalendarMonth.make().bind({
            month: today,
            cellHeight: 160,
            bind: ($cell, date, _isCurrentMonth) => {
              $cell.bindDate(date, today);
              $cell.clearChildren();

              if (!date.equals(today)) return;
              const $e = EntryList.makeWith({
                items: [
                  {
                    title: "Morning Standup",
                    accentColor: "var(--teal)",
                    at: exampleTime,
                    timezone,
                  },
                  {
                    title: "1:1 with Manager",
                    accentColor: "var(--blue)",
                    at: exampleTime,
                    timezone,
                  },
                ],
                display: EntryDisplay.DEFAULT,
              });
              $cell.appendChild($e);
            },
            options: {
              cellWidth: 220,
              startOfWeek: Weekday.MON,
              showLeftBorder: true,
            },
          });
        },
      },
      {
        title: "Responsive Width Calendar",
        render: () => {
          const events = new Map<
            string,
            { title: string; time: DateTime<any>; color: string }[]
          >([
            [
              NaiveDate.today().toString(),
              [{ title: "Meeting", time: exampleTime, color: "var(--blue)" }],
            ],
          ]);

          const $container = Div.make().assignStyles({
            width: "100%",
            border: "2px solid var(--divider)",
            borderRadius: "8px",
            padding: "16px",
            background: "var(--bg)",
            resize: "horizontal",
            overflow: "auto",
          });
          const $calendar = CalendarMonth.make();

          let currentMonth = NaiveDate.today();
          const updateCalendar = () =>
            $calendar.bind({
              month: currentMonth,
              cellHeight: 80,
              bind: ($cell, date, isCurrentMonth) => {
                DomUtils.clearChildren($cell);
                if (!isCurrentMonth) return;

                const dateKey = date.toString();
                const dayEvents = events.get(dateKey);
                if (dayEvents && dayEvents.length > 0) {
                  const firstEvent = dayEvents[0];
                  const $content = EntryList.makeWith({
                    items: [
                      {
                        title: firstEvent.title,
                        accentColor: firstEvent.color,
                        at: firstEvent.time,
                        timezone,
                      },
                    ],
                    display: EntryDisplay.DEFAULT,
                  });
                  $cell.appendChild($content);
                }
              },
              options: {
                startOfWeek: Weekday.MON,
              },
            });

          // Navigation controls
          const $controls = Row.make();
          $controls.style.justifyContent = "space-between";
          $controls.style.alignItems = "center";
          $controls.style.marginBottom = "16px";

          const $monthLabel = Typography.h4(
            `${Month.MONTHS0[currentMonth.month0].name} ${currentMonth.yr}`,
          );
          $controls.appendChild(
            Button.makeWithLight("Previous", {
              type: "secondary",
              onClick: () => {
                currentMonth = currentMonth.add({ mths: -1 });
                $monthLabel.textContent = `${Month.MONTHS0[currentMonth.month0].name} ${currentMonth.yr}`;
                updateCalendar();
              },
            }),
          );
          $controls.appendChild($monthLabel);
          $controls.appendChild(
            Button.makeWithLight("Next", {
              type: "secondary",
              onClick: () => {
                currentMonth = currentMonth.add({ mths: 1 });
                $monthLabel.textContent = `${Month.MONTHS0[currentMonth.month0].name} ${currentMonth.yr}`;
                updateCalendar();
              },
            }),
          );

          updateCalendar();
          $container.appendChild($controls);
          $container.appendChild($calendar);

          return $container;
        },
      },
      {
        title: "Span Stacking",
        render: () => {
          const today = NaiveDate.today();

          // Span configurations: [startDayOffset, endDayOffset, color, title]
          const spanConfigs: [number, number, string, string][] = [
            [1, 5, "var(--blue)", "Team Offsite"],
            [3, 7, "var(--teal)", "Project Alpha"],
            [8, 10, "var(--purple)", "Sprint Review"],
            [4, 6, "var(--orange)", "Design Week"],
            [15, 18, "var(--green)", "Conference"],
          ];

          const $calendar = renderSpanStacking(today, spanConfigs, {
            exampleTime,
            timezone,
          });
          return $calendar;
        },
      },
      {
        title: "Span Stacking - Week Boundary",
        render: () => {
          const today = NaiveDate.today();

          // Test spans that cross week boundaries
          const spanConfigs: [number, number, string, string][] = [
            [5, 9, "var(--blue)", "Cross-week Event"],
            [12, 16, "var(--teal)", "Multi-day Workshop"],
            [0, 2, "var(--purple)", "Kickoff"],
            [19, 25, "var(--orange)", "Long Sprint"],
          ];

          return renderSpanStacking(today, spanConfigs, {
            exampleTime,
            timezone,
          });
        },
      },
      {
        title: "Span Stacking - Dense Overlap",
        render: () => {
          const today = NaiveDate.today();

          // Many overlapping spans in the same area
          const spanConfigs: [number, number, string, string][] = [
            [2, 8, "var(--blue)", "Event A"],
            [3, 7, "var(--teal)", "Event B"],
            [4, 6, "var(--purple)", "Event C"],
            [5, 9, "var(--orange)", "Event D"],
            [2, 4, "var(--green)", "Event E"],
            [6, 10, "var(--red)", "Event F"],
          ];

          return renderSpanStacking(today, spanConfigs, {
            exampleTime,
            timezone,
          });
        },
      },
    ];
  }
}
