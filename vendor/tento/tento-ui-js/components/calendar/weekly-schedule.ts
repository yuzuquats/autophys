import "./calendar-column-layout";
import "./time-range-label";
import "./calendar-legend";

import {
  DateFragment,
  DateRegion,
  DayOfWeek0,
  Duration,
  NaiveDate,
  TimeOfDay,
  TimePoint,
  TimezoneRegion,
  Weekday,
} from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons, TrashIcon } from "../../ui/icons";
import { IconButton } from "../icon-button";
import { Prompt } from "../prompt";
import { Scrollbars } from "../scrollbars";
import { CalendarColumn } from "./calendar-column";
import { CalendarColumnCell } from "./calendar-column-cell";
import { CalendarColumnLayout } from "./calendar-column-layout";
import { CalendarGesture } from "./calendar-gesture";
import { PIXELS_PER_HOUR } from "./calendar-hour";
import { TimeRangeLabel } from "./time-range-label";
import {
  TimeBlock,
  WeeklyScheduleController,
} from "./weekly-schedule-controller";
import { WeeklyScheduleGestures } from "./weekly-schedule-gestures";

@component({
  name: "std-weekly-schedule",
})
export class WeeklySchedule extends LonaWebComponent {
  readonly controller: WeeklyScheduleController =
    new WeeklyScheduleController();
  private gestureManager: CalendarGesture.Manager<WeeklyScheduleGestures.DayInfo> =
    new CalendarGesture.Manager<WeeklyScheduleGestures.DayInfo>()
      .addGesture(
        new WeeklyScheduleGestures.DragToCreateGesture(this.controller),
      )
      .addGesture(new WeeklyScheduleGestures.MoveGesture(this.controller))
      .addGesture(new WeeklyScheduleGestures.ResizeGesture(this.controller));

  // @components
  private $container = this.$("columns-container");
  private $legend = this.hydrate("legend");
  private $columns: {
    dow0: DayOfWeek0;
    $column: CalendarColumnLayout;
    $ghost: CalendarColumnCell<TimeRangeLabel>;
  }[] = [];

  // @state
  private renderedBlocks: Map<string, CalendarColumnCell<HTMLElement>> =
    new Map();

  constructor() {
    super();

    {
      for (let i = 0; i < 7; i++) {
        const dayIndex = i;

        const $column = CalendarColumnLayout.make();
        $column.setAttribute("day-index", String(i));
        WeeklySchedule.setColumnCallbacks(
          $column,
          this.gestureManager.asColumnDelegate({
            dayIndex,
            toString: () => `Day ${dayIndex}`,
            windowed: WeeklySchedule.stubWindowed(),
          }),
        );
        this.$container.appendChild($column);

        const $ghost =
          CalendarColumnCell.make() as CalendarColumnCell<TimeRangeLabel>;
        $ghost.assignStyles({
          pointerEvents: "none",
          zIndex: String(999),
          boxShadow: "var(--box-shadow)",
          "--std-calendar-cell-x-offset": "8px",
          display: "none",
        });

        const $ghostLabel = TimeRangeLabel.make();
        $ghostLabel.slot = "content";
        $ghost.appendChild($ghostLabel);
        $column.appendChild($ghost);

        this.$columns.push({
          dow0: i as DayOfWeek0,
          $column,
          $ghost,
        });

        this.$("days").appendChild($column);
      }

      this.$("legend").style.height = PIXELS_PER_HOUR * 24 + "px";
    }

    this.controller.state.addListener(this, (state) => {
      this.renderTimeBlocks(state.timeBlocks, state.activeBlockId);
      this.renderGhostBlock(state.ghostBlock);
    });
  }

  disconnectedCallback() {
    this.controller.state.removeListener(this);
  }

  setScrollTop(st: number) {
    this.$("columns-container").scrollTop = st;
  }

  private static DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  setStartOfWeek(startOfWeek: Weekday): void {
    const startDow = startOfWeek.dow;
    const $header = this.$("header");
    DomUtils.clearChildren($header);
    for (let i = 0; i < 7; i++) {
      const dayDow = (startDow + i) % 7;
      const $label = document.createElement("std-center");
      $label.className = "day-header";
      $label.textContent = WeeklySchedule.DAY_LABELS[dayDow];
      $header.appendChild($label);
    }
    // Remap column dow0 values
    for (let i = 0; i < 7; i++) {
      this.$columns[i].dow0 = ((startDow + i) % 7) as DayOfWeek0;
    }
  }

