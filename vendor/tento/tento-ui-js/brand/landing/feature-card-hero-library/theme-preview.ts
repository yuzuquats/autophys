import { DateTime, Local, Ms, TimePoint } from "@tento-chrono";

import { MockCalendarRow } from "../../../components/calendar/calendar-column.mock";
import type { CalendarColumnCellContent } from "../../../components/calendar/calendar-column-cell-content";
import { SwatchRow } from "../../../components/swatch-row/swatch-row";

/**
 * `ThemePreview` — the controller behind the GTM "Themes" feature card. It owns a
 * single mock calendar day-column and recolors it as the user hovers/clicks the
 * theme swatches, mirroring the real Calendar Theme picker
 * (`lona/so.lona/html/lib/core/theme-picker.ts` `ThemePickerContent`).
 *
 * It produces BOTH halves of the card from one instance so they share state:
 *  - `calendarBox()` — the clipped calendar column (the card MEDIA / flat-grid asset).
 *  - `swatchRow()`   — the interactive swatch row (the card ACCESSORY).
 *
 * The calendar instance is created eagerly in `make()` so `swatchRow()` can wire
 * to it even though `LandingCard` builds the accessory before the media. Recolor
 * is a re-`bind()` of the calendar with the theme's event palette plus a sheet
 * background swap — exactly `ThemePickerContent.rebindCalendar()`.
 *
 * Pure @tento-ui: theme data is hardcoded mock data (see MOCK_THEMES), because
 * this layer can't import @tento-lona's `ThemeStore`/`BUILTIN_THEMES`.
 */
export class ThemePreview {
  private readonly $calendar: MockCalendarRow;
  private $box: Option<HTMLElement> = null;
  private committed = 0;

  private constructor() {
    this.$calendar = MockCalendarRow.make();
    this.applyTheme(this.committed);
  }

  static make(): ThemePreview {
    return new ThemePreview();
  }

  // The clipped calendar preview box — the asset shown standalone in the flat
  // grid AND tiled as the bento card's media. Cached: resize re-renders reuse the
  // one calendar instance the swatch row controls.
  calendarBox(): HTMLElement {
    if (this.$box) return this.$box;

    this.$calendar.assignStyles({
      position: "absolute",
      left: "0px",
      top: `${THEME_TOP_PADDING_PX}px`,
      width: "100%",
      height: `calc(${THEME_HOUR_PX}px * 24)`,
      "--sheet-background-color": "transparent",
      "--background": "transparent",
      "--std-calendar-column-layout-horizontal-color": "transparent",
      "--std-calendar-column-layout-width": `${THEME_HOUR_PX}px`,
      borderRadius: "8px",
    });

    const $box = document.createElement("div");
    $box.appendChild(this.$calendar);
    // Fixed-size portrait box. The FeatureCardHero "scaled-bottom" anchor scales
    // it to ~75% of its slot width, centers it, and bleeds the bottom — so sizing
    // is responsive at the tiling layer; the box itself is a plain fixed element.
    $box.assignStyles({
      position: "relative",
      width: `${THEME_PREVIEW_WIDTH}px`,
      height: `${THEME_PREVIEW_HEIGHT}px`,
      overflow: "hidden",
      backgroundColor: MOCK_THEMES[this.committed].sheetBackground,
      backgroundImage: `repeating-linear-gradient(
        180deg,
        color-mix(in srgb, var(--divider) 88%, var(--text-pri) 12%) 0 1px,
        transparent 1px 100%
      )`,
      backgroundSize: `100% ${THEME_HOUR_PX}px`,
      backgroundPosition: `0px ${THEME_TOP_PADDING_PX}px`,
      border: "1px solid var(--divider)",
      borderRadius: "8px",
      boxSizing: "border-box",
      transition: "background-color 0.2s ease",
    });
    this.$box = $box;
    return $box;
  }

