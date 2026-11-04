import type { DateTime, DateUnit, TimezoneRegion, Utc } from "@tento-chrono";

/**
 * `ListItem` — the source-agnostic viewmodel for one row of an `EntryList`.
 *
 * Renderers map their own data-model (events, stickers, tasks, …) into this
 * shape via their own `toProps`; `ListItem` itself must NOT know about any
 * data-model. Per-item fields only — list-level formatting context
 * (`timeScale`/`use24Hour`/`dateFormat`) is passed separately as `EntryDisplay`.
 */
export type ListItem = {
  id?: Option<string>;
  title: string;
  /** Leading 4px accent bar (e.g. a calendar color or task-status color). Omit = no bar. */
  accentColor?: Option<string>;
  /** The instant a trailing time renders from. Omit = no time (e.g. tasks). */
  at?: Option<DateTime<Utc>>;
  timezone?: Option<TimezoneRegion>;
  isEditable?: boolean;
  onClick?: Option<() => void>;
};

/** List-level display context for formatting each row's `at` (one per list). */
export type EntryDisplay = {
  timeScale: DateUnit.Type;
  use24Hour: boolean;
  dateFormat: "month-day" | "day-month";
};

export namespace EntryDisplay {
  export const DEFAULT: EntryDisplay = {
    timeScale: "day",
    use24Hour: false,
    dateFormat: "month-day",
  };
}
