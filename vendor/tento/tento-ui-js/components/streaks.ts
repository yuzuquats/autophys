import { LonaWebComponent, html } from "@tento-ui/component";
import { Column, Div } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { MathUtils } from "@tento-core/math";
import { GenericRange, NaiveDate, Weekday, naivedate } from "@tento-chrono";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { $jsx } from "../ui/jsx";
import { Tooltip } from "./tooltip/tooltip";

@component({
  name: "std-streaks",
})
export class Streaks extends LonaWebComponent {
  bind(props: Streaks.Props) {
    DomUtils.clearChildren(this.$("streak-grid"));
    DomUtils.clearChildren(this.$("months"));

    let start = props.range.start;
    let end = props.range.end;
    const today = props.today ?? NaiveDate.today();

    let currentDay = start;
    let offset = 0;
    let gotToday = false;

    while (currentDay.isBefore(end) || currentDay.equals(end)) {
      const $col = Column.make();
      $$.mutate(() => this.$("streak-grid").appendChild($col));

      // Track if this column contains the first day of a month
      let monthToShow: Option<typeof currentDay.month> = undefined;

      for (let day = 0; day < 7; ++day) {
        const $day = Div.make();
        $day.classList.add("cell");
        $col.appendChild($day);

        const value = gotToday ? 0 : props.value(currentDay);
        if (value !== 0) {
          const opacity = MathUtils.lerp(0.3, 1, value / 4);
          $day.style.background =
            `color-mix(in srgb, var(--activity-color, #adb88a) ${Math.round(opacity * 100)}%, transparent)`;
        } else if (gotToday) {
          $day.style.background =
            "var(--activity-empty, rgba(255,255,255,0.5))";
        }
        $day.setAttribute("day", String(currentDay.toString()));
        $day.setAttribute("value", String(value));
        $day.setAttribute(
          "tooltip",
          `${currentDay.dayOfWeek.label} ${currentDay.month.name} ${currentDay.day}, ${currentDay.yr}, Count: ${value}`,
        );

        if (currentDay.equals(today)) {
          gotToday = true;
          $day.style.border = "var(--activity-today-border, 2px solid #666)";
        }

        // Check if this day is the first of a month
        if (currentDay.day === 1) {
          monthToShow = currentDay.month;
        }

        currentDay = currentDay.add({ days: 1 });
      }

      // Add month label if this column contains the 1st of a month
      if (monthToShow) {
        this.$("months").appendChild(
          $jsx(
            "p",
            {
              className: "month",
              style: {
                transform: `translateX(${offset + 2}px)`,
              },
            },
            monthToShow.shortName,
          ),
        );
      }

      offset += 14;
    }
  }

  static $styles = [
    css`
      :host {
        margin-inline: 8px;
        display: block;
      }

      #root {
        margin-top: 4px;
      }

      .cell {
        position: relative;
        height: 12px;
        width: 12px;
        margin: 1px;
        margin-left: 0px;
        margin-right: 2px;
        border-radius: 3px;
        background: var(--bg-elevated);
      }

      #months {
        position: relative;
        margin-bottom: 8px;
        height: 12px;
      }

      .month {
        position: absolute;
        left: 0px;
        bottom: 0px;
        color: var(--text-ter);
        --font-size: var(--small-size);
      }
    `,
    css(/* css */ `
      .cell:hover::after {
        ${Tooltip.mixin}
        left: calc(100% + 8px);
        width: max-content;
        z-index: 1;
      }
    `),
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-row id="months"> </std-row>
      <std-row id="streak-grid"></std-row>
    </div>
  `;
}

export namespace Streaks {
  export type Props = {
    range: GenericRange<NaiveDate>;
    today?: NaiveDate;
    value: (date: NaiveDate) => number;
  };

  export namespace Props {
    /**
     * Creates a range from the beginning of the year to either a few weeks after today or the end of the year.
     * @param startOfWeek Day of week to align the range start (default: Monday)
     * @returns Props with the calculated range
     */
    export function makeYearToDate(
      value: (date: NaiveDate) => number,
      startOfWeek: Weekday = Weekday.MON,
    ): Props {
      const today = NaiveDate.today();
      const startOfYear = naivedate(today.yr, 1, 1);

      // Find the first occurrence of startOfWeek on or before Jan 1
      let rangeStart = startOfYear;
      while (rangeStart.dayOfWeek.dow !== startOfWeek.dow) {
        rangeStart = rangeStart.add({ days: -1 });
      }

      // End date is either end of year or some padding after today
      const endOfYear = naivedate(today.yr, 12, 31);
      const paddedToday = today.add({ days: 28 }); // 4 weeks padding
      const targetEnd = paddedToday.isBefore(endOfYear)
        ? paddedToday
        : endOfYear;

      // Align end to week boundary (end on day before startOfWeek)
      let rangeEnd = targetEnd;
      const endDow = startOfWeek.dow === 1 ? 7 : startOfWeek.dow - 1;
      while (rangeEnd.dayOfWeek.dow !== endDow) {
        rangeEnd = rangeEnd.add({ days: 1 });
      }

      return {
        range: new GenericRange(rangeStart, rangeEnd),
        today,
        value,
      };
    }

    /**
     * Creates a range centered around today with padding weeks before and after.
     * @param value Function to get the value for each date
     * @param weeksBefore Number of weeks to show before today (default: 12)
     * @param weeksAfter Number of weeks to show after today (default: 4)
     * @param startOfWeek Day of week to align the range (default: Monday)
     * @returns Props with the calculated range
     */
    export function makeTodayWithPadding(
      value: (date: NaiveDate) => number,
      weeksBefore: number = 12,
      weeksAfter: number = 4,
      startOfWeek: Weekday = Weekday.MON,
    ): Props {
      const today = NaiveDate.today();

      // Calculate start date aligned to startOfWeek
      let rangeStart = today.add({ wks: -weeksBefore });
      while (rangeStart.dayOfWeek.dow !== startOfWeek.dow) {
        rangeStart = rangeStart.add({ days: -1 });
      }

      // Calculate end date aligned to week boundary (end on day before startOfWeek)
      let rangeEnd = today.add({ wks: weeksAfter });
      const endDow = startOfWeek.dow === 1 ? 7 : startOfWeek.dow - 1;
      while (rangeEnd.dayOfWeek.dow !== endDow) {
        rangeEnd = rangeEnd.add({ days: 1 });
      }

      return {
        range: new GenericRange(rangeStart, rangeEnd),
        today,
        value,
      };
    }
  }
}