  // The interactive swatch row — squares only, no labels. Hover previews a theme;
  // click commits it (the ring moves to the committed swatch).
  swatchRow(): HTMLElement {
    return SwatchRow.makeWith({
      swatches: MOCK_THEMES.map((theme) => ({
        background: theme.swatch,
        label: theme.label,
      })),
      selectedIndex: this.committed,
      onHover: (index: Option<number>) =>
        this.applyTheme(index == null ? this.committed : index),
      onSelect: (index: number) => {
        this.committed = index;
        this.applyTheme(index);
      },
    });
  }

  private applyTheme(index: number): void {
    const theme = MOCK_THEMES[index];
    this.$calendar.bind(eventsForTheme(theme));
    if (this.$box) {
      this.$box.assignStyles({ backgroundColor: theme.sheetBackground });
    }
  }
}

export namespace ThemePreview {
  export type Theme = {
    label: string;
    // The swatch's visual signature — a CSS gradient of the theme palette.
    swatch: string;
    // Colors applied to event blocks, cycled across the column's events.
    eventColors: string[];
    // The column's sheet background under that theme.
    sheetBackground: string;
  };
}

// Vertical px per hour in the mock calendar column. Events lay out from 0h while
// their labels display the morning hours (same trick as the real picker preview).
const THEME_HOUR_PX = 48;
const THEME_PREVIEW_WIDTH = 260;
// Portrait box. The FeatureCardHero "scaled-bottom" anchor scales it so its WIDTH
// is ~75% of the slot (centered, side margins), pins the top a gap down, and lets
// the taller bottom bleed off the slot edge — a large, bottom-anchored presence.
// Being portrait is what makes it reach/bleed the bottom at a width with margins;
// shows ~the morning, the rest clips off the bottom (overflow:hidden).
const THEME_PREVIEW_HEIGHT = 450;
const THEME_TOP_PADDING_PX = 28;

type BaseEvent = {
  id: string;
  label: string;
  layoutStartHrs: number;
  layoutStartMins: number;
  labelStartHrs: number;
  labelStartMins: number;
  durationMins: number;
};

// The column's events — color comes from the active theme (see eventsForTheme),
// not from the event itself.
const BASE_EVENTS: BaseEvent[] = [
  { id: "call", label: "Call", layoutStartHrs: 0, layoutStartMins: 0, labelStartHrs: 9, labelStartMins: 0, durationMins: 90 },
  { id: "lunch", label: "Lunch", layoutStartHrs: 1, layoutStartMins: 0, labelStartHrs: 10, labelStartMins: 0, durationMins: 60 },
  { id: "exercise", label: "Exercise", layoutStartHrs: 2, layoutStartMins: 0, labelStartHrs: 11, labelStartMins: 0, durationMins: 60 },
  { id: "focus", label: "Focus Time", layoutStartHrs: 0, layoutStartMins: 0, labelStartHrs: 9, labelStartMins: 0, durationMins: 120 },
  { id: "planning", label: "Planning", layoutStartHrs: 3, layoutStartMins: 15, labelStartHrs: 12, labelStartMins: 15, durationMins: 45 },
  { id: "errands", label: "Errands", layoutStartHrs: 3, layoutStartMins: 15, labelStartHrs: 12, labelStartMins: 15, durationMins: 45 },
  { id: "wrap", label: "Wrap up", layoutStartHrs: 5, layoutStartMins: 0, labelStartHrs: 15, labelStartMins: 30, durationMins: 120 },
  { id: "dinner", label: "Dinner", layoutStartHrs: 4, layoutStartMins: 30, labelStartHrs: 16, labelStartMins: 30, durationMins: 120 },
  { id: "review", label: "Review", layoutStartHrs: 5, layoutStartMins: 30, labelStartHrs: 15, labelStartMins: 0, durationMins: 60 },
];

