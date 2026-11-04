import { LiveData } from "@tento-core/livedata";

const STORAGE_PREFIX = "debug-flag:";

/**
 * The debug menu's toggles. Not `DomFlags` (dom-flags.ts), on purpose: a
 * `DomFlags` flag is a performance lever under A/B, read once per page with a
 * harness override; a `Flags.Debug` is a user-facing toggle that is live
 * (`signal`) and writes itself back to localStorage when set. Both read the
 * same `?flag:<key>` / `debug-flag:<key>` sources.
 */
export namespace Flags {
  /**
   * The layer a debug toggle is read in: `dom` for a lever the DOM reads
   * through `DomFlags` (a row the flag registry test requires a reader for).
   */
  export type Layer = "dom";

  /** One debug-menu toggle: its key, its live value, its default, its description and the layer that reads it. */
  export class Debug {
    #value: LiveData<boolean>;
    readonly description: Option<string>;
    readonly layer: Option<Flags.Layer>;

    /**
     * @param defaultValue The value with no `?flag:<key>` and nothing stored:
     *   for a `dom` row, the value the DOM falls back to (what a profile of the
     *   levers compares a browser against).
     */
    constructor(
      readonly key: string,
      readonly defaultValue: boolean,
      description?: string,
      layer?: Flags.Layer,
    ) {
      this.description = description ?? null;
      this.layer = layer ?? null;
      // A `?flag:<key>=true|false` query param overrides storage/default for this
      // page load (handy for screenshots and shareable repros); not persisted.
      const urlOverride = new URLSearchParams(window.location.search).get(
        `flag:${key}`,
      );
      const stored = localStorage.getItem(STORAGE_PREFIX + key);
      const value =
        urlOverride != null
          ? urlOverride === "true"
          : stored != null
            ? stored === "true"
            : defaultValue;
      this.#value = new LiveData(value);
    }

    get value(): boolean {
      return this.#value.get();
    }

    set value(v: boolean) {
      this.#value.update(v);
      localStorage.setItem(STORAGE_PREFIX + this.key, String(v));
    }

    get signal(): LiveData.Readable<boolean> {
      return this.#value;
    }

    toggle(force?: Option<boolean>) {
      const newValue = force != null ? force : !this.#value.get();
      this.#value.update(newValue);
      localStorage.setItem(STORAGE_PREFIX + this.key, String(newValue));
    }
  }

  export namespace Development {
    export const dataHandleDelay = new Flags.Debug("data-handle-delay", false, "Add 5s delay to cell data loading");
    export const ALL_FLAGS: Flags.Debug[] = [dataHandleDelay];
  }
}
