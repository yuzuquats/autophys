/**
 * The DOM layer's debug flags (performance levers under A/B), read one way
 * with one lifetime. Most are booleans (`read`); a tunable size is a whole
 * number (`readCount`).
 *
 * - **Source:** a `?flag:<name>=true|false` URL parameter, else localStorage
 *   `debug-flag:<name>`, else the caller's default.
 * - **Lifetime:** the page's value is read once per name (the first `read`)
 *   and kept for the page; a flag flipped in storage applies on reload.
 *   Callers read at use time, not at construction, so a harness override
 *   applies to every later read whatever object asks.
 * - **Harness override:** `armForHarness(name, value)` replaces the page
 *   value for every later read; `armForHarness(name, null)` clears it.
 * - **Debug surfaces:** `describe` / `describeCount` answer what a flag runs
 *   on this page and where that came from, by this rule, so a profile never
 *   re-reads the sources itself.
 */
export namespace DomFlags {
  /** Where a page value comes from: `?flag:<name>`, `debug-flag:<name>` storage, or the caller's default. */
  export type PageSource = "url" | "storage" | "default";
  /** Where the value a flag runs comes from: a harness override, else the page value's source. */
  export type Source = "harness" | PageSource;

  /** A value with the source it was read from. */
  export type Read<T> = { readonly value: T; readonly source: PageSource };

  /**
   * What a flag runs on this page, for a debug surface. `value` is exactly
   * what `read` / `readCount` answer and `source` says where it came from;
   * `pageValue` / `pageSource` are the page value read once (what runs when no
   * harness override is set); `onReload` is what the URL and storage say now,
   * which the next page load reads (it differs from `value` after a toggle
   * written to storage since the page read the flag).
   */
  export type Description<T> = {
    readonly value: T;
    readonly source: Source;
    readonly pageValue: T;
    readonly pageSource: PageSource;
    readonly onReload: Read<T>;
  };

  const page = new Map<string, boolean>();
  const armed = new Map<string, boolean>();
  const pageCounts = new Map<string, number>();
  const armedCounts = new Map<string, number>();
  /** Each page value's source, kept beside it at the one read. */
  const pageSources = new Map<string, PageSource>();
  const pageCountSources = new Map<string, PageSource>();

  function readRaw(name: string): { raw: string | null; source: PageSource } {
    const override = new URLSearchParams(globalThis.location?.search ?? "").get(`flag:${name}`);
    if (override != null) return { raw: override, source: "url" };
    const stored = globalThis.localStorage?.getItem(`debug-flag:${name}`) ?? null;
    return stored != null ? { raw: stored, source: "storage" } : { raw: null, source: "default" };
  }

  /** The URL and storage as they are now: a boolean is on only for "true". */
  function readNow(name: string, fallback: boolean): Read<boolean> {
    try {
      const { raw, source } = readRaw(name);
      return raw == null ? { value: fallback, source } : { value: raw === "true", source };
    } catch (_error) {
      return { value: fallback, source: "default" };
    }
  }

  /** The URL and storage as they are now: a count that is not a whole number reads as `fallback`. */
  function readCountNow(name: string, fallback: number): Read<number> {
    try {
      const { raw, source } = readRaw(name);
      return { value: parseCount(raw, fallback), source };
    } catch (_error) {
      return { value: fallback, source: "default" };
    }
  }

  /** The page value, read once per name. */
  function pageValue(name: string, fallback: boolean): boolean {
    let value = page.get(name);
    if (value === undefined) {
      const first = readNow(name, fallback);
      value = first.value;
      page.set(name, value);
      pageSources.set(name, first.source);
    }
    return value;
  }

  /** The page's whole-number value, read once per name. */
  function pageCount(name: string, fallback: number): number {
    let value = pageCounts.get(name);
    if (value === undefined) {
      const first = readCountNow(name, fallback);
      value = first.value;
      pageCounts.set(name, value);
      pageCountSources.set(name, first.source);
    }
    return value;
  }

  /** The flag's value: the harness override, else the page value (read once), else `fallback`. */
  export function read(name: string, fallback: boolean): boolean {
    const override = armed.get(name);
    return override !== undefined ? override : pageValue(name, fallback);
  }

  /** `raw` as a whole number of at least 0 (surrounding blanks allowed), else `fallback`. */
  export function parseCount(raw: string | null, fallback: number): number {
    const text = raw?.trim() ?? "";
    return /^\d{1,6}$/.test(text) ? Number(text) : fallback;
  }

  /**
   * A whole-number flag (`?flag:<name>=20`, else localStorage
   * `debug-flag:<name>`): the harness override, else the page value (read
   * once), else `fallback`. A value that is not a whole number reads as
   * `fallback`.
   */
  export function readCount(name: string, fallback: number): number {
    const override = armedCounts.get(name);
    return override !== undefined ? override : pageCount(name, fallback);
  }

  /**
   * What `read(name, fallback)` answers on this page, where it came from, and
   * what a reload would read. Reads the page value once if nothing has yet,
   * as `read` would.
   */
  export function describe(name: string, fallback: boolean): Description<boolean> {
    const value = pageValue(name, fallback);
    const pageSource = pageSources.get(name) ?? "default";
    const override = armed.get(name);
    return {
      value: override ?? value,
      source: override !== undefined ? "harness" : pageSource,
      pageValue: value,
      pageSource,
      onReload: readNow(name, fallback),
    };
  }

  /**
   * `describe` for a whole-number flag: what `readCount(name, fallback)`
   * answers, where it came from, and what a reload would read.
   */
  export function describeCount(name: string, fallback: number): Description<number> {
    const value = pageCount(name, fallback);
    const pageSource = pageCountSources.get(name) ?? "default";
    const override = armedCounts.get(name);
    return {
      value: override ?? value,
      source: override !== undefined ? "harness" : pageSource,
      pageValue: value,
      pageSource,
      onReload: readCountNow(name, fallback),
    };
  }

  /**
   * Override `name` for every later read (tests and harnesses): a boolean for
   * `read`, a number for `readCount`; `null` clears both overrides.
   */
  export function armForHarness(name: string, value: boolean | number | null): void {
    armed.delete(name);
    armedCounts.delete(name);
    if (typeof value === "number") armedCounts.set(name, value);
    else if (value != null) armed.set(name, value);
  }
}
