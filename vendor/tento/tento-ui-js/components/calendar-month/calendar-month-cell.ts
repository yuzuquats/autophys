import { Month, NaiveDate } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LazySync } from "../../lazy";
import { Point } from "@tento-core/point";
import { EntryList } from "../entry-list/entry-list";
import { Round } from "../round";

@component({
  name: "std-calendar-month-cell",
})
export class CalendarMonthCell extends LonaWebComponent {
  date: Option<NaiveDate>;
  isCurrentMonth: boolean = false;
  isToday: boolean = false;
  private $dayNumberRow: HTMLElement = this.$("day-number-row");

  get dayNumberRowHeight(): number {
    return this.$dayNumberRow.offsetHeight;
  }

  $squircleBg: LazySync<Round> = new LazySync(() => {
    const $squircle = Round.makeWith({
      radius: 6,
      bg: "var(--blue)",
    });
    // $squircle.setAttribute("no-transition", "");
    $squircle.id = "day-squircle";
    this.$("day-number-container").appendChild($squircle);
    return $squircle;
  });

  static makeWithEvents(e: EntryList.Props): CalendarMonthCell {
    const $c = CalendarMonthCell.make();
    const $e = EntryList.make().bind(e);
    $c.appendChild($e);
    return $c;
  }

  bindDate(date: NaiveDate, today: Option<NaiveDate>): this {
    this.date = date;
    this.isToday = today ? date.equals(today) : false;
    this.updateStyles();
    this.setAttribute("date", date.toString());
    this.toggleAttribute("is-today", this.isToday);

    if (this.isToday) {
      this.$squircleBg.get().style.opacity = "";
      // this.$squircleBg.get().style.display = "block";
    } else {
      this.$squircleBg.maybeGet()?.style.setProperty("opacity", "0");
      // this.$squircleBg.maybeGet()?.style.setProperty("display", "none");
    }
    this.style.setProperty(
      "--day-number-color",
      this.isToday ? "var(--text-pri-inv)" : "var(--text-pri)",
    );
    if (this.date.day1 === 1) {
      this.$("day-number").textContent =
        `${Month.MONTHS_OF_YEAR_SHORT[this.date.month0]} 1`;
    } else {
      this.$("day-number").textContent = String(this.date.day1);
    }
    return this;
  }

  bindCurrentMonth(isCurrentMonth: boolean): this {
    this.isCurrentMonth = isCurrentMonth;
    this.updateStyles();
    return this;
  }

  setCallbacks(callbacks: CalendarMonthCell.Callbacks): this {
    GESTURE_MANAGER.addPointerEvent(this, {
      onPointerDown: (offset) => {
        callbacks.onPointerDown({ date: this.date!, offset });
      },
      onClick: () => {
        callbacks.onPointerUp({ date: this.date! });
      },
      onContextMenu: (_, offset) => {
        callbacks.onContextMenu({ date: this.date!, offset });
      },
    });

    this.onpointermove = (e) => {
      // Use clientX/clientY with getBoundingClientRect for consistent offset
      // regardless of which child element the pointer is over
      const rect = this.getBoundingClientRect();
      const offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const { shouldCapturePointer } = callbacks.onPointerMove({
        date: this.date!,
        offset,
      });
      if (shouldCapturePointer) {
        this.setPointerCapture(e.pointerId);
      } else {
        this.releasePointerCapture(e.pointerId);
      }
    };

    this.onpointerenter = () => {
      callbacks.onPointerEnter({ date: this.date! });
    };

    this.onpointerleave = () => {
      callbacks.onPointerLeave({ date: this.date! });
    };

    return this;
  }

  private updateStyles(): void {
    this.classList.toggle("current-month", this.isCurrentMonth);
    this.classList.toggle("other-month", !this.isCurrentMonth);
  }

  static $styles = [
    css`
      :host {
        display: block;
        overflow: hidden;
        position: relative;
        background: var(--bg);
        --day-number-color: var(--text-pri);
        --entry-row-padding: 6px 8px;
        user-select: none;
      }

      :host(.other-month) {
        opacity: 0.5;
        background: var(--bg-hover);
      }

      #day-number {
        color: var(--day-number-color);
      }

      #day-number-row {
        justify-content: flex-end;
        align-items: flex-start;
        padding: 8px;
        padding-bottom: 4px;
      }

      #content-wrapper {
        transform: translateY(var(--content-margin-top, 0px));
        will-change: transform;
      }

      #day-number-container {
        position: relative;
        min-width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #day-squircle {
        position: absolute;
        top: 0;
        left: 0;
        min-width: 100%;
        height: 100%;
        z-index: 0;
      }

      #day-number {
        z-index: 1;
      }
    `,
  ];

  static $html = html`
    <std-col>
      <std-row id=day-number-row>
        <std-center id=day-number-container>
          <p id=day-number class=small></p>
        </std-center>
      </std-row>
      <div id=content-wrapper>
        <slot></slot>
      </div>
    </std-col>
  `;
}

export namespace CalendarMonthCell {
  export type Callbacks = {
    onPointerDown: (event: { date: NaiveDate; offset: Point }) => void;
    onPointerUp: (event: { date: NaiveDate }) => void;
    onContextMenu: (event: { date: NaiveDate; offset: Point }) => void;
    onPointerMove: (event: {
      date: NaiveDate;
      offset: Point;
    }) => { shouldCapturePointer: boolean };
    onPointerEnter: (event: { date: NaiveDate }) => void;
    onPointerLeave: (event: { date: NaiveDate }) => void;
  };
}
