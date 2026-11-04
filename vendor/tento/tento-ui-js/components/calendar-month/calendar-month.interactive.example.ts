import {
  DateTime,
  DateTimeRegion,
  NaiveDate,
  TimezoneRegion,
  Tzname,
  Weekday,
} from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { Storybook } from "../../ui/storybook";
import { CalendarMonth } from "./calendar-month";
import { TimezoneConfirmationModal } from "./timezone-confirmation-modal";
import { CalendarMonthExistingGestures } from "./calendar-month-existing-gestures";
import { CalendarMonthGesture } from "./calendar-month-gesture";
import { CalendarMonthNewGestures } from "./calendar-month-new-gestures";
import { CalendarMonthSpan } from "./calendar-month-span";
import { CreateEventPopover } from "./create-event-popover";
import { createEventGhostSpan } from "./event-ghost-span";
import { EntryList } from "../entry-list/entry-list";
import { EntryDisplay, ListItem } from "../entry-list/list-item";
import { Toast } from "../toast/toast";

/**
 * Interactive calendar month component demonstrating:
 * - Span drag-to-move
 * - Event list row drag-to-move with timezone confirmation
 * - Click-to-create new events
 * - Dismiss create on click elsewhere
 */
@component({ name: "std-calendar-month-interactive" })
export class CalendarMonthInteractive extends LonaWebComponent {
  private $calendar: CalendarMonth = this.hydrate("calendar");

  private exampleTime = DateTime.utc.now();
  private timezone = TimezoneRegion.UTC;
  private today = NaiveDate.today();
  private firstOfMonth = NaiveDate.fromYmd1(
    this.today.yr,
    this.today.mth,
    1,
  ).exp();

  // Mutable span data
  private spanData: CalendarMonthInteractive.SpanData[] = [
    {
      start: this.firstOfMonth.addDays(2),
      end: this.firstOfMonth.addDays(4),
      isEditable: true,
      color: "var(--green)",
      label: "Drag me (editable)",
    },
    {
      start: this.firstOfMonth.addDays(10),
      end: this.firstOfMonth.addDays(12),
      isEditable: false,
      color: "var(--red)",
      label: "Can't move me!",
    },
  ];

  // Mutable event data
  private eventData: CalendarMonthInteractive.EventData[] = [
    {
      id: "1",
      title: "Team Standup",
      date: this.firstOfMonth.addDays(5),
      color: "var(--blue)",
    },
    {
      id: "2",
      title: "Design Review",
      date: this.firstOfMonth.addDays(8),
      color: "var(--orange)",
    },
  ];

  // Pending event state for create flow
  private pendingEvent: Option<CalendarMonthInteractive.PendingEvent> = null;
  private $popover: Option<CreateEventPopover> = null;
  private clickToCreateGesture: Option<CalendarMonthNewGestures.ClickToCreate> =
    null;
  private gestureManager: Option<
    CalendarMonthGesture.Manager<CalendarMonthGesture.Info>
  > = null;

  constructor() {
    super();
    this.setupGestures();
    this.rebindCalendar();
  }

  private setupGestures(): void {
    this.gestureManager =
      new CalendarMonthGesture.Manager<CalendarMonthGesture.Info>()
        .addPointerMoveCallback("highlight", (info) => {
          this.$calendar.highlightCell(info.date);
        })
        .addGestureChangeCallback("highlight", (_, context) => {
          if (context === "pointer-up" || context === "pointer-up-empty") {
            this.$calendar.highlightCell(null);
          }
        })
        .addGesture(
          new CalendarMonthExistingGestures.ResizeSpan(
            (e) => this.onSpanResized(e),
            (span, newRange) => this.onResizeGhostUpdate(span, newRange),
          ),
        )
        .addGesture(
          new CalendarMonthExistingGestures.MoveSpan(
            (e) => this.onSpanMoved(e),
            (span, offsetDays) =>
              this.$calendar.setDragOffset(span?.key ?? null, offsetDays),
          ),
        )
        .addGesture(
          new CalendarMonthExistingGestures.MoveEntryRow<CalendarMonthGesture.Info>(
            (e) => this.onEntryRowMoved(e),
            (span, offsetDays) => this.$calendar.setGhostSpan(span, offsetDays),
          ),
        );

    // Shared actions for create gestures
    const createActions: CalendarMonthNewGestures.Actions = {
      onCreateStart: (date) => this.onCreateStart(date),
      onCreateDrag: (dateRange) => this.onCreateDrag(dateRange),
      onCreateDragEnd: (dateRange) => this.onCreateDragEnd(dateRange),
      getPendingSpan: () => this.buildPendingSpan(),
      isCreateInProgress: () => this.pendingEvent != null,
      hideDetails: () => this.hideCreatePopover(),
      reshowDetails: (dateRange) => this.reshowCreatePopover(dateRange),
    };

    this.clickToCreateGesture = new CalendarMonthNewGestures.ClickToCreate(
      createActions,
    );

    const dragToCreateGesture = new CalendarMonthNewGestures.DragToCreate(
      createActions,
    );

    const dismissCreateGesture = new CalendarMonthNewGestures.DismissCreate(
      createActions,
      () => this.closeCreatePopover(),
    );

    const moveGesture = new CalendarMonthNewGestures.Move(createActions);
    const resizeGesture = new CalendarMonthNewGestures.Resize(createActions);

    // Order matters:
    // 1. DismissCreate - dismisses on click outside pending span
    // 2. Resize - resize edges of pending span
    // 3. Move - move pending span
    // 4. DragToCreate - create new multi-day span
    // 5. ClickToCreate - create new single-day span
    this.gestureManager
      .addGesture(dismissCreateGesture)
      .addGesture(resizeGesture)
      .addGesture(moveGesture)
      .addGesture(dragToCreateGesture)
      .addGesture(this.clickToCreateGesture);

    this.$calendar.setCallbacks(this.gestureManager.asCalendarMonthDelegate());
  }

