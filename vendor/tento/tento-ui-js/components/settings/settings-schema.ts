import { SettingsBody } from "./settings-body";
import type { SettingsNavigate } from "./settings-navigate";
import { SettingsRow } from "./settings-row";
import { SettingsSection } from "./settings-section";
import { SettingsSummary } from "./settings-summary";

// Settings described as data, and turned into elements. The types are shared
// by the page (which renders a destination when it is pushed), the row (whose
// `page` is a destination) and the `Settings` builders, which is why they
// live here rather than in settings.ts: the page and row cannot import that
// module without a cycle.
//
// Every list accepts elements beside descriptions — a product's own section
// next to described ones, a custom row in a described section — and skips
// falsy entries, so `isAdmin && { … }` includes a row conditionally.
export namespace SettingsSchema {
  export type Falsy = false | null | undefined;

  export type Row = SettingsRow.Props;

  export type Section = SettingsSection.Props & {
    rows: (Row | HTMLElement | Falsy)[];
  };

  export type Schema = {
    summary?: Option<SettingsSummary.Item[]>;
    sections: (Section | HTMLElement | Falsy)[];
  };

  /** What a page shows: a description, or an element the caller built. */
  export type Content = Schema | HTMLElement;

  export type Destination = SettingsNavigate.Destination<Content>;

  export function section(section: Section): SettingsSection {
    const $section = SettingsSection.makeWith(section);
    $section.append(...present(section.rows).map(row));
    return $section;
  }

  export function row(row: Row | HTMLElement): HTMLElement {
    return row instanceof HTMLElement ? row : SettingsRow.makeWith(row);
  }

  export function render(schema: Schema): SettingsBody {
    const $children: HTMLElement[] = [];
    if (schema.summary?.length) {
      $children.push(SettingsSummary.makeWith(schema.summary));
    }
    for (const entry of present(schema.sections)) {
      $children.push(entry instanceof HTMLElement ? entry : section(entry));
    }
    return SettingsBody.makeWith(...$children);
  }

  /** The element a destination shows, building it only now. */
  export function resolve(content: Content | (() => Content)): HTMLElement {
    const value = typeof content === "function" ? content() : content;
    return value instanceof HTMLElement ? value : render(value);
  }

  function present<T>(entries: (T | Falsy)[]): T[] {
    return entries.filter((entry): entry is T => entry != null && entry !== false);
  }
}
