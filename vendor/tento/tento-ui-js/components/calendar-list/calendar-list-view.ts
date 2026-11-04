import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Column } from "../../component-builtin";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ListCellLayout } from "../list/list-cell-layout";

// Pure @tento-ui calendar-list view — the visual layer of the app's calendar
// sidebar list, with NO @tento-lona coupling (no CalendarClient / LonaColors /
// Network types). The data adapters in @tento-lona/sheets-ui
// (UserCalendarList / CalendarRowVisibilityIcon / CalendarListRow /
// CalendarDefaultAccessory) compose these, mapping calendar data onto the
// simple {name,color,checked} props below — so the app sidebar and the GTM
// feature-card asset render the exact same components.

const checkmark = (strokeColor: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='${strokeColor}' stroke-linecap='round' stroke-linejoin='round' stroke-width='3.5' d='m5 13l4 4L19 7'/%3E%3C/svg%3E");`;

// The per-calendar visibility toggle: a 16px square outlined with a 2.5px border
// in the calendar's color, filled + a soft checkmark when visible (checked), an
// empty colored outline when hidden. Click flips the state and calls onToggle.
@component({ name: "std-calendar-visibility-icon" })
export class CalendarVisibilityIcon extends LonaWebComponent {
  private _checked: boolean = true;
  private _onToggle: Option<(checked: boolean) => void> = null;
  private _clickBound: boolean = false;

  static makeWith(props: CalendarVisibilityIcon.Props): CalendarVisibilityIcon {
    return CalendarVisibilityIcon.make().bind(props);
  }

  bind(props: CalendarVisibilityIcon.Props): this {
    this._checked = props.checked;
    this._onToggle = props.onToggle;
    this.style.setProperty("--calendar-color", props.color);
    this.toggleAttribute("checked", this._checked);

    // Only wire the click listener once so it doesn't accumulate on rebind.
    if (!this._clickBound) {
      this._clickBound = true;
      GESTURE_MANAGER.addPointerEvent(this, {
        onClick: () => {
          this._checked = !this._checked;
          this.toggleAttribute("checked", this._checked);
          this._onToggle?.(this._checked);
        },
      });
      this.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }
    return this;
  }

  static $styles: Style.Compat[] = [
    css(`
      :host {
        position: relative;
        cursor: pointer;
        margin-right: 8px;
        height: var(--icon-size, 16px);
        width: var(--icon-size, 16px);
        border-radius: 4px;
        color: white;
      }

      :host::before {
        position: absolute;
        content: "";
        inset: 0px;
        border: 2.5px solid var(--calendar-color);
        border-radius: 4px;
        pointer-events: none;
      }

      :host([checked])::before {
        background: var(--calendar-color);
      }

      :host([checked])::after {
        pointer-events: none;
        position: absolute;
        left: 0px;
        top: 0.5px;
        width: var(--icon-size, 16px);
        height: var(--icon-size, 16px);
        display: flex;
        align-items: center;
        justify-content: center;
        content: ${checkmark("black")};
        opacity: 0.6;
      }
    `),
  ];
}

export namespace CalendarVisibilityIcon {
  export type Props = {
    // A CSS color string for the calendar (e.g. "var(--blue)").
    color: string;
    checked: boolean;
    onToggle: Option<(checked: boolean) => void>;
  };
}

// The plain solid-color square accessory (no toggle) — the default calendar
// indicator used where visibility isn't editable (e.g. the picker / event
// details). Mirrors the former CalendarDefaultAccessory.
@component({ name: "std-calendar-swatch" })
export class CalendarSwatch extends LonaWebComponent {
  static makeWith(props: CalendarSwatch.Props): CalendarSwatch {
    const $e = CalendarSwatch.make();
    $e.style.background = props.color;
    return $e;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        margin-right: 8px;
        height: 16px;
        width: 16px;
        border-radius: 4px;
      }
    `,
  ];
}

export namespace CalendarSwatch {
  export type Props = {
    // A CSS color string for the calendar (e.g. "var(--blue)").
    color: string;
  };
}

// One calendar row: a leading accessory (slotted) + the calendar name. Honors
// --cell-height (row height) and --calendar-font-size (name size).
@component({ name: "std-calendar-list-row" })
export class CalendarRowView extends LonaWebComponent {
  static makeWith(props: CalendarRowView.Props): CalendarRowView {
    return CalendarRowView.make().bind(props);
  }

  bind(props: CalendarRowView.Props): this {
    this.clearChildren();

    this.$("calendar-name").textContent = props.name;

    if (props.$accessory) {
      props.$accessory.slot = "accessory";
      this.appendChild(props.$accessory);
    }

    const canSelect = props.selectable && props.onSelect != null;
    if (canSelect) {
      this.addPointerEvent({ onClick: props.onSelect });
    } else {
      GESTURE_MANAGER.unregister(this);
    }
    this.toggleAttribute("selectable", canSelect);
    this.toggleAttribute("selected", props.selected);
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        height: var(--cell-height, 20px);
        width: 100%;
      }

      #root {
        width: 100%;
        height: 100%;
        align-items: center;
        position: relative;
      }

      :host([selected]) #root::before,
      :host([selectable]) #root:hover::before {
        content: "";
        position: absolute;
        inset: -2px -6px;
        background: var(--bg-hover);
        border-radius: 8px;
      }

      :host([selected]) #root::before {
        background: var(--bg-selected);
      }

      #calendar-name {
        color: var(--text-sec);
        --font-size: var(--calendar-font-size, var(--small-size));
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <slot name="accessory"></slot>
      <h2 id="calendar-name" class="small"></h2>
    </std-row>
  `;
}

export namespace CalendarRowView {
  export type Props = {
    name: string;
    $accessory: Option<HTMLElement>;
    selected: boolean;
    selectable: boolean;
    onSelect: Option<() => void>;
  };
}

// The grouped calendar list (presentation only). Each group is an optional
// header + a column of rows; groups are separated by 24px, rows by 6px —
// matching the app's UserCalendarList layout. No owner/"other" splitting here:
// the caller (the sheets-ui adapter, or the GTM mock) supplies pre-built groups.
export namespace CalendarListView {
  export type Row = {
    name: string;
    // The leading accessory element (a CalendarVisibilityIcon, a CalendarSwatch,
    // or any caller-supplied element). The caller builds it so the colour /
    // visibility / toggle wiring stays with whoever has that data.
    $accessory: Option<HTMLElement>;
    selected: boolean;
    selectable: boolean;
    onSelect: Option<() => void>;
  };

  // One rendered form of a group header: title, optional secondary line,
  // optional monochrome icon URL (CSS-masked so it tints with the theme).
  export type Header = {
    title: string;
    subtitle: Option<string>;
    icon: Option<string>;
  };

  export type Group = {
    // Null → the group renders its rows with no header cell.
    header: Option<Header>;
    // Alternate header form toggled by clicking the header (e.g.
    // "My calendars" ⇄ the account identity). Null → header is static.
    altHeader: Option<Header>;
    rows: Row[];
  };

  export type Props = {
    groups: Group[];
    padding: string;
  };

  export function makeWith(props: Props): HTMLElement {
    const $root = Column.builder();
    for (const group of props.groups) {
      $root.row($group(group));
    }
    return $root.build(props.padding).assignStyles({
      alignSelf: "stretch",
      marginBlock: "4px",
      gap: "24px",
    });
  }

  function $group(group: Group): HTMLElement {
    const col = Column.builder();
    if (group.header != null) {
      col.row($header(group.header, group.altHeader));
    }
    for (const row of group.rows) {
      col.row($row(row));
    }
    const $c = col.build("0px");
    $c.style.gap = "6px";
    return $c;
  }

  // Group header as a proper list cell. When `alt` is present, clicking the
  // cell toggles between the two forms (e.g. "My calendars" ⇄ the account
  // identity with its provider glyph); a static header disables the cell's
  // hover highlight so it doesn't read as interactive.
  function $header(header: Header, alt: Option<Header>): HTMLElement {
    const $holder = Column.make();
    let expanded = false;

    const $cellFor = (form: Header): HTMLElement => {
      const $cell = ListCellLayout.makeText(form.title, {
        caption: form.subtitle,
        $icon: form.icon != null ? $sectionIcon(form.icon) : null,
        titleStyle: "1-line",
      });
      // Bleed the cell's own 8px inline padding so the header text stays
      // flush with the calendar rows below it.
      $cell.style.marginInline = "-8px";
      if (alt == null) {
        $cell.style.setProperty("--list-cell-layout-hover-color", "transparent");
      }
      return $cell;
    };

    const rebuild = (): void => {
      while ($holder.firstChild != null) {
        $holder.removeChild($holder.firstChild);
      }
      $holder.appendChild($cellFor(expanded && alt != null ? alt : header));
    };
    rebuild();

    if (alt != null) {
      $holder.style.cursor = "pointer";
      GESTURE_MANAGER.addPointerEvent($holder, {
        onClick: () => {
          expanded = !expanded;
          rebuild();
        },
      });
    }
    return $holder;
  }

  // A 16px monochrome icon rendered as a CSS-masked box so it tints with a
  // theme color token (secondary text — quieter than the title), rather than
  // an <img> that would keep the source SVG's own fill.
  function $sectionIcon(icon: string): HTMLElement {
    const $icon = document.createElement("div");
    const url = `url("${icon}")`;
    const s = $icon.style;
    s.setProperty("flex", "0 0 auto");
    s.setProperty("width", "16px");
    s.setProperty("height", "16px");
    s.setProperty("-webkit-mask-image", url);
    s.setProperty("mask-image", url);
    s.setProperty("-webkit-mask-size", "contain");
    s.setProperty("mask-size", "contain");
    s.setProperty("-webkit-mask-repeat", "no-repeat");
    s.setProperty("mask-repeat", "no-repeat");
    s.setProperty("-webkit-mask-position", "center");
    s.setProperty("mask-position", "center");
    s.setProperty("background-color", "var(--text-sec)");
    return $icon;
  }

  function $row(row: Row): CalendarRowView {
    return CalendarRowView.makeWith({
      name: row.name,
      $accessory: row.$accessory,
      selected: row.selected,
      selectable: row.selectable,
      onSelect: row.onSelect,
    });
  }
}