  private onSpanMoved(e: {
    span: CalendarMonth.Span;
    segment: CalendarMonth.SpanSegmentInfo;
    fromDate: NaiveDate;
    toDate: NaiveDate;
    info: CalendarMonthGesture.Info;
  }): void {
    this.$calendar.highlightCell(null);
    const dayOffset = e.toDate.differenceInDays(e.fromDate);
    const movedSpan = this.spanData.find((s) =>
      s.start.equals(e.span.range.start),
    );
    if (!movedSpan) return;

    movedSpan.start = movedSpan.start.addDays(dayOffset);
    movedSpan.end = movedSpan.end.addDays(dayOffset);
    Toast.info(
      `Moved span by ${dayOffset} day${Math.abs(dayOffset) !== 1 ? "s" : ""}`,
    );
    this.rebindCalendar();
  }

  private onSpanResized(e: {
    span: CalendarMonth.Span;
    originalRange: NaiveDate.Range;
    newRange: NaiveDate.Range;
    info: CalendarMonthGesture.Info;
  }): void {
    this.$calendar.highlightCell(null);
    const resizedSpan = this.spanData.find(
      (s) =>
        s.start.equals(e.originalRange.start) &&
        s.end.equals(e.originalRange.end),
    );
    if (!resizedSpan) return;

    resizedSpan.start = e.newRange.start;
    resizedSpan.end = e.newRange.end;
    Toast.info(
      `Resized span to ${e.newRange.start.toString()} → ${e.newRange.end.toString()}`,
    );
    this.rebindCalendar();
  }

  private onResizeGhostUpdate(
    span: Option<CalendarMonth.Span>,
    newRange: Option<NaiveDate.Range>,
  ): void {
    this.$calendar.setResizeOverride(span?.key ?? null, newRange);
  }

