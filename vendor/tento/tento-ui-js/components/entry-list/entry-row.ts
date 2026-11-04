import "@tento-ui/components/round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Point } from "@tento-core/point";
import { DateTime, NaiveDate, Weekday } from "@tento-chrono";
import { EntryDisplay, ListItem } from "./list-item";

/**
 * `EntryRow` (`std-entry-row`) — one row of an `EntryList`: a leading 4px
 * accent bar (optional), an ellipsised title, and an optional trailing time.
 *
 * Binds the source-agnostic `ListItem` viewmodel; the per-list `EntryDisplay`
 * carries the formatting context (`timeScale`/`use24Hour`/`dateFormat`) shared
 * by all rows. The DOM/CSS is unchanged from the former `EventListRow` —
 * only the prop shape (viewmodel) and names are generalized.
 */
@component({ name: "std-entry-row" })
export class EntryRow extends LonaWebComponent {
  private display: EntryDisplay = EntryDisplay.DEFAULT;

  bindCallbacks(callbacks: EntryRow.Callbacks): this {
    GESTURE_MANAGER.addPointerEvent(this, {
      onPointerDown: (offset) => {
        callbacks.onPointerDown({ offset });
      },
      onClick: (_, offset) => {
        callbacks.onPointerUp({ offset });
      },
      onContextMenu: (_, offset) => {
        callbacks.onContextMenu({ offset });
      },
    });
    this.onpointermove = (e) => {
      e.stopPropagation();
      const offset: Point = { x: e.offsetX, y: e.offsetY };
      callbacks.onPointerMove({ offset });
    };
    return this;
  }

  bind(item: ListItem, display: EntryDisplay): this {
    this.display = display;

    // Leading accent bar (calendar color, task-status color, …)
    if (item.accentColor) {
      this.$("accent-bar").style.backgroundColor = item.accentColor;
      this.$("accent-bar").style.display = "block";
    } else {
      this.$("accent-bar").style.display = "none";
    }

    // Title (mandatory)
    this.$("title").textContent = item.title;

    // Trailing time
    if (item.at && item.timezone) {
      const localTime = item.timezone.toTz(item.at);
      const formattedTime = this.formatTime(localTime);
      this.$("time").textContent = formattedTime;
      this.$("time").style.display = "block";
    } else {
      this.$("time").style.display = "none";
    }

    // Simple click fallback when no callbacks are bound. Rows are rebound in
    // place, so a row whose new item has no onClick must shed the old one.
    if (item.onClick) {
      const onClick = item.onClick;
      GESTURE_MANAGER.addPointerEvent(this, {
        onClick: () => onClick(),
      });
    } else {
      GESTURE_MANAGER.unregister(this);
    }

    return this;
  }

  private formatTime(localTime: DateTime<any>): string {
    const time = localTime.time.format({
      includeSeconds: false,
      use24Hour: this.display.use24Hour,
      includeAmPm: !this.display.use24Hour,
    });
    const date = localTime.date;

    switch (this.display.timeScale) {
      case "day":
        return time;
      case "week": {
        const dayOfWeek = Weekday.shortName(date.dayOfWeek.dow);
        return `${dayOfWeek} - ${time}`;
      }
      case "month": {
        return `${date.day1}, ${time}`;
      }
      case "year": {
        const dateStr = NaiveDate.Formatter.render(date, {
          dateFormat: this.display.dateFormat,
          shortMonth: true,
        });
        return `${dateStr}, ${time}`;
      }
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        border-radius: 4px;
        cursor: pointer;
        position: relative;
        overflow: visible;
        transition: box-shadow 0.15s ease;
      }

      :host([active]) {
        box-shadow: rgba(0, 0, 0, 0.6) 0px 1px 3px 0.5px;
        z-index: 1;
      }

      #root {
        padding: var(--entry-row-padding, 12px);
        border-radius: inherit;
        overflow: hidden;
        transition: background-color 0.15s ease;
      }

      :host([active]) #root {
        background: var(--entry-row-active-color, var(--bg));
      }

      :host(:hover) #root {
        background: var(--entry-row-hover-color, var(--bg-hover));
      }

      #accent-bar {
        width: 4px;
        border-radius: 2px;
        flex-shrink: 0;
        margin-right: 8px;
        margin-block: -2px;
      }

      #title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        --font-size: var(--small-size);
      }

      #time {
        color: var(--text-ter);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        --font-size: var(--small-size);
        flex-shrink: 0;
        margin-left: 6px;
      }
    `,
  ];
  static $html = html`
    <std-row id="root">
      <div id=accent-bar></div>
      <p class=small id=title></p>
      <std-spacer></std-spacer>
      <p class=small id=time></p>
    </std-row>
  `;
}

export namespace EntryRow {
  export type Callbacks = {
    onPointerDown: (event: { offset: Point }) => void;
    onPointerUp: (event: { offset: Point }) => void;
    onPointerMove: (event: { offset: Point }) => void;
    onContextMenu: (event: { offset: Point }) => void;
  };

  export namespace Callbacks {
    export const DEFAULT: Callbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUp: Constants.EMPTY_FUNCTION,
      onPointerMove: Constants.EMPTY_FUNCTION,
      onContextMenu: Constants.EMPTY_FUNCTION,
    };
  }
}
