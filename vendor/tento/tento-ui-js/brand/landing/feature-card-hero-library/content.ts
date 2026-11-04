import { Constants } from "@tento-core/constants";
import {
  DateTime,
  DateTimeRegion,
  type FixedOffset,
  Local,
  NaiveDate,
  TimezoneRegion,
  Tzname,
  Utc,
} from "@tento-chrono";

import { FeatureCardHero } from "../feature-card-hero";
import { ThemePreview } from "./theme-preview";
import { $$ } from "../../../fastdom";
import {
  CalendarListView,
  CalendarVisibilityIcon,
} from "../../../components/calendar-list/calendar-list-view";
import { EntryList } from "../../../components/entry-list/entry-list";
import { EntryDisplay } from "../../../components/entry-list/list-item";
import { FlightStatusCard } from "../../../components/event-details/flight-status-card";
import { HomeGridCard } from "../../../components/home-card/home-grid-card";
import { RowIcon } from "../../../components/home-card/row-icon";
import { LineChartPreview } from "../../../components/line-chart/line-chart-preview";
import { NuxHabitCard } from "../../../components/nux-habit-card/habit-card";
import { QuickAddCard } from "../../../components/quick-add/quick-add-card";
import { LonaCardIcon } from "../../../components/icons/card-icon";
import { SheetsIcon } from "../../../components/icons/sheets-icon";
import { TasksIcon } from "../../../components/icons/tasks-icon";
import { LonaThemePickerIcon } from "../../../components/icons/theme-picker-icon";
import { SpotlightPreview } from "../../../components/spotlight-preview/spotlight-preview";
import { SpotlightRow } from "../../../components/spotlight/spotlight-row";
import { SchedulingLinkPreview } from "../../../components/scheduling-link-preview/scheduling-link-preview";
import { SlotCard } from "../../../components/slot/slot-card";
import { SheetCell } from "../../../components/sheet/sheet-cell";
import { WeatherTooltip } from "../../../components/weather/weather-tooltip";
import { Round } from "../../../components/round";
import {
  CheckSquareIcon,
  FormulaIcon,
  LonaIcons,
  MoonIcon,
  NumberIcon,
  PlusIcon,
} from "../../../ui/icons";
import { Typography } from "../../../ui/typography";

// Asset content for the feature-card catalog — components-first: live @tento-ui
// product components with mock data. $screenshot is the one exception (a real
// app capture for the full-app "page format" asset). Each builder is a pure
// factory (no shared element). Pure @tento-ui; no app-layer deps.
export namespace FeatureCardContent {
  // The Themes asset — a mock calendar day-column the theme recolors. Standalone
  // (the flat "All assets" grid) it's just the bare column; in the bento it's
  // paired with an interactive swatch row via themesCard().
  export function $themes(): HTMLElement {
    return ThemePreview.make().calendarBox();
  }

  // The interactive Themes bento card. One ThemePreview drives both halves so
  // they share state: the media (the calendar, tiled by a one-off FeatureCardHero
  // so it sizes like every other hero asset) and the accessory (the swatch row).
  // Hovering a swatch previews a theme; clicking commits it.
  export function themesCard(): {
    renderVisual: () => HTMLElement;
    renderAccessory: () => HTMLElement;
  } {
    const preview = ThemePreview.make();
    return {
      renderVisual: () =>
        FeatureCardHero.makeWith({
          items: [
            {
              id: "themes",
              // Keep in sync with THEME_PREVIEW_WIDTH/HEIGHT (theme-preview.ts) and
              // the hero/feature/themes entry in library.ts. scaled-bottom renders
              // it at ~60% of the slot width, centered, bleeding off the bottom.
              nativeSize: { width: 260, height: 450 },
              layout: "contain-center",
              tile: "scaled-bottom",
              render: () => preview.calendarBox(),
            },
          ],
        }),
      renderAccessory: () => preview.swatchRow(),
    };
  }

  export function $internationalCalendars(): HTMLElement {
    const $stage = document.createElement("div");
    $stage.assignStyles({
      boxSizing: "border-box",
      width: "480px",
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: "2px",
    });

    for (const column of INTERNATIONAL_CALENDAR_COLUMNS) {
      const $column = document.createElement("div");
      $column.assignStyles({
        display: "grid",
        gap: "2px",
        minWidth: "0",
      });
      for (const slot of column) {
        $column.appendChild($internationalCalendarSlot(slot));
      }
      $stage.appendChild($column);
    }

    return $rounded($stage);
  }

  // The Lona sheet model as a small spreadsheet: real SheetCell data cells
  // (the same cell the app renders) keyed by time across the columns (month
  // headers), with each tracked thing on the left as a real row legend (the
  // sheet's legend gutter — a RowIcon + single-line label, mirroring the app's
  // std-sheet-legend-default-row), closed off from the data by a divider. The
  // two computed rows (Saved = Income − Spending, Cumulative = running total)
  // demonstrate values building on the rows above via the numbers themselves.
  export function $sheets(): HTMLElement {
    const $grid = document.createElement("div");
    $grid.assignStyles({
      boxSizing: "border-box",
      display: "grid",
      gridTemplateColumns: `${SHEET_LABEL_WIDTH}px repeat(${SHEET_MONTHS.length}, ${SHEET_MONTH_WIDTH}px)`,
      gap: "1px",
      width: "fit-content",
    });

    // Header row: empty corner (above the legend gutter) + month columns.
    $grid.appendChild($sheetCorner());
    for (const month of SHEET_MONTHS) {
      $grid.appendChild($sheetMonthHeader(month));
    }

    // Data rows: a row legend (icon + label) + one value SheetCell per month.
    for (const row of SHEET_ROWS) {
      $grid.appendChild($sheetLegend(row));
      for (const value of row.values) {
        $grid.appendChild($sheetValueCell(value));
      }
    }

    return $rounded($grid);
  }