  private async onEntryRowMoved(e: {
    eventData: ListItem;
    fromCell: CalendarMonthGesture.Info;
    toCell: CalendarMonthGesture.Info;
  }): Promise<void> {
    this.$calendar.highlightCell(null);
    const movedEvent = this.eventData.find(
      (ev) => ev.title === e.eventData.title,
    );
    if (!movedEvent) return;

    // Build timezone options programmatically
    const eventTz: Tzname = "America/New_York" as Tzname;
    const calendarTz: Tzname = "America/Los_Angeles" as Tzname;
    const browserTz: Tzname = Intl.DateTimeFormat().resolvedOptions()
      .timeZone as Tzname;

    const dayOffset = e.toCell.date.differenceInDays(e.fromCell.date);

    // Simulated event: 9:00 AM - 10:00 AM EST (2:00 PM - 3:00 PM UTC)
    const eventStartUtc = DateTime.utc
      .now()
      .ndt.date.withTime()
      .asUtc()
      .add({ hrs: 14 });
    const eventEndUtc = eventStartUtc.add({ hrs: 1 });
    const calendarTzRegion = await TimezoneRegion.get(calendarTz);

    // Helper to build option with resolved time range
    const buildOption = async (
      label: string,
      tzName: Tzname,
      isDefault?: boolean,
    ): Promise<TimezoneConfirmationModal.TimezoneOption> => {
      const givenTzRegion = await TimezoneRegion.get(tzName);

      // Calculate new start time
      const startWall = givenTzRegion.toTz(eventStartUtc);
      const newStartWall = startWall.add({ days: dayOffset });
      const newStartUtc = givenTzRegion.toWallClock(newStartWall.ndt).asUtc();
      const newStartLocal = calendarTzRegion.toTz(newStartUtc);

      // Calculate new end time
      const endWall = givenTzRegion.toTz(eventEndUtc);
      const newEndWall = endWall.add({ days: dayOffset });
      const newEndUtc = givenTzRegion.toWallClock(newEndWall.ndt).asUtc();
      const newEndLocal = calendarTzRegion.toTz(newEndUtc);

      const formatTime = (ndt: {
        time: {
          format: (opts: {
            includeSeconds: boolean;
            includeAmPm: boolean;
          }) => string;
        };
      }) => ndt.time.format({ includeSeconds: false, includeAmPm: true });

      return {
        label,
        description: TimezoneConfirmationModal.createTimeRangeDescription(
          {
            startTime: formatTime(newStartWall.ndt),
            endTime: formatTime(newEndWall.ndt),
            tzName,
          },
          {
            startTime: formatTime(newStartUtc),
            endTime: formatTime(newEndUtc),
            tzName: "UTC",
          },
          {
            startTime: formatTime(newStartLocal.ndt),
            endTime: formatTime(newEndLocal.ndt),
            tzName: calendarTz,
          },
        ),
        value: tzName,
        isDefault,
        resolvedTime: DateTimeRegion.Range.fromSingleTz(
          new DateTime.Range(newStartUtc, newEndUtc),
          calendarTzRegion,
        ),
      };
    };

    const options = await Promise.all([
      buildOption("Event's original timezone", eventTz),
      buildOption("Your calendar timezone", calendarTz, true),
      buildOption("Your current location", browserTz),
    ]);

    const result = await TimezoneConfirmationModal.show({
      title: "Select Timezone",
      description: "Please specify a timezone for the new event time.",
      eventTitle: movedEvent.title,
      eventIcon: "📅",
      eventIconBg: "var(--gray-dimmed)",
      options,
      completionText: "Move Event",
      cancelText: "Cancel",
    });

    if (!result) {
      Toast.info("Move cancelled");
      return;
    }

    // Move the event
    movedEvent.date = e.toCell.date;
    Toast.info(`Moved "${movedEvent.title}" to ${e.toCell.date.toString()}`);
    this.rebindCalendar();
  }

  private onCreateStart(date: NaiveDate): boolean {
    // Just initialize the pending event state
    // The popover is shown in onCreateDragEnd (called by both click and drag)
    this.pendingEvent = {
      dateRange: new NaiveDate.Range(date, date),
      title: "",
      isAllDay: false,
    };
    this.rebindCalendar();
    return true;
  }

  private onCreateDrag(dateRange: NaiveDate.Range): void {
    if (!this.pendingEvent) {
      return;
    }
    this.pendingEvent.dateRange = dateRange;

    // Use updateSpans for efficient drag updates (bypasses cell re-rendering)
    const spans = [...this.buildSpans(), this.buildPendingSpan()].filter(
      (s): s is CalendarMonth.Span => s != null,
    );
    this.$calendar.updateSpans(spans);
  }

  private onCreateDragEnd(dateRange: NaiveDate.Range): void {
    if (!this.pendingEvent) {
      return;
    }
    this.pendingEvent.dateRange = dateRange;
    this.rebindCalendar();

    // Show popover at the start date of the range
    const $cell = this.$calendar.getCellForDate(dateRange.start);
    if ($cell) {
      this.showCreatePopover(dateRange.start, $cell);
    }
  }

  private buildPendingSpan(): Option<CalendarMonth.Span> {
    if (!this.pendingEvent) return null;
    const pendingEvent = this.pendingEvent;
    return {
      key: "pending-event",
      contentSig: `pending|${pendingEvent.title}|${pendingEvent.dateRange.start.toString()}|${pendingEvent.dateRange.end.toString()}`,
      range: pendingEvent.dateRange,
      // isEditable: false prevents CalendarMonthExistingGestures.MoveSpan from interfering
      // CalendarMonthNewGestures.Move identifies pending span by date range match instead
      isEditable: false,
      render: (info, callbacks) => {
        const $span = CalendarMonthSpan.makeWith(
          {
            title: pendingEvent.title || "New Event",
            color: "var(--blue)",
            segment: info,
            showResizeHandles: true,
          },
          callbacks,
        );
        $span.style.opacity = "0.6";
        $span.style.border = "2px dashed var(--blue)";
        $span.dataset.pending = "true";
        return $span;
      },
    };
  }