  private renderTimeBlocks(tbs: TimeBlock[], activeBlockId: Option<string>) {
    for (const [_id, $cell] of this.renderedBlocks) {
      DomUtils.removeFromDom($cell);
    }
    this.renderedBlocks.clear();

    for (const tb of tbs) {
      const $column = this.$columns[tb.dayIndex]!;
      const $cell = WeeklySchedule.makeTimeBlock(
        tb,
        tb.id === activeBlockId,
        () => this.controller.deleteTimeBlock(tb.id),
      );
      this.renderedBlocks.set(tb.id, $cell);
      const cellCallbacks = this.gestureManager.asCellDelegate({
        dayIndex: tb.dayIndex,
        timeBlock: tb,
        toString: () => `Day ${tb.dayIndex}`,
        windowed: WeeklySchedule.stubWindowed(),
      });
      $cell.bindCallbacks(cellCallbacks, "schedule");
      $column.$column.appendChild($cell);
    }
  }

  private renderGhostBlock(
    ghostBlock?: Option<{
      startDayIndex: number;
      startTime: Duration.Time;
      endDayIndex: number;
      endTime: Duration.Time;
    }>,
  ) {
    // Hide all ghost blocks first
    for (const [_idx, $c] of this.$columns.entries()) {
      $c.$ghost.style.display = "none";
    }

    if (!ghostBlock) return;

    // For now, only handle single-day ghost blocks (can expand to multi-day later)
    if (ghostBlock.startDayIndex !== ghostBlock.endDayIndex) return;

    const $c = this.$columns[ghostBlock.startDayIndex]!;
    const startTimePoint = TimePoint.ms(ghostBlock.startTime.toMs);
    const endTimePoint = TimePoint.ms(ghostBlock.endTime.toMs);
    const timeRange = new TimePoint.Range(startTimePoint, endTimePoint);

    $c.$ghost.bind({
      id: `ghost-block-${$c.dow0}`,
      time: timeRange,
      background: "var(--blue)",
      // background: "var(--red)",
    });
    $c.$ghost.$content().bind({
      startTime: ghostBlock.startTime,
      endTime: ghostBlock.endTime,
    });
    $c.$ghost.style.display = "block";
  }