  export function $tasks(): HTMLElement {
    const $list = EntryList.makeWith({
      items: [
        { title: "Finish Q3 planning doc", accentColor: "var(--teal)" },
        { title: "Review design system PR", accentColor: "var(--blue)" },
        { title: "Reply to investor update", accentColor: "var(--green)" },
        { title: "Book flights for the offsite", accentColor: "var(--yellow)" },
        { title: "Prep standup notes", accentColor: "var(--red)" },
        { title: "Renew the domain", accentColor: "var(--teal)" },
      ],
      display: EntryDisplay.DEFAULT,
    });
    $list.setAttribute("type", "card");
    $list.setAttribute("no-bg", "");
    $list.assignStyles({ width: "360px" });
    return $rounded($list);
  }

  // The task auto-schedule asset — the live std-proposal-list the agent surfaces
  // when it plans your tasks for you. The proposals block is the PRODUCT's
  // (tento-chat-js plan, revision 2): the chat library carries no lona block
  // and this base library never imports the chat package, so the lona app
  // registers the content at boot (`lib/brand-app/hero-proposals.ts`) and the
  // hero renders an empty stage when nothing registered — a storybook or a
  // host without the product sees the frame, not a broken import.
  let proposalListFactory: Option<() => HTMLElement> = null;
  export function registerProposalList(make: () => HTMLElement): void {
    proposalListFactory = make;
  }
  export function $proposalList(): HTMLElement {
    if (proposalListFactory) return proposalListFactory();
    const $empty = document.createElement("div");
    $empty.dataset.asset = "proposals";
    $empty.dataset.state = "unregistered";
    return $empty;
  }

  // The "all your calendars" picker — renders the SAME pure component as the app's
  // calendar sidebar (CalendarListView, the visual layer behind sheets-ui's
  // UserCalendarList) with mock multi-account data, so the asset stays
  // pixel-identical to the product. The story: every calendar you can reach —
  // across accounts, plus shared/subscribed — in one list, each independently
  // toggleable.
  export function $calendarList(): HTMLElement {
    const groups: CalendarListView.Group[] = CALENDAR_GROUPS.map((group) => ({
      header: { title: group.label, subtitle: null, icon: null },
      altHeader: null,
      rows: group.calendars.map((cal) => ({
        name: cal.name,
        $accessory: CalendarVisibilityIcon.makeWith({
          color: cal.color,
          checked: cal.visible,
          onToggle: null,
        }),
        selected: false,
        selectable: false,
        disabled: false,
        onSelect: null,
      })),
    }));
    const $list = CalendarListView.makeWith({ groups, padding: "6px 8px" });
    $list.assignStyles({ width: "300px" });
    return $rounded($list);
  }

  type MockCalendar = {
    name: string;
    color: string;
    visible: boolean;
  };

  type MockCalendarGroup = {
    label: string;
    calendars: MockCalendar[];
  };

  // Calendars across several connected accounts — a primary account ("My
  // calendars"), a second connected account (by email), and subscribed/shared
  // calendars ("Other calendars") — to make the "any of your calendars" point.
  // Colors are colors.css tokens (the app maps each calendar's colorId to one).
  const CALENDAR_GROUPS: MockCalendarGroup[] = [
    {
      label: "My calendars",
      calendars: [
        { name: "Personal", color: "var(--blue)", visible: true },
        { name: "Work", color: "var(--red)", visible: true },
        { name: "Family", color: "var(--green)", visible: true },
        { name: "Birthdays", color: "var(--yellow)", visible: false },
      ],
    },
    {
      label: "team@acme.com",
      calendars: [
        { name: "Projects", color: "var(--purple)", visible: true },
        { name: "On-call", color: "var(--orange)", visible: false },
      ],
    },
    {
      label: "Other calendars",
      calendars: [
        { name: "US Holidays", color: "var(--teal)", visible: true },
        { name: "Phases of the Moon", color: "var(--gray)", visible: false },
      ],
    },
  ];

  // The public booking page (so.lona's lona-scheduling-link-preview, served at
  // /booking/<host>/<slug>) as a mock: host sidebar + the real DatePicker (with
  // upcoming weekdays dimmed) + timezone cell + a static slot column. The
  // component owns its bordered card surface, so it is NOT wrapped in $rounded.
  export function $schedulingLink(): HTMLElement {
    return SchedulingLinkPreview.makeWith({
      name: "Lona",
      title: "Planning session",
      durationMinutes: 30,
      description:
        "Share a live link backed by the calendar you already trust.",
      timezone: "America/Los_Angeles",
      slots: [
        "9:00 AM",
        "9:30 AM",
        "10:30 AM",
        "11:00 AM",
        "2:00 PM",
        "3:30 PM",
      ],
    });
  }

