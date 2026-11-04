import { NaiveDate, Weekday, YearMonth } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { Div } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$, mutate } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ArrowDownIcon, LonaIcons } from "../../ui/icons";
import { Button } from "../button/button";
import { Tooltip } from "../tooltip/tooltip";

@component({
  name: "std-date-picker",
})
export class DatePicker extends LonaWebComponent {
  onSelectedDate?: ((date: NaiveDate) => Option<boolean>) | undefined;
  startWeekOnMonday?: boolean;

  private monthToRender: Option<YearMonth>;
  private selectedDate: Option<NaiveDate>;
  private today: Option<NaiveDate>;
  private viewportRange: Option<NaiveDate.Range>;
  private availableDates: ReadonlySet<string> = new Set();
  private lastViewportKey: Option<string>;
  private cellDates: Option<NaiveDate>[] = [];
  private monthSnapTimer: Option<number>;

  private $container = this.hydrate("container");
  private $prevMonth = this.hydrate("prev-month");
  private $nextMonth = this.hydrate("next-month");
  private $todayButton = this.hydrate("today-button");

  static makeWith(props: {
    startWeekOnMonday?: boolean;
    onSelectedDate?: (date: NaiveDate) => Option<boolean>;
    size?: "default" | "large";
  }): DatePicker {
    const picker = DatePicker.make();
    picker.startWeekOnMonday = props.startWeekOnMonday ?? false;
    picker.onSelectedDate = props.onSelectedDate;
    if (props.size) {
      picker.setAttribute("size", props.size);
    }
    return picker;
  }