  private showCreatePopover(date: NaiveDate, $cell: HTMLElement): void {
    this.$popover = CreateEventPopover.make().bind({
      date,
      initialTitle: "",
      initialAllDay: false,
      onTitleChange: (title) => {
        if (this.pendingEvent) {
          this.pendingEvent.title = title;
          this.rebindCalendar();
        }
      },
      onAllDayChange: (isAllDay) => {
        if (this.pendingEvent) {
          this.pendingEvent.isAllDay = isAllDay;
          this.rebindCalendar();
        }
      },
      onConfirm: (result) => {
        this.eventData.push({
          id: String(Date.now()),
          title: result.title,
          date: result.date,
          color: "var(--blue)",
        });
        Toast.info(`Created "${result.title}" on ${result.date.toString()}`);
        this.closeCreatePopover();
      },
      onCancel: () => {
        this.closeCreatePopover();
      },
    });

    this.$calendar.appendChild(this.$popover);

    // Calculate spanBottomOffset from actual span position
    const expectedRange = this.pendingEvent?.dateRange;
    const spanBottom = this.$calendar.getSpanBottomForDate(date, expectedRange);
    const calendarRect = this.$calendar.getBoundingClientRect();
    const cellRect = $cell.getBoundingClientRect();
    const cellTopRelativeToCalendar = cellRect.top - calendarRect.top;

    // If we found the span, use its bottom position; otherwise use default
    const spanBottomOffset =
      spanBottom != null ? spanBottom - cellTopRelativeToCalendar : undefined;

    this.$popover.positionBelowSpan($cell, this.$calendar, spanBottomOffset);
    this.$popover.focus();
  }

  private closeCreatePopover(): void {
    if (this.$popover) {
      this.$popover.remove();
      this.$popover = null;
    }
    this.pendingEvent = null;
    this.rebindCalendar();
  }

  /**
   * Hides the popover but keeps the pending event state.
   * Used during move/resize gestures.
   */
  private hideCreatePopover(): void {
    if (this.$popover) {
      this.$popover.remove();
      this.$popover = null;
    }
    // Note: Don't clear pendingEvent - just hide the form
  }

  /**
   * Reshows the popover after move/resize completes.
   */
  private reshowCreatePopover(dateRange: NaiveDate.Range): void {
    if (!this.pendingEvent) return;

    // Update pending event with new range
    this.pendingEvent.dateRange = dateRange;
    this.rebindCalendar();

    // Show popover at start date
    // Use $$.mutate to ensure the spans are rendered before positioning
    $$.mutate(() => {
      const $cell = this.$calendar.getCellForDate(dateRange.start);
      if ($cell) {
        this.showCreatePopover(dateRange.start, $cell);
      }
    });
  }

  private buildSpans(): CalendarMonth.Span[] {
    return this.spanData.map((data, i) => ({
      key: `example-span-${i}`,
      contentSig: `${data.label}|${data.color}|${data.isEditable ? 1 : 0}`,
      range: new NaiveDate.Range(data.start, data.end),
      isEditable: data.isEditable,
      render: (info: CalendarMonth.SpanSegmentInfo, callbacks) => {
        return CalendarMonthSpan.makeWith(
          {
            title: data.label,
            color: data.color,
            segment: info,
            showResizeHandles: data.isEditable,
          },
          callbacks,
        );
      },
    }));
  }

  private rebindCalendar(): void {
    this.$calendar.bind({
      month: this.today,
      cellHeight: 120,
      bind: ($cell, date, isCurrentMonth) => {
        $cell.clearChildren();
        if (!isCurrentMonth) return;

        // Find events for this date
        const eventsForDate = this.eventData.filter((ev) =>
          ev.date.equals(date),
        );

        const items: ListItem[] = eventsForDate.map((ev) => ({
          title: ev.title,
          accentColor: ev.color,
          at: this.exampleTime,
          timezone: this.timezone,
          onClick: () => {},
        }));

        if (items.length === 0) return;

        const $el = EntryList.make();
        $el.bind({ items, display: EntryDisplay.DEFAULT });
        $el.bindCallbacks(
          this.gestureManager!.asEntryListDelegate(
            { date, toString: () => date.toString() },
            items,
            createEventGhostSpan,
          ),
        );
        $el.setAttribute("type", "cell");
        $cell.appendChild($el);
      },
      options: {
        cellWidth: 180,
        startOfWeek: Weekday.SUN,
        today: this.today,
        spans: [...this.buildSpans(), this.buildPendingSpan()].filter(
          (s): s is CalendarMonth.Span => s != null,
        ),
        spanLaneGap: 2,
      },
    });
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #calendar {
        --span-lane-height: 20px;
      }
    `,
  ];

  static $html = html`
    <std-calendar-month id="calendar"></std-calendar-month>
  `;
}

export namespace CalendarMonthInteractive {
  export interface SpanData {
    start: NaiveDate;
    end: NaiveDate;
    isEditable: boolean;
    color: string;
    label: string;
  }

  export interface EventData {
    id: string;
    title: string;
    date: NaiveDate;
    color: string;
  }

  export interface PendingEvent {
    dateRange: NaiveDate.Range;
    title: string;
    isAllDay: boolean;
  }
}

export class CalendarMonthInteractiveStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Month Interactive";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive Demo",
        render: () => CalendarMonthInteractive.make(),
      },
    ];
  }
}
