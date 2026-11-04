import { DateTime, NaiveDate, NaiveTime } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";

function formatDate(
  d: NaiveDate,
  dateFormat: "month-day" | "day-month" = "month-day",
): string {
  return NaiveDate.Formatter.render(d, { dateFormat, includeWeekday: true });
}

function renderTime(
  t: NaiveTime,
  includeAmPm: boolean,
  use24Hour: boolean = false,
): string {
  return NaiveTime.Formatter.render(t, {
    includeAmPm: use24Hour ? false : includeAmPm,
    use24Hour,
    padHours: false,
    includeSeconds: false,
  });
}

@component({
  name: "std-event-details-time-label",
})
export class EventDetailsTimeLabel extends LonaWebComponent {
  #time: Option<DateTime.Range>;
  #isAllDay: boolean = false;
  #use24Hour: boolean = false;
  #dateFormat: "month-day" | "day-month" = "month-day";
  onUpdateTime: (timeRange: DateTime.Range) => void = Constants.EMPTY_FUNCTION;

  get time(): Option<DateTime.Range> {
    return this.#time;
  }

  get isAllDay(): boolean {
    return this.#isAllDay;
  }

  bind(
    r: DateTime.Range,
    isAllDay: boolean = false,
    use24Hour: boolean = false,
    dateFormat: "month-day" | "day-month" = "month-day",
  ) {
    this.#time = r;
    this.#isAllDay = isAllDay;
    this.#use24Hour = use24Hour;
    this.#dateFormat = dateFormat;
    const start = r.start;
    const end = r.end;
    const displayStartDate = start.date;
    let displayEndDate = isAllDay ? end.date.addDays(-1) : end.date;
    if (displayEndDate.dse < displayStartDate.dse) {
      displayEndDate = displayStartDate;
    }

    const isSameDay = displayStartDate.equals(displayEndDate);
    const dstShift = start.tz.info.offset.sub(end.tz.info.offset);
    const startDateStr = formatDate(displayStartDate, this.#dateFormat);

    if (isSameDay) {
      // "Monday, March 10 ⋅ 9 AM – 5 PM"  or  "Monday, March 10"
      this.$("date").textContent = startDateStr;
      this.$("dot").style.display = isAllDay ? "none" : "";
      this.$("time-section").style.display = isAllDay ? "none" : "";
      this.$("end-line").style.display = "none";

      if (!isAllDay) {
        this.$("start-hour").textContent = renderTime(
          start.time,
          start.time.meridiem !== end.time.meridiem,
          this.#use24Hour,
        );
        this.$("end-hour").textContent = renderTime(
          end.time,
          true,
          this.#use24Hour,
        );
        this.$("tz-shift").textContent =
          dstShift.toMs === 0 ? "" : dstShift.toString() + " hrs";
      }
    } else if (isAllDay) {
      // "Monday, March 10 – Wednesday, March 12"
      this.$("date").textContent =
        startDateStr + " – " + formatDate(displayEndDate, this.#dateFormat);
      this.$("dot").style.display = "none";
      this.$("time-section").style.display = "none";
      this.$("end-line").style.display = "none";
    } else {
      // Multi-day timed:
      // line 1: "Monday, March 10, 9 AM –"
      // line 2: "Wednesday, March 12, 5 PM"
      const startTimeStr = renderTime(start.time, true, this.#use24Hour);
      const endTimeStr = renderTime(end.time, true, this.#use24Hour);
      const tzSuffix =
        dstShift.toMs === 0 ? "" : " " + dstShift.toString() + " hrs";

      this.$("date").textContent = startDateStr + ", " + startTimeStr + " –";
      this.$("dot").style.display = "none";
      this.$("time-section").style.display = "none";
      this.$("end-line").style.display = "";
      this.$("end-line").textContent =
        formatDate(displayEndDate, this.#dateFormat) +
        ", " +
        endTimeStr +
        tzSuffix;
    }
  }

  static $styles = [
    css`
      :host {
        position: relative;
        margin: -6px;
        padding: 6px;
      }

      :host([editable]) {
        cursor: pointer;
      }

      :host([editable]:hover)::before {
        position: absolute;
        content: "";
        background: var(--bg-hover);
        inset: 0;
        border-radius: 4px;
      }

      #event-time {
        display: flex;
        flex-wrap: wrap;
        column-gap: 4px;
        row-gap: 4px;
        font-weight: 300;
        color: var(--text-ter);
      }

      #tz-shift {
        font-size: 0.625rem;
        margin-left: 4px;
      }
    `,
  ];

  static $html = html`
    <p id="event-time" class=small>
      <span id="date" class="inline-editable"></span>
      <span id="dot"> ⋅ </span>
      <span id="time-section">
        <span id="start-hour" class="inline-editable"></span>
        <span style="padding: 0px 2px;">–</span>
        <span id="end-hour" class="inline-editable"></span>
        <span id=tz-shift></span>
      </span>
      <span id="end-line"></span>
    </p>
  `;
}