  constructor() {
    super();
    for (let i = 0; i < 56; ++i) {
      const $child = Div.make();
      this.$container.appendChild($child);
    }

    GESTURE_MANAGER.addPointerEvent(this.$prevMonth, {
      onClick: () => {
        if (!this.monthToRender || !this.today) return;
        this.bind(this.selectedDate, this.today, this.monthToRender.pred());
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$nextMonth, {
      onClick: () => {
        if (!this.monthToRender || !this.today) return;
        this.bind(this.selectedDate, this.today, this.monthToRender.succ());
      },
    });
  }

  bindToDate(date: NaiveDate, today: NaiveDate) {
    this.bind(date, today);
  }

  bindToToday(today: NaiveDate) {
    // If viewport is set and contains today, prefer showing today
    // Otherwise, show viewport start
    if (this.viewportRange) {
      const range = this.viewportRange;
      if (range.contains(today)) {
        this.bind(today, today, new YearMonth(today));
      } else {
        this.bind(this.selectedDate, today, new YearMonth(range.start));
      }
    } else {
      // Original behavior
      this.bind(today, today);
    }
  }

  setStartWeekOnMonday(startOnMonday: boolean): void {
    this.startWeekOnMonday = startOnMonday;
    // Re-render if we have a current month
    if (this.monthToRender && this.today) {
      this.bind(this.selectedDate, this.today, this.monthToRender);
    }
  }

  // Marks the given days (keyed by `NaiveDate.toString()`) with a persistent
  // blue-dimmed fill — e.g. days that have available booking times. Re-applied
  // across month navigation, so pass the full set spanning the window.
  setAvailableDates(dates: ReadonlySet<string>): void {
    this.availableDates = dates;
    if (this.monthToRender && this.today) {
      this.bind(this.selectedDate, this.today, this.monthToRender);
    }
  }

  updateViewport(
    range: NaiveDate.Range,
    navigateToRange: boolean = true,
  ): void {
    // The sheet emits a viewport per frame during a continuous scroll, and the
    // range is freshly allocated each time — key on its days to skip the
    // no-op refreshes entirely.
    const key = `${range.start.dse}..${range.end.dse}|${navigateToRange}`;
    if (key === this.lastViewportKey) return;
    this.lastViewportKey = key;
    this.viewportRange = range;

    if (navigateToRange) {
      if (this.rangeOverlapsRenderedMonth(range)) {
        this.refreshCalendarDisplay();
      } else {
        // Month snap deferred behind a short settle timer: mid-scroll, a full
        // month re-bind per crossed month is the single biggest invalidation
        // source the picker produces, and the month only needs to be right
        // once the scroll comes to rest.
        this.monthSnapTimer != null && clearTimeout(this.monthSnapTimer);
        this.monthSnapTimer = setTimeout(() => {
          this.monthSnapTimer = null;
          const settled = this.viewportRange;
          if (settled == null || !this.isConnected) return;
          if (this.rangeOverlapsRenderedMonth(settled)) return;
          const todayToUse = this.today || NaiveDate.today();
          this.bind(this.selectedDate, todayToUse, new YearMonth(settled.start));
        }, DatePicker.MONTH_SNAP_SETTLE_MS);
        this.refreshCalendarDisplay();
      }
    } else {
      this.refreshCalendarDisplay();
    }
  }

  private static readonly MONTH_SNAP_SETTLE_MS = 150;

  // Smart navigation: only change month if the rendered month doesn't contain
  // any part of the range (range.start < monthEnd && range.end > monthStart).
  private rangeOverlapsRenderedMonth(range: NaiveDate.Range): boolean {
    const currentMonth =
      this.monthToRender || new YearMonth(this.today || NaiveDate.today());
    const monthStart = currentMonth.date();
    const monthEnd = monthStart.add({ mths: 1 }).add({ days: -1 });
    return (
      !range.end.isBefore(monthStart.add({ days: 1 })) &&
      !monthEnd.isBefore(range.start)
    );
  }

  @mutate
  private refreshCalendarDisplay(): void {
    $$.assertFlushType("writes");

    const $children = this.$container.children;
    const ctx = this.rangeContext();

    // Start from index 8 to skip weekday headers and week numbers in first row
    for (let i = 8; i < 56; ++i) {
      if (i % 8 === 0) continue; // Skip week number cells

      const $child = $children[i] as HTMLElement;
      // bind() caches each cell's date; the attribute parse is only the
      // fallback for a refresh racing ahead of the first bind.
      let date = this.cellDates[i];
      if (date == null) {
        const dateAttr = $child.getAttribute("data-date");
        if (!dateAttr) continue;
        date = NaiveDate.parse(dateAttr);
      }
      this.updateRangeAttributes($child, date, ctx);
    }
  }

  // Everything loop-invariant about the highlight computation, hoisted so the
  // per-cell work is comparisons only (no allocations).
  private rangeContext(): Option<{
    range: NaiveDate.Range;
    endInclusive: NaiveDate;
    rowStartDay: Weekday;
    rowEndDay: Weekday;
  }> {
    const range = this.viewportRange;
    if (range == null) return null;
    return {
      range,
      endInclusive: range.end.add({ days: -1 }), // Exclusive end
      rowStartDay: this.startWeekOnMonday ? Weekday.MON : Weekday.SUN,
      rowEndDay: this.startWeekOnMonday ? Weekday.SUN : Weekday.SAT,
    };
  }

  private updateRangeAttributes(
    $child: HTMLElement,
    date: NaiveDate,
    ctx: ReturnType<DatePicker["rangeContext"]>,
  ): void {
    if (ctx == null) {
      $child.classList.remove("is-within-range");
      $child.removeAttribute("first-within-row-range");
      $child.removeAttribute("last-within-row-range");
      return;
    }

    const isInRange = ctx.range.contains(date);
    const isRowStart =
      isInRange &&
      (ctx.range.start.equals(date) || date.dayOfWeek === ctx.rowStartDay);
    const isRowEnd =
      isInRange &&
      (ctx.endInclusive.equals(date) || date.dayOfWeek === ctx.rowEndDay);

    $child.classList.toggle("is-within-range", isInRange);
    $child.toggleAttribute("first-within-row-range", isRowStart);
    $child.toggleAttribute("last-within-row-range", isRowEnd);
  }

  @mutate
  private bind(
    selectedDate: Option<NaiveDate>,
    today: NaiveDate,
    monthToRender: Option<YearMonth> = null,
  ) {
    $$.assertFlushType("writes");

    this.today = today;
    this.selectedDate = selectedDate;

    if (monthToRender != null) {
      this.monthToRender = monthToRender;
    } else if (selectedDate != null) {
      this.monthToRender = new YearMonth(selectedDate);
    } else {
      this.monthToRender = new YearMonth(today);
    }
    const monthStart = this.monthToRender.date();

    GESTURE_MANAGER.addPointerEvent(this.$todayButton, {
      onClick: () => {
        const maybeValid = this.onSelectedDate?.(today);
        if (maybeValid == null || maybeValid) {
          this.bind(today, today);
        }
      },
    });

    this.$("month-title").textContent = monthStart.month.name;
    this.$("year-title").textContent = String(monthStart.yr);

    const $children = this.$container.children;
    const rangeCtx = this.rangeContext();
    let currentMonth = monthStart;
    let currentDate: NaiveDate = this.startWeekOnMonday
      ? monthStart.mthStart().toStartOfWeekMon()
      : monthStart.mthStart().toStartOfWeekSun();

    // Render weekday headers
    for (let i = 1; i < 56; ++i) {
      const $child = $children[i] as HTMLElement;
      $child.onpointerup = null;
      if (i < 8) {
        // Calculate correct weekday index based on start day preference
        const headerIndex = i - 1; // 0-6
        const weekdayIndex = this.startWeekOnMonday
          ? (headerIndex + 1) % 7 // Mon=0, Tue=1, ..., Sun=6
          : headerIndex; // Sun=0, Mon=1, ..., Sat=6
        $child.textContent = Weekday.DOW1[weekdayIndex].initialCaps;
        $child.style.color = "var(--text-ter)";
        continue;
      }
      if (i % 8 === 0) {
        const wno = String(currentDate.isoWno);
        $child.textContent = wno;
        $child.classList.add("week-number");
        $child.setAttribute("tooltip", `Week ${wno}`);
        continue;
      }
      const isToday = today.equals(currentDate);
      $child.style.color = isToday
        ? "var(--text-pri)"
        : currentMonth.month === currentDate.month
          ? "var(--color)"
          : "var(--text-ter)";
      $child.classList.add("day");
      $child.toggleAttribute("selected", selectedDate?.equals(currentDate));
      $child.toggleAttribute("today", isToday);
      const $label = document.createElement("span");
      $label.className = "day-label";
      $label.textContent = String(currentDate.day1);
      const $todayDot = document.createElement("span");
      $todayDot.className = "today-dot";
      $child.replaceChildren($label, $todayDot);

      const date = currentDate;
      GESTURE_MANAGER.addPointerEvent($child, {
        onClick: () => {
          const maybeValid = this.onSelectedDate?.(date);
          if (maybeValid == null || maybeValid) {
            this.bind(date, today);
          }
        },
      });

      // Store date for range highlighting
      $child.setAttribute("data-date", currentDate.toString());
      this.cellDates[i] = currentDate;

      $child.toggleAttribute(
        "available",
        this.availableDates.has(currentDate.toString()),
      );
      this.updateRangeAttributes($child, currentDate, rangeCtx);

      currentDate = currentDate.add({ days: 1 });
    }
  }

  static $icons: Option<string[]> = [LonaIcons.symbol(ArrowDownIcon)];
  static $styles = [
    Button.$style,
    css`
      :host {
        box-sizing: content-box;
        user-select: none;
        width: 236px;
        display: flex;
        flex-direction: column;
        align-items: stretch;
      }
      :host([size="large"]) {
        width: 354px;
      }
      #title {
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex-grow: 1;
        align-self: center;
        justify-self: center;
      }
      #year-title {
        font-weight: 300;
        color: var(--text-ter);
      }
      #container {
        position: relative;
        flex-grow: 1;
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        grid-column-gap: 0px;
        font-size: 10px;
        margin-top: 12px;
        height: 192.5px;
      }
      :host([size="large"]) #container {
        font-size: 14px;
        height: 288px;
      }
      #container::before {
        position: absolute;
        content: "";
        background-color: var(--bg-selected);
        top: calc(100% / 7);
        bottom: 0px;
        left: 2px;
        width: calc(100% / 7 - 8px);
        z-index: -1;
        border-radius: 4px;
      }
      #container div {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .nav-button {
        padding: 4px;
        border-radius: 4px;
      }
      :host([size="large"]) .nav-button {
        padding: 8px;
      }
      :host([size="large"]) .nav-button svg {
        height: 16px;
        width: 16px;
      }
      #today-button {
        padding: 4px 10px;
        font-size: 0.75rem;
        background-color: var(--bg-surface-light);
        margin-right: 4px;
        border-radius: 6px;
      }
      :host([size="large"]) #today-button {
        padding: 4px 10px;
        border-radius: 8px;
      }
      .nav-button:hover,
      #today-button:hover {
        background-color: var(--bg-hover, rgba(0, 0, 0, 0.12));
      }
    `,
    css`
      .day {
        cursor: pointer;
        border-radius: 50%;
        position: relative;
      }
      /* Range underlay - lowest z-index */
      .is-within-range::before {
        position: absolute;
        content: "";
        background: var(--black6);
        top: 1px;
        right: 0px;
        bottom: 1px;
        left: 0px;
        border-radius: 0px;
        pointer-events: none;
        user-select: none;
        z-index: -2;
      }
      [first-within-row-range]::before {
        border-top-left-radius: 6px;
        border-bottom-left-radius: 6px;
      }
      [last-within-row-range]::before {
        border-top-right-radius: 6px;
        border-bottom-right-radius: 6px;
      }
      :host([size="large"]) [first-within-row-range]::before {
        border-top-left-radius: 12px;
        border-bottom-left-radius: 12px;
      }
      :host([size="large"]) [last-within-row-range]::before {
        border-top-right-radius: 12px;
        border-bottom-right-radius: 12px;
      }
      /* Available / hover / selected overlays - higher z-index */
      .day[available]::after,
      .day:hover::after,
      .day[selected]::after {
        position: absolute;
        content: "";
        background-color: var(--blue-dimmed);
        inset: 1px;
        border-radius: 6px;
        z-index: -1;
      }
      :host([size="large"]) .day[available]::after,
      :host([size="large"]) .day:hover::after,
      :host([size="large"]) .day[selected]::after {
        border-radius: 12px;
      }
      .day[selected]::after {
        background-color: var(--blue);
      }
      .day-label {
        position: relative;
        z-index: 0;
      }
      .today-dot {
        display: none;
        position: absolute;
        left: 50%;
        bottom: 5px;
        width: 3px;
        height: 3px;
        border-radius: 999px;
        background: var(--blue);
        transform: translateX(-50%);
        z-index: 0;
      }
      :host([size="large"]) .today-dot {
        bottom: 7px;
        width: 4px;
        height: 4px;
      }
      .day[today] .today-dot {
        display: block;
      }
      .day[selected][today] .today-dot {
        background: var(--bg);
      }
    `,
    css(/* css */ `
      .week-number {
        position: relative;
        cursor: pointer;
      }
      .week-number:hover::after {
        ${Tooltip.mixin}
        left: calc(100% + 8px);
        width: max-content;
        z-index: 1;
      }
    `),
  ];

  static $html = html`
    <std-row style="flex-direction:row-reverse;margin-top:0px;">
      <button class="nav-button" id="next-month">
        <svg
          height="12"
          width="12"
          style="transform:rotate(270deg);">
          <use href="#arrow-down" />
        </svg>
      </button>
      <div style="width:2px;"></div>
      <button class="nav-button" id="prev-month">
        <svg
          height="12"
          width="12"
          style="transform:rotate(90deg)">
          <use href="#arrow-down" />
        </svg>
      </button>
      <div style="flex-grow:1;"></div>
      <button id="today-button">Today</button>
    </std-row>

    <std-col style="margin-block:8px;">
      <h1 class="h6" id="title">
        <span id="month-title"></span>
        <span id="year-title"></span>
      </h1>
    </std-col>

    <div id="container"></div>
  `;
}
