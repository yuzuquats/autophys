import { $$, mutate } from "../../fastdom";
import { LazySync } from "../../lazy";
import { ScoredSearchEntry, Search, SearchEntry } from "@tento-core/search";
import { Overlay } from "../overlay";
import { SpotlightLayout } from "./spotlight-layout";

export class Spotlight {
  private $spotlight = SpotlightLayout.make();
  private _revealed = false;
  get revealed(): boolean {
    return this._revealed;
  }

  private rows: Spotlight.Row[] = [];
  private customRowFactory: Option<Spotlight.CustomRowFactory>;
  private placeholder: Option<string>;
  private threshold: number = 0;

  private callbacks: SpotlightLayout.Callbacks = {
    ...SpotlightLayout.NOOP_CALLBACKS,
    onSearchTextChange: async (t) => {
      const custom = (await this.customRowFactory?.(t ?? "")) ?? [];

      if (!t || t.length === 0) {
        this.$spotlight.setResults(custom, this.nullResults());
        return;
      }

      const searchResult = Spotlight.search(t, this.rows, this.threshold);
      if (searchResult.length === 0) {
        this.$spotlight.setResults(custom, this.nullResults());
        return;
      }

      this.$spotlight.setResults(custom, searchResult);
    },
    onCommandComplete: () => {
      this.toggleReveal(false);
      $$.defer(() => {
        this.$spotlight.setResults([], []);
        this.$spotlight.reset();
      });
    },
  };

  private static _instance = new LazySync(() => {
    const spotlight = new Spotlight();
    return spotlight;
  });
  static get instance(): LazySync<Spotlight> {
    return Spotlight._instance;
  }

  private nullResults(): Spotlight.SearchResult[] {
    return this.rows
      .filter((r) => r.showInNullState)
      .map(Spotlight.Row.toSearchResult)
      .slice(0, 10);
  }

  bind(
    rows: Spotlight.Row[],
    placeholder: Option<string>,
    customRowFactory?: Option<Spotlight.CustomRowFactory>,
  ) {
    this.rows = rows;
    this.placeholder = placeholder;
    this.customRowFactory = customRowFactory;
    this.$spotlight.setCallbacks(this.callbacks);
    this.$spotlight.setResults([], this.nullResults());
  }

  @mutate
  toggleReveal(revealed: boolean = !this._revealed) {
    this._revealed = revealed;
    if (!this._revealed) {
      Overlay.dismiss(this.$spotlight);
      return;
    }

    this.$spotlight.assignStyles({
      width: "100%",
      maxWidth: "600px",
    });
    Overlay.reveal(this.$spotlight, {
      onDismiss: () => {
        this._revealed = false;
      },
      position: Overlay.Position.topFrame({
        maxHeight: "550px",
        marginBlock: "40px",
      }),
    });
    $$.defer(() => {
      if (!this._revealed) return;
      this.$spotlight.bindPlaceholder(this.placeholder ?? "Search");
      this.$spotlight.focusSearch();
    });
  }
}

export namespace Spotlight {
  export type CustomRow = { $e: HTMLElement; onSelect: () => void };
  export type CustomRowFactory = (text: string) => Promise<CustomRow[]>;

  export interface Row extends SearchEntry {
    title?: HTMLElement;
    subtitle?: HTMLElement;
    icon?: Option<() => HTMLElement>;
    command: () => Promise<void>;
    showInNullState?: boolean;
  }

  export type SearchResult = ScoredSearchEntry<Row>;

  export namespace Row {
    export function toSearchResult(row: Row): SearchResult {
      return {
        entry: row,
        score: 0,
      };
    }
  }

  export function search(
    searchPhrase: Option<string>,
    rows: Row[],
    threshold: number = 0,
  ): SearchResult[] {
    return Search.search(searchPhrase, rows, {
      method: "fuzzy",
      threshold,
    });
  }
}