  static $containerStyle = css`
    .weekly-schedule-container {
      flex: 1;
      min-height: 0;
      background: var(--bg);
      border: 1px solid var(--divider);
      border-radius: 8px;
      overflow: hidden;
      margin: 24px;
      margin-top: 0px;
    }
  `;
  static $styles = [
    CalendarColumnLayout.$lines,
    Scrollbars.$hideScrollbars,
    css(`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        --std-calendar-column-layout-width: ${PIXELS_PER_HOUR}px;
        --std-calendar-column-layout-transition: none;
        --std-calendar-column-layout-horizontal-color: var(--divider, rgba(0, 0, 0, 0.12));
      }

      #root {
        width: 100%;
        height: 100%;
      }

      #header {
        height: 40px;
        border-bottom: 1px solid var(--divider);
        background: var(--bg);
				padding-left: 80px;
      }

			#days {
				flex-grow: 1;
				margin-left: 16px;
			}

			#legend {
				width: 64px;
				min-width: 64px;
			}

      .day-header {
        flex: 1;
        font-size: var(--text-12px);
        color: var(--text-sec);
        text-transform: uppercase;
        // background: red;
        // border-radius: 8px;
      }

      #columns-container {
        flex: 1;
        overflow-y: scroll;
      }

      std-calendar-column-layout {
        flex: 1;
        height: calc(${PIXELS_PER_HOUR}px * 24 - 1px);
        position: relative;
        margin-top: -1px;
      }

      std-calendar-column-layout:not(:last-child)::before {
        content: "";
        position: absolute;
        right: -0.5px;
        top: 0px;
        width: 1px;
        height: 100%;
        background: var(--divider);
      }

      std-calendar-column-layout:last-child {
        border-right: none;
      }

      std-calendar-column-cell {
        z-index: 1;
      }
    `),
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-row id="header">
        <std-center class="day-header">Sun</std-center>
        <std-center class="day-header">Mon</std-center>
        <std-center class="day-header">Tue</std-center>
        <std-center class="day-header">Wed</std-center>
        <std-center class="day-header">Thu</std-center>
        <std-center class="day-header">Fri</std-center>
        <std-center class="day-header">Sat</std-center>
      </std-row>
      <std-row id="columns-container">
				<std-calendar-legend id=legend start-hrs=00:00></std-calendar-legend>
				<std-row id=days></std-row>
			</std-row>
    </std-col>
  `;
}

export namespace WeeklySchedule {
  export function makeTimeBlock(
    block: TimeBlock,
    isActive: boolean,
    onDelete: () => void,
  ): CalendarColumnCell<HTMLElement> {
    const startTimePoint = TimePoint.ms(block.startTime.toMs);
    const endTimePoint = TimePoint.ms(block.endTime.toMs);
    const timeRange = new TimePoint.Range(startTimePoint, endTimePoint);

    const $label = TimeRangeLabel.makeWith({
      startTime: block.startTime,
      endTime: block.endTime,
    });

    const $deleteBtn = IconButton.makeWith({
      content: LonaIcons.$svg(TrashIcon),
      sizePx: 20,
    });
    $deleteBtn.assignStyles({
      position: "absolute",
      bottom: "4px",
      right: "4px",
      "--std-icon-button-color": "var(--text-sec-inv)",
    });
    GESTURE_MANAGER.addPointerEvent($deleteBtn, {
      onClick: async () => {
        const result = await Prompt.Alert.show(
          Prompt.Props.makeDelete("Are you sure you want to delete me?"),
        );
        if (result.didComplete()) {
          onDelete();
        }
      },
    });

    const $content = Column.make();
    $content.style.position = "relative";
    $content.style.height = "100%";
    $content.style.width = "100%";
    $content.appendChild($label);
    $content.appendChild($deleteBtn);

    const $cell = CalendarColumnCell.makeWith({
      id: block.id,
      time: timeRange,
      content: $content,
      background: block.color || "var(--blue)",
    });
    $cell.toggleAttribute("editable", true);
    $cell.assignStyles({
      "--std-calendar-cell-x-offset": "2px",
      opacity: isActive ? "0.3" : "1",
    });
    return $cell;
  }

  export function setColumnCallbacks(
    $column: CalendarColumnLayout,
    callbacks: CalendarColumn.Callbacks,
  ) {
    GESTURE_MANAGER.addPointerEvent($column, {
      onPointerDown: (offset) => {
        callbacks.onPointerDown({
          position: new CalendarColumnCell.PointerPosition({
            x: 0,
            y: offset.y,
          }),
        });
      },
      onClick: (_, offset) => {
        callbacks.onPointerUpColumn({
          position: new CalendarColumnCell.PointerPosition({
            x: 0,
            y: offset.y,
          }),
        });
      },
      onContextMenu: (_, offset) => {
        callbacks.onContextMenu({
          position: new CalendarColumnCell.PointerPosition({
            x: 0,
            y: offset.y,
          }),
          offset: offset,
        });
      },
    });

    $column.onpointermove = (e) => {
      e.stopPropagation();
      const { shouldCapturePointer } = callbacks.onPointerMove({
        position: new CalendarColumnCell.PointerPosition({
          x: 0,
          y: e.offsetY,
        }),
      });
      if (shouldCapturePointer) {
        $column.setPointerCapture(e.pointerId);
      } else {
        $column.releasePointerCapture(e.pointerId);
      }
    };
  }

  export function stubWindowed(): DateFragment.Windowed {
    const stubDate = NaiveDate.today();
    const stubTz = TimezoneRegion.UTC;
    const dateRegion = new DateRegion(stubDate, stubTz);
    const [stubFragment] = dateRegion.dateFragments();
    return new DateFragment.Windowed(
      stubFragment,
      { start: null, end: null },
      new TimeOfDay.Range(TimeOfDay.ZERO, TimeOfDay.ZERO, false),
    );
  }
}