  // A compact availability card — a small "pick a time" list of open slots with one
  // selected. The tasteful, accent-sized sibling of the full scheduling-link booking
  // page; the asset for scheduling / "share openings" / "book a time" messages and a
  // clean calendar accent for brand cards. Composed from the real SlotCard.
  export function $openings(): HTMLElement {
    const $card = document.createElement("div");
    $card.assignStyles({
      boxSizing: "border-box",
      width: "300px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    });

    const $head = Typography.small("Planning session · 30 min");
    $head.assignStyles({
      color: "var(--text-ter)",
      paddingInline: "8px",
      "--font-size": "var(--text-12px)",
      "--margin-top": "8px",
      "--margin-bottom": "8px",
    });
    $card.appendChild($head);

    const slots: ReadonlyArray<[string, boolean]> = [
      ["9:00 AM", false],
      ["9:30 AM", true],
      ["10:30 AM", false],
      ["2:00 PM", false],
    ];
    for (const [index, [label, current]] of slots.entries()) {
      const $slot = SlotCard.make();
      $slot.bind(label, "", current);
      $slot.assignStyles({
        "--slot-card-margin-block": "0px",
        "--slot-card-padding-block": "8px",
        "--slot-card-radius": "4px",
        "--slot-card-radius-top-left": index === 0 ? "8px" : "4px",
        "--slot-card-radius-top-right": index === 0 ? "8px" : "4px",
        "--slot-card-radius-bottom-right": index === slots.length - 1 ? "8px" : "4px",
        "--slot-card-radius-bottom-left": index === slots.length - 1 ? "8px" : "4px",
      });
      $card.appendChild($slot);
    }
    return $rounded($card);
  }

  export function $timezoneLegendStack(): HTMLElement {
    const $stack = document.createElement("div");
    $stack.setAttribute("role", "list");
    $stack.assignStyles({
      boxSizing: "border-box",
      width: "520px",
      display: "grid",
      gap: "0px",
      background: "transparent",
      color: "var(--text-sec)",
    });

    const rows: TimezoneLegendRowElements[] = [];
    for (let i = 0; i < TIMEZONE_LEGENDS.length; i++) {
      const row = $timezoneLegendRow(
        TIMEZONE_LEGENDS[i],
        i < TIMEZONE_LEGENDS.length - 1,
      );
      rows.push(row);
      $stack.appendChild(row.$root);
    }

    void $bindTimezoneLegends(rows);
    return $rounded($stack);
  }

  export function $quickAdd(): HTMLElement {
    // The quick-add asset is the spotlight panel showing the parsed-event row —
    // exactly how the app surfaces it (LonaEventsQuickAddRow inside spotlight):
    // a std-spotlight-row titled "Quick add: Create an Event" whose subtitle is
    // the shared QuickAddCard core (same component the app binds with real data).
    const $card = QuickAddCard.makeWith({
      title: "design sync",
      startLabel: "Tomorrow, 8 am",
      endLabel: "9 am",
    });
    // Show the suggested-category chip the app surfaces from the on-device
    // classifier — "design sync" → work. @tento-ui can't reach EventCategoryItem,
    // so reproduce its work mapping (emoji + BASE events token) as the plain
    // @tento-lona-free QuickAddCard.Category shape.
    $card.bindCategory({ emoji: "🧑‍💻", name: "work", color: "var(--red)" });
    // Mirror LonaEventsQuickAddRow's `#title` spacing above the card.
    const $title = SpotlightRow.$title("Quick add: Create an Event");
    $title.style.setProperty("--margin-top", "6px");
    $title.style.setProperty("--margin-bottom", "8px");
    const $panel = SpotlightPreview.makeWith({
      placeholder: "Search",
      query: "design sync tomorrow at 8am",
      // Rest state — no darker aria-selected highlight on this single preview row.
      selectedIndex: null,
      rows: [
        {
          title: $title,
          icon: () => LonaIcons.make(PlusIcon, { sizePx: 20 }),
          subtitle: $card,
        },
      ],
    });
    $panel.assignStyles({ width: "520px" });
    return $panel;
  }

  export function $habitCard(): HTMLElement {
    const today = NaiveDate.today();
    const $habit = NuxHabitCard.makeWith({
      onAddHabit: Constants.EMPTY_FUNCTION,
    });
    $habit.assignStyles({
      position: "relative",
      width: "100%",
      height: "100%",
    });
    // Wrap in the real home card so it gets the NUX header (title + caption +
    // check badge), matching how the habit card appears in the app.
    const $card = HomeGridCard.makeWith(
      {
        id: "feature-habit",
        title: "Add a new habit",
        caption: "Getting Started",
        card: {
          $content: $habit,
          contentBg: "var(--bg-surface-light)",
          bg: "var(--bg-hover-opaque)",
          backBg: "var(--teal-dimmed)",
        },
        list: { $content: null, $accessory: null },
        $badge: () =>
          RowIcon.make().bind(
            { icon: null },
            { icon: LonaIcons.$template(CheckSquareIcon) },
            16,
          ),
        date: NaiveDate.Partial.fromDate(today),
        localDate: today,
        checked: false,
        hasShadow: true,
        onStateChange: Constants.EMPTY_FUNCTION,
      },
      150,
    );
    $card.toggleMode("cards", false);
    $card.assignStyles({ width: "240px", height: "400px" });
    return $card;
  }

  export function $spotlightActions(): SpotlightPreview {
    const $spotlight = SpotlightPreview.makeWith({
      placeholder: "Search",
      query: null,
      selectedIndex: 0,
      rows: [
        {
          title: "Dark Mode",
          icon: () => LonaIcons.make(MoonIcon, { sizePx: 20 }),
          subtitle: null,
        },
        {
          title: "Home",
          icon: LonaCardIcon.make.bind(LonaCardIcon),
          subtitle: null,
        },
        {
          title: "Tasks",
          icon: TasksIcon.make.bind(TasksIcon),
          subtitle: null,
        },
        {
          title: "Sheets",
          icon: SheetsIcon.make.bind(SheetsIcon),
          subtitle: null,
        },
        {
          title: "Themes",
          icon: LonaThemePickerIcon.make.bind(LonaThemePickerIcon),
          subtitle: null,
        },
      ],
    });
    $spotlight.assignStyles({ width: "440px" });
    return $spotlight;
  }

  export function $flightCard(): HTMLElement {
    const $frame = document.createElement("div");
    $frame.assignStyles({
      width: "360px",
      height: "220px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    const $card = FlightStatusCard.make();
    $card.assignStyles({ width: "360px" });
    // Reserve the card's full height up front: the hero tiling engine measures
    // the asset once on mount and centers against that height. Timezone regions
    // load async (below), so without a full-height loading skeleton the engine
    // would measure the empty card and the late bind would shift it off-center.
    $card.bindLoading();
    // Timezone regions load async; bind once they resolve. The loading skeleton
    // keeps the measured card size stable until then.
    void $bindFlightCard($card);
    $frame.appendChild($card);
    return $frame;
  }

  // The real WeatherTooltip card as the crisp focal point, floating over a field
  // of weather emojis that sit behind / overlap it — as though the weather
  // originates from the card. The scatter layer is adapted from the pomodoro
  // timer's decoration layer (lib/pomodoro/components/timer-page.ts): a
  // data-driven array of absolutely-positioned emoji, each with its own
  // rotate/scale + blur for depth. Static (no progress animation): a frozen
  // burst frame, consistent with the other catalog assets.
  export function $weather(): HTMLElement {
    // The wrapper shrink-wraps the tooltip (the in-flow child), so the asset
    // measures as the card itself — the emoji overlay is absolute/out-of-flow
    // and contributes nothing to the measured size.
    const $stage = document.createElement("div");
    $stage.assignStyles({
      position: "relative",
      width: "fit-content",
      overflow: "visible",
    });

    // Two emoji overlay layers, both absolute/out-of-flow (they add nothing to
    // the measured size). Most glyphs sit BEHIND the card (z 0) so they read as
    // emanating from it; a few `front` glyphs sit ABOVE it (z 2), overlapping
    // its corners. The layers must be separate siblings of the z-1 card: a
    // single z-0 layer establishes its own stacking context, so its children
    // would paint below the card regardless of their per-child z-index.
    const $back = $weatherScatterLayer("0");
    const $front = $weatherScatterLayer("2");
    for (const deco of WEATHER_SCATTER) {
      (deco.front ? $front : $back).appendChild($weatherEmoji(deco));
    }

    // The tooltip owns its own card surface (radius, shadow, bg-elevated), so it
    // renders in flow (defining the size) and z-indexed between the two scatter
    // layers — the emoji behind read as a backdrop, the `front` ones overlap on
    // top of the card.
    const $tooltip = WeatherTooltip.makeWith({
      condition: { code: 1000 },
      avgtempF: 72,
      maxtempF: 80,
      mintempF: 65,
      avghumidity: 50,
      uv: 6,
    });
    $tooltip.assignStyles({ position: "relative", zIndex: "1" });

    $stage.append($back, $tooltip, $front);
    return $stage;
  }

  // An absolute, full-bleed, click-through overlay layer for $weather scatter
  // glyphs at a given z-index (sibling to the card).
  function $weatherScatterLayer(zIndex: string): HTMLElement {
    const $layer = document.createElement("div");
    $layer.assignStyles({
      position: "absolute",
      inset: "0px",
      zIndex,
      pointerEvents: "none",
    });
    return $layer;
  }

  // One scattered weather glyph, positioned as a fraction of the card box with
  // its own depth styling (scale / rotate / opacity / blur).
  function $weatherEmoji(deco: WeatherDeco): HTMLElement {
    const $emoji = document.createElement("div");
    $emoji.textContent = deco.emoji;
    // Depth of field: glyphs at WEATHER_FOCAL are sharp; blur grows with how far
    // the glyph's distance sits from that focal plane (nearer OR farther),
    // clamped so an extreme focal choice can't smear a glyph away entirely.
    const blur = Math.min(
      WEATHER_MAX_BLUR,
      WEATHER_APERTURE * Math.abs(deco.distance - WEATHER_FOCAL),
    );
    $emoji.assignStyles({
      position: "absolute",
      left: `${deco.x * 100}%`,
      top: `${deco.y * 100}%`,
      fontSize: "60px",
      lineHeight: "1",
      opacity: `${deco.opacity}`,
      filter: `blur(${blur}px)`,
      transform: `translate(-50%, -50%) rotate(${deco.rotate}deg) scale(${deco.scale})`,
    });
    return $emoji;
  }

  export function $personalAnalyticsChart(): HTMLElement {
    return $rounded(LineChartPreview.makePersonalAnalytics());
  }

  // The one screenshot asset class: a real app capture served from so.lona
  // static assets (/@/static/img/...). The <img> fills its stage; native sizing
  // comes from the image's pixel dimensions declared in the library.
  export function $screenshot(src: string): HTMLImageElement {
    const $img = document.createElement("img");
    $img.src = src;
    $img.alt = "";
    $img.setAttribute("loading", "lazy");
    $img.assignStyles({
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "cover",
    });
    return $img;
  }

  // A stand-in for a concept that has no real asset component yet. Renders a
  // solid-fill card showing the asset label + its hero/<id> path, mirroring the
  // placeholder overlay in FeatureCardHeroImagePlaceholder. Carries an explicit
  // pixel size so the flat /gtm asset grid (which measures + scales the content)
  // doesn't collapse it to 0x0. Swap makeContent to a real factory when the
  // visual exists.
  export function $placeholder(spec: {
    label: string;
    id: string;
    fill: string;
    textColor: string;
    size: Size;
  }): HTMLElement {
    const $box = document.createElement("div");
    $box.assignStyles({
      boxSizing: "border-box",
      width: `${spec.size.width}px`,
      height: `${spec.size.height}px`,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "28px",
      borderRadius: "18px",
      overflow: "hidden",
      background: spec.fill,
      color: spec.textColor,
    });

    const $label = Typography.small(spec.label);
    $label.assignStyles({
      "--font-size": "var(--text-48px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      fontWeight: "700",
    });

    const $footer = document.createElement("div");
    $footer.assignStyles({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });

    const $id = Typography.small(`hero/${spec.id}`);
    $id.assignStyles({
      "--font-size": "var(--text-24px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      opacity: "0.72",
    });

    const $needs = Typography.small("Needs visual");
    $needs.assignStyles({
      "--font-size": "var(--text-20px)",
      "--line-height-ratio": "1.1",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      opacity: "0.55",
    });

    $footer.append($id, $needs);
    $box.append($label, $footer);
    return $box;
  }

  // Wrap a bare component in a rounded squircle card surface so it reads as a
  // self-contained card. Padding insets the content from the rounded corners.
  function $rounded($content: HTMLElement): HTMLElement {
    const $round = Round.makeWithContent($content, {
      bg: "var(--bg)",
      radius: 22,
      shadow: "0 12px 32px color-mix(in srgb, var(--text-pri) 9%, transparent)",
    });
    // Shrink to the wrapped component's intrinsic size (the preview measures +
    // scales the whole rounded card).
    $round.assignStyles({
      width: "fit-content",
      padding: "10px",
      boxSizing: "border-box",
    });
    return $round;
  }

  // Weather-emoji scatter for $weather. x/y are fractions of the CARD box
  // (0 = top/left edge, 1 = bottom/right edge); centres hug / straddle the
  // perimeter, and some are pushed well past it (negative / >1) so they sit
  // further out. Glyphs match the app's weather condition map (weather-cell.ts)
  // plus a few complementary ones. The field is layered into depth tiers so the
  // scatter reads as a 3D burst rather than a flat ring: glyphs vary widely in
  // size (scale), sharpness (blur), fade (opacity) and distance from the card.
  //   • focal   — sharpest, most opaque, hugging the edges; mixed sizes.
  //   • mid      — a touch of blur, slightly further out.
  //   • distant  — small, faint, heavily blurred, pushed past the perimeter.
  //   • halo     — large, very soft, low-opacity glow behind the card.
  type WeatherDeco = {
    emoji: string;
    x: number;
    y: number;
    scale: number;
    rotate: number;
    opacity: number;
    // Camera distance, 0 (nearest the viewer) … 1 (farthest). Blur is derived
    // from |distance − WEATHER_FOCAL|; it is not authored per glyph.
    distance: number;
    // When true the glyph renders ABOVE the card (overlapping it); otherwise
    // behind it.
    front: boolean;
  };

  // Depth-of-field knobs for the weather scatter. Each glyph carries a
  // `distance` (0 near … 1 far); its blur is APERTURE × |distance − FOCAL|,
  // clamped to MAX_BLUR. Move FOCAL to choose what's in focus: 0.12 keeps the
  // near corners + front focal glyphs crisp and blurs the deep halos; raise it
  // toward ~0.6 to focus deeper and let the near glyphs blur instead.
  const WEATHER_FOCAL = 0.12;
  const WEATHER_APERTURE = 9;
  const WEATHER_MAX_BLUR = 8;

  const WEATHER_SCATTER: WeatherDeco[] = [
    // ── Focal: crisp, close, varied size (big accent → small detail) ──────────
    {
      emoji: "☀️",
      x: -0.34,
      y: 0.5,
      scale: 1.18,
      rotate: -12,
      opacity: 0.97,
      distance: 0.16,
      front: false,
    },
    {
      emoji: "🌤️",
      x: 1.28,
      y: 0.47,
      scale: 1.1,
      rotate: 11,
      opacity: 0.92,
      distance: 0.2,
      front: false,
    },
    {
      emoji: "⛅️",
      x: -0.58,
      y: 0.68,
      scale: 0.74,
      rotate: -8,
      opacity: 0.9,
      distance: 0.22,
      front: false,
    },
    {
      emoji: "🌈",
      x: 1.44,
      y: 0.82,
      scale: 1.0,
      rotate: 6,
      opacity: 0.88,
      distance: 0.3,
      front: false,
    },
    {
      emoji: "❄️",
      x: 0.96,
      y: 0.97,
      scale: 0.68,
      rotate: 14,
      opacity: 0.85,
      distance: 0.1,
      front: true,
    },
    // ── Mid: softer, a step further out, medium glyphs ────────────────────────
    {
      emoji: "☁️",
      x: 0.38,
      y: 0.36,
      scale: 1.2,
      rotate: -4,
      opacity: 0.78,
      distance: 0.45,
      front: false,
    },
    {
      emoji: "⛈️",
      x: 0.04,
      y: 0.97,
      scale: 1.05,
      rotate: 8,
      opacity: 0.74,
      distance: 0.1,
      front: true,
    },
    {
      emoji: "🌧️",
      x: 0.44,
      y: 1.13,
      scale: 0.92,
      rotate: -6,
      opacity: 0.72,
      distance: 0.5,
      front: false,
    },
    {
      emoji: "🌦️",
      x: -0.48,
      y: 0.88,
      scale: 0.88,
      rotate: -11,
      opacity: 0.7,
      distance: 0.52,
      front: false,
    },
    // ── Distant: small, faint, heavily blurred, pushed past the perimeter ─────
    {
      emoji: "🌧️",
      x: 1.68,
      y: 0.55,
      scale: 0.54,
      rotate: 9,
      opacity: 0.46,
      distance: 0.7,
      front: false,
    },
    {
      emoji: "☀️",
      x: 1.6,
      y: 0.36,
      scale: 0.6,
      rotate: 6,
      opacity: 0.5,
      distance: 0.72,
      front: false,
    },
    {
      emoji: "❄️",
      x: -0.6,
      y: 1.13,
      scale: 0.48,
      rotate: -10,
      opacity: 0.42,
      distance: 0.78,
      front: false,
    },
    {
      emoji: "☁️",
      x: -0.57,
      y: 0.38,
      scale: 0.64,
      rotate: -6,
      opacity: 0.48,
      distance: 0.68,
      front: false,
    },
    // ── Halo: large, very soft glow behind the card for depth ─────────────────
    {
      emoji: "☁️",
      x: 0.5,
      y: 0.52,
      scale: 2.0,
      rotate: -3,
      opacity: 0.3,
      distance: 1.0,
      front: false,
    },
    {
      emoji: "☀️",
      x: 0.56,
      y: 0.99,
      scale: 1.7,
      rotate: 5,
      opacity: 0.33,
      distance: 0.95,
      front: false,
    },
  ];

  type InternationalCalendarSlot = {
    label: string;
  };

  // Each column is the same Gregorian day expressed through several calendar
  // systems. The anchor dates are 2026-06-15 through 2026-06-17.
  const INTERNATIONAL_CALENDAR_COLUMNS: InternationalCalendarSlot[][] = [
    [
      { label: "Mon 15" },
      { label: "五月初一" },
      { label: "15 มิ.ย." },
      { label: "٣٠ ذو الحجة" },
      { label: "30 בסיון" },
    ],
    [
      { label: "Tue 16" },
      { label: "五月初二" },
      { label: "16 มิ.ย." },
      { label: "١ محرم" },
      { label: "1 בתמוז" },
    ],
    [
      { label: "Wed 17" },
      { label: "五月初三" },
      { label: "17 มิ.ย." },
      { label: "٢ محرم" },
      { label: "2 בתמוז" },
    ],
  ];

  function $internationalCalendarSlot(
    slot: InternationalCalendarSlot,
  ): SlotCard {
    const $card = SlotCard.make();
    $card.bind(slot.label, "", false);
    $card.toggleAttribute("centered", true);
    $card.toggleAttribute("always-bg", true);
    $card.assignStyles({
      minWidth: "0",
      "--slot-card-padding-block": "12px",
    });
    return $card;
  }

  // ── $sheets data + cell builders ──────────────────────────────────────────
  const SHEET_MONTHS = ["Jan", "Feb", "Mar", "Apr"];
  const SHEET_LABEL_WIDTH = 140;
  const SHEET_MONTH_WIDTH = 82;
  const SHEET_HEADER_HEIGHT = 30;
  const SHEET_ROW_HEIGHT = 44;

  type SheetRowSpec = {
    label: string;
    // The row's icon — the standard preset glyph for the row's type, uncolored
    // (RowIcon's default --text-ter): NumberIcon for typed number rows,
    // FormulaIcon for computed rows. Same icons the app's renderers bind
    // (column-number.ts / source-formula.ts).
    icon: LonaIcons.RawSvg;
    // One value per SHEET_MONTHS entry. Typed for Income/Spending; computed
    // (the displayed result) for the formula rows.
    values: string[];
    // Set on computed rows. null on typed rows.
    formula: Option<string>;
  };

  const SHEET_ROWS: SheetRowSpec[] = [
    {
      label: "Income",
      icon: NumberIcon,
      values: ["4,200", "4,200", "4,400", "4,400"],
      formula: null,
    },
    {
      label: "Spending",
      icon: NumberIcon,
      values: ["2,600", "2,400", "2,900", "2,500"],
      formula: null,
    },
    {
      label: "Saved",
      icon: FormulaIcon,
      values: ["1,600", "1,800", "1,500", "1,900"],
      formula: "=B1−B2",
    },
    {
      label: "Cumulative",
      icon: FormulaIcon,
      values: ["1,600", "3,400", "4,900", "6,800"],
      formula: "=B4+C3",
    },
  ];

  // The empty corner above the legend gutter (the legend column has no header).
  function $sheetCorner(): HTMLElement {
    const $cell = document.createElement("div");
    $cell.assignStyles({
      boxSizing: "border-box",
      height: `${SHEET_HEADER_HEIGHT}px`,
      borderRight: "1px solid var(--divider)",
    });
    return $cell;
  }

  // A month column header — plain centered label on the sheet surface (the
  // timeline header sits above the data cells, not inside a card).
  function $sheetMonthHeader(month: string): HTMLElement {
    const $cell = document.createElement("div");
    $cell.assignStyles({
      boxSizing: "border-box",
      height: `${SHEET_HEADER_HEIGHT}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    const $text = $sheetText(month, "var(--text-10px)", "var(--text-sec)");
    $text.assignStyles({ fontWeight: "600" });
    $cell.appendChild($text);
    return $cell;
  }

  // A row legend for the gutter, mirroring the app's std-sheet-legend-default-row
  // (which lives in sheets-ui and needs a live SDK row to bind, so it can't be
  // used directly from this @tento-ui asset): the real RowIcon — rendering the
  // row's standard preset glyph (via the plugin-icon path) in the default
  // uncolored --text-ter, exactly as a real row legend renders its icon — then a
  // flex-grow label-container with the label as a single-line Typography.small in
  // --text-sec. A divider closes the legend column off from the data cells. Built
  // directly (no SheetCell) so it renders synchronously.
  function $sheetLegend(row: SheetRowSpec): HTMLElement {
    const $root = document.createElement("div");
    $root.assignStyles({
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      height: `${SHEET_ROW_HEIGHT}px`,
      paddingRight: "8px",
      borderRight: "1px solid var(--divider)",
    });

    const $icon = RowIcon.make().bind(
      { icon: null },
      { icon: LonaIcons.$template(row.icon) },
      16,
    );

    // Mirrors std-sheet-legend-default-row's #label-container (single line).
    const $labelContainer = document.createElement("div");
    $labelContainer.assignStyles({
      boxSizing: "border-box",
      flex: "1 1 auto",
      minWidth: "0",
      display: "flex",
      alignItems: "center",
      paddingInline: "8px",
      marginLeft: "1px",
    });

    const $label = Typography.small(row.label);
    $label.assignStyles({
      color: "var(--text-sec)",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      "--line-height-ratio": "1.1",
      whiteSpace: "nowrap",
    });
    $labelContainer.appendChild($label);

    $root.appendChild($icon);
    $root.appendChild($labelContainer);
    return $root;
  }

  function $sheetValueCell(value: string) {
    const $text = $sheetText(value, "var(--text-11px)", "var(--text-pri)");
    return $sheetCell($sheetContent([$text], "center"), SHEET_ROW_HEIGHT);
  }

  // A real SheetCell with the catalog's static layout: a borderless filled card
  // (canDrawCardBorder:false — the app's own default, e.g.
  // sheets-ui/.../default-binder-helpers.ts). Content is appended SYNCHRONOUSLY
  // (not via bindContent's deferred $$.mutate) so the value renders immediately,
  // independent of any later fastdom flush. Height must be set or the cell
  // collapses (#root sizes from --height).
  function $sheetCell($content: HTMLElement, height: number) {
    const $cell = SheetCell.make();
    $cell.bindLayoutOptions(
      {
        card: true,
        canDrawCardBorder: false,
        marginInline: "0px",
        marginBlock: "0px",
      },
      false,
    );
    $cell.bindHeight(height);
    $cell.appendChild($content);
    return $cell;
  }

  function $sheetContent(
    $children: HTMLElement[],
    align: "center" | "flex-start",
  ): HTMLElement {
    const $wrap = document.createElement("div");
    $wrap.assignStyles({
      boxSizing: "border-box",
      flex: "1 1 auto",
      minHeight: "0",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: align,
      gap: "2px",
      width: "100%",
      height: "100%",
      padding: "6px 10px",
      textAlign: align === "center" ? "center" : "start",
    });
    $wrap.append(...$children);
    return $wrap;
  }

  function $sheetText(
    text: string,
    fontSize: string,
    color: string,
  ): HTMLElement {
    const $text = Typography.p(text);
    $text.assignStyles({
      "--font-size": fontSize,
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      "--line-height-ratio": "1.1",
      color,
    });
    return $text;
  }

  type TimezoneLegendSpec = {
    tzname: Tzname;
    fallbackTime: string;
    fallbackDate: string;
    fallbackOffset: string;
    fallbackIndicator: string;
  };

  type TimezoneLegendRowElements = {
    spec: TimezoneLegendSpec;
    $root: HTMLElement;
    $tzname: HTMLElement;
    $offset: HTMLElement;
    $localTime: HTMLElement;
    $localDate: HTMLElement;
    $timeIndicator: HTMLElement;
  };

  const TIMEZONE_LEGENDS: TimezoneLegendSpec[] = [
    {
      tzname: "America/Los_Angeles" as Tzname,
      fallbackTime: "9:30a",
      fallbackDate: "Thu, Jun 18",
      fallbackOffset: "PDT  -7:00",
      fallbackIndicator: "var(--green)",
    },
    {
      tzname: "America/New_York" as Tzname,
      fallbackTime: "12:30p",
      fallbackDate: "Thu, Jun 18",
      fallbackOffset: "EDT  -4:00",
      fallbackIndicator: "var(--green)",
    },
    {
      tzname: "Europe/London" as Tzname,
      fallbackTime: "5:30p",
      fallbackDate: "Thu, Jun 18",
      fallbackOffset: "BST  +1:00",
      fallbackIndicator: "var(--yellow)",
    },
    {
      tzname: "Asia/Tokyo" as Tzname,
      fallbackTime: "1:30a",
      fallbackDate: "Fri, Jun 19",
      fallbackOffset: "JST  +9:00",
      fallbackIndicator: "var(--red)",
    },
    {
      tzname: "Australia/Sydney" as Tzname,
      fallbackTime: "2:30a",
      fallbackDate: "Fri, Jun 19",
      fallbackOffset: "AEST  +10:00",
      fallbackIndicator: "var(--red)",
    },
  ];

  const TIMEZONE_LEGEND_UTC = "2026-06-18T16:30:00Z";

  function $timezoneLegendRow(
    spec: TimezoneLegendSpec,
    showDivider: boolean,
  ): TimezoneLegendRowElements {
    const $root = document.createElement("div");
    $root.setAttribute("role", "listitem");
    $root.setAttribute("data-source-element", "lona-timezone-plugin-legend");
    $root.assignStyles({
      boxSizing: "border-box",
      width: "100%",
      minHeight: "58px",
      display: "flex",
      alignItems: "center",
      paddingInlineStart: "4px",
      paddingInlineEnd: "8px",
      borderBottom: showDivider ? "1px solid var(--divider)" : "0px",
      background: "transparent",
    });

    const $label = document.createElement("div");
    $label.assignStyles({
      minWidth: "0",
      flex: "1 1 auto",
      display: "grid",
      gap: "8px",
    });

    const $tzname = $timezoneLegendText(spec.tzname, "header");
    const $offset = $timezoneLegendText(spec.fallbackOffset, "caption");
    $label.append($tzname, $offset);

    const $spacer = document.createElement("div");
    $spacer.assignStyles({ width: "12px", flexShrink: "0" });

    const $timeColumn = document.createElement("div");
    $timeColumn.assignStyles({
      flex: "0 0 106px",
      display: "grid",
      gap: "8px",
      justifyItems: "end",
    });

    const $timeLine = document.createElement("div");
    $timeLine.assignStyles({
      display: "flex",
      alignItems: "center",
      justifyContent: "end",
      gap: "6px",
      width: "100%",
    });

    const $localTime = $timezoneLegendText(spec.fallbackTime, "header");
    $localTime.assignStyles({ textAlign: "end" });

    const $timeIndicator = document.createElement("div");
    $timeIndicator.assignStyles({
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      flexShrink: "0",
      background: spec.fallbackIndicator,
    });
    $timeLine.append($localTime, $timeIndicator);

    const $localDate = $timezoneLegendText(spec.fallbackDate, "caption");
    $localDate.assignStyles({ textAlign: "end" });
    $timeColumn.append($timeLine, $localDate);

    $root.append($label, $spacer, $timeColumn);

    return {
      spec,
      $root,
      $tzname,
      $offset,
      $localTime,
      $localDate,
      $timeIndicator,
    };
  }

  function $timezoneLegendText(
    text: string,
    kind: "header" | "caption",
  ): HTMLElement {
    const $text = Typography.p(text);
    $text.assignStyles({
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      "--line-height-ratio": "1.1",
      "--font-size":
        kind === "header" ? "var(--small-size)" : "var(--text-8px)",
      color: kind === "header" ? "var(--text-sec)" : "var(--text-ter)",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    return $text;
  }

  async function $bindTimezoneLegends(
    rows: TimezoneLegendRowElements[],
  ): Promise<void> {
    try {
      const baseUtc = DateTime.fromRfc3339(TIMEZONE_LEGEND_UTC).exp();
      for (const row of rows) {
        const tz = await TimezoneRegion.get(row.spec.tzname);
        const local = tz.toTz(baseUtc);
        const tzname = local.tz.info.tzname ?? row.spec.tzname;
        const offset = timezoneLegendOffset(local);
        const localTime = timezoneLegendTime(local);
        const localDate = timezoneLegendDate(local);
        const indicator = timezoneLegendIndicator(local.time.hrs);
        $$.mutate(() => {
          row.$tzname.textContent = tzname;
          row.$offset.textContent = offset;
          row.$localTime.textContent = localTime;
          row.$localDate.textContent = localDate;
          row.$timeIndicator.style.background = indicator;
        });
      }
    } catch {
      // Keep the baked fallback labels visible when timezone tables are offline.
    }
  }

  function timezoneLegendTime(dt: DateTime<FixedOffset>): string {
    const hrs = dt.time.hrs;
    const mins = dt.time.mins;
    const hrs12 = hrs % 12 || 12;
    const period = hrs >= 12 ? "p" : "a";
    return `${hrs12}:${String(mins).padStart(2, "0")}${period}`;
  }

  function timezoneLegendDate(dt: DateTime<FixedOffset>): string {
    return NaiveDate.Formatter.render(dt.date, {
      dateFormat: "month-day",
      shortMonth: true,
      includeWeekday: true,
    });
  }

  function timezoneLegendIndicator(hrs: number): string {
    if (hrs >= 22 || hrs < 5) return "var(--red)";
    if (hrs >= 8 && hrs < 17) return "var(--green)";
    return "var(--yellow)";
  }

  function timezoneLegendOffset(dt: DateTime<FixedOffset>): string {
    const tzabbr = dt.tz.info.tzabbr;
    const offset = dt.tz.info.offset.toString();
    return (tzabbr && tzabbr !== "%z" ? `${tzabbr}  ` : "") + offset;
  }

  async function $bindFlightCard($card: FlightStatusCard): Promise<void> {
    const departureTz = await TimezoneRegion.get(
      "America/Los_Angeles" as Tzname,
    );
    const arrivalTz = await TimezoneRegion.get("America/New_York" as Tzname);
    const now = Local.now().withTime();
    const departure = new DateTimeRegion(
      DateTime.fromMse(now.add({ hrs: 9, mins: 5 }).mse, Utc).ndt,
      departureTz,
    );
    const arrival = new DateTimeRegion(
      DateTime.fromMse(now.add({ hrs: 14, mins: 35 }).mse, Utc).ndt,
      arrivalTz,
    );
    const time = new DateTimeRegion.Range(departure, arrival);
    $$.mutate(() => {
      $card.bind({
        title: "SFO → JFK",
        time,
        onSectionClick: null,
      });
    });
  }
}