// Mirrors BUILTIN_THEMES in @tento-lona theme-store.ts — duplicated as mock data
// because this layer is @tento-ui and can't import @tento-lona (package
// direction). The swatch gradient and the event palette share the same colors so
// a swatch previews exactly what the calendar will use.
const MOCK_THEMES: ThemePreview.Theme[] = [
  {
    label: "Default",
    swatch:
      "linear-gradient(135deg, var(--yellow) 25%, var(--blue) 25%, var(--green) 50%, var(--red) 50%, var(--red) 75%, var(--purple) 75%)",
    eventColors: [
      "var(--red)",
      "var(--blue)",
      "var(--yellow)",
      "var(--green)",
      "var(--purple)",
      "var(--teal)",
      "var(--orange)",
    ],
    sheetBackground: "var(--bg)",
  },
  {
    label: "Grass",
    swatch:
      "linear-gradient(45deg, #f8e7dc 25%, #c7d5ba 25%, #c7d5ba 50%, #f2bab9 50%, #f2bab9 75%, #f8e7dc 75%)",
    eventColors: ["#c7d5ba", "#f2bab9", "#f8e7dc"],
    sheetBackground: "#faf6f0",
  },
  {
    label: "Solarized",
    swatch:
      "linear-gradient(90deg, #5c8eb7 33%, #5aada5 33%, #5aada5 66%, #8789b0 66%)",
    eventColors: ["#5c8eb7", "#5aada5", "#8789b0"],
    sheetBackground: "#fdf6e3",
  },
  {
    label: "Bubblegum",
    swatch:
      "linear-gradient(to right, #ff85ea 33%, #85c1ff 33%, #85c1ff 66%, #a5ff85 66%)",
    eventColors: ["#ff85ea", "#85c1ff", "#a5ff85"],
    sheetBackground: "#fff5fd",
  },
  {
    label: "Fall",
    swatch:
      "linear-gradient(to bottom, #a67c59 33%, #cba642 33%, #cba642 66%, #7d9158 66%)",
    eventColors: ["#a67c59", "#cba642", "#7d9158"],
    sheetBackground: "#f7f1e6",
  },
  {
    label: "Sky",
    swatch:
      "linear-gradient(60deg, #87ceeb 25%, #4682b4 25%, #4682b4 50%, #1e90ff 50%, #1e90ff 75%, #87ceeb 75%)",
    eventColors: ["#4682b4", "#1e90ff", "#87ceeb"],
    sheetBackground: "#f0f8ff",
  },
  {
    label: "Lofi",
    swatch:
      "linear-gradient(120deg, #d8a9a3 25%, #e3d9b2 25%, #e3d9b2 50%, #a1b5d8 50%, #a1b5d8 75%, #cbc0d3 75%)",
    eventColors: ["#d8a9a3", "#e3d9b2", "#a1b5d8", "#cbc0d3"],
    sheetBackground: "#f5f1ec",
  },
];

function eventsForTheme(
  theme: ThemePreview.Theme,
): (CalendarColumnCellContent.Props & { id: string; background: string })[] {
  return BASE_EVENTS.map((event, index) =>
    cellFor(event, theme.eventColors[index % theme.eventColors.length]),
  );
}

function cellFor(
  event: BaseEvent,
  background: string,
): CalendarColumnCellContent.Props & { id: string; background: string } {
  const start = TimePoint.ms(
    Ms.resolve({ hrs: event.layoutStartHrs, mins: event.layoutStartMins }),
  );
  const labelStart = TimePoint.ms(
    Ms.resolve({ hrs: event.labelStartHrs, mins: event.labelStartMins }),
  );
  const labelDateStart = Local.now().withTime(labelStart.time);
  return {
    id: event.id,
    label: event.label,
    time: new TimePoint.Range(start, start.add({ mins: event.durationMins })),
    timeLabel: new DateTime.Range(
      labelDateStart,
      labelDateStart.add({ mins: event.durationMins }),
    ),
    background,
  };
}
