import { NaiveDate } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";

/**
 * A simplified create event popover for calendar month examples.
 * This is a demo component - the real implementation is in so_lona.
 */
@component({ name: "std-create-event-popover" })
export class CreateEventPopover extends LonaWebComponent {
  private $titleInput: HTMLInputElement = this.$("title") as HTMLInputElement;
  private $allDayCheckbox: HTMLInputElement = this.$("all-day") as HTMLInputElement;

  private currentDate: Option<NaiveDate> = null;
  private onTitleChange: Option<(title: string) => void> = null;
  private onAllDayChange: Option<(isAllDay: boolean) => void> = null;
  private onConfirm: Option<(data: CreateEventPopover.Result) => void> = null;
  private onCancel: Option<() => void> = null;

  constructor() {
    super();

    this.$titleInput.addEventListener("input", () => {
      this.onTitleChange?.(this.$titleInput.value);
    });

    this.$titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });

    this.$allDayCheckbox.addEventListener("change", () => {
      this.onAllDayChange?.(this.$allDayCheckbox.checked);
    });

    GESTURE_MANAGER.addPointerEvent(this.$("create-btn"), {
      onClick: () => this.confirm(),
    });

    GESTURE_MANAGER.addPointerEvent(this.$("cancel-btn"), {
      onClick: () => this.cancel(),
    });
  }

  bind(props: CreateEventPopover.Props): this {
    this.currentDate = props.date;
    this.onTitleChange = props.onTitleChange ?? null;
    this.onAllDayChange = props.onAllDayChange ?? null;
    this.onConfirm = props.onConfirm ?? null;
    this.onCancel = props.onCancel ?? null;

    this.$titleInput.value = props.initialTitle ?? "";
    this.$allDayCheckbox.checked = props.initialAllDay ?? false;

    this.$("date-label").textContent = props.date.toString();

    return this;
  }

  focus(): void {
    this.$titleInput.focus();
  }

  private confirm(): void {
    if (!this.currentDate) return;
    this.onConfirm?.({
      date: this.currentDate,
      title: this.$titleInput.value || "New Event",
      isAllDay: this.$allDayCheckbox.checked,
    });
  }

  private cancel(): void {
    this.onCancel?.();
  }

  /**
   * Position the popover below a pending span, constrained within the calendar bounds.
   * @param cell - The calendar cell element
   * @param calendar - The calendar container element
   * @param spanBottomOffset - Distance from cell top to bottom of span (default: 52 = 30 day number + 20 span + 2 gap)
   */
  positionBelowSpan(
    cell: HTMLElement,
    calendar: HTMLElement,
    spanBottomOffset: number = 52,
  ): void {
    const cellRect = cell.getBoundingClientRect();
    const calendarRect = calendar.getBoundingClientRect();

    const popoverWidth = 260;
    const popoverHeight = 160; // Approximate height

    // Position top edge of popover at bottom of span
    let top = cellRect.top - calendarRect.top + spanBottomOffset + 4;

    // Align to left edge of the cell
    let left = cellRect.left - calendarRect.left;

    // Constrain left edge to calendar bounds
    if (left < 8) {
      left = 8;
    }

    // Constrain right edge to calendar bounds
    if (left + popoverWidth > calendarRect.width - 8) {
      left = calendarRect.width - popoverWidth - 8;
    }

    // If popover would overflow bottom, position above the span instead
    if (top + popoverHeight > calendarRect.height) {
      const spanTopOffset = spanBottomOffset - 20; // Approximate span height
      top = cellRect.top - calendarRect.top + spanTopOffset - popoverHeight - 4;
    }

    // Final clamp to ensure it's not above the calendar
    if (top < 8) top = 8;

    this.assignStyles({
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    css`
      :host {
        position: absolute;
        z-index: 100;
        background: var(--bg);
        border: 1px solid var(--divider);
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        width: 260px;
        animation: popover-in 0.2s ease;
      }

      @keyframes popover-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      #date-label {
        color: var(--text-ter);
        margin-bottom: 8px;
      }

      #title {
        width: 100%;
        padding: 8px;
        border: 1px solid var(--divider);
        border-radius: 4px;
        font-size: var(--text-14px);
        background: var(--bg);
        color: var(--text-pri);
        margin-bottom: 8px;
      }

      #title:focus {
        outline: none;
        border-color: var(--blue);
      }

      #all-day-row {
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      #all-day {
        width: 16px;
        height: 16px;
      }

      #all-day-label {
        color: var(--text-sec);
      }

      #buttons {
        gap: 8px;
        justify-content: flex-end;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p id="date-label" class="caption"></p>
    <input id="title" type="text" placeholder="Event title" />
    <std-row id="all-day-row">
      <input id="all-day" type="checkbox" />
      <label id="all-day-label" for="all-day" class="small">All day</label>
    </std-row>
    <std-row id="buttons">
      <button id="cancel-btn" secondary>Cancel</button>
      <button id="create-btn" primary>Create</button>
    </std-row>
  `;
}

export namespace CreateEventPopover {
  export interface Props {
    date: NaiveDate;
    initialTitle?: string;
    initialAllDay?: boolean;
    onTitleChange?: (title: string) => void;
    onAllDayChange?: (isAllDay: boolean) => void;
    onConfirm?: (data: Result) => void;
    onCancel?: () => void;
  }

  export interface Result {
    date: NaiveDate;
    title: string;
    isAllDay: boolean;
  }
}
