import { SpotlightIcons } from "../../ui/spotlight-icons";
import { Spotlight } from "./spotlight";
import { SpotlightRow } from "./spotlight-row";

// Where a surface's spotlight rows go, without the surface knowing whether it
// owns the palette. A page run standalone owns one; the same page framed by a
// shell contributes to the shell's instead, so there is exactly one palette on
// screen either way. `MiniappChrome.connect` picks the implementation once, by
// framed-ness — see `../shell-layout/miniapp-chrome.ts`.
//
// The split exists because a `Spotlight.Row` cannot cross a frame boundary:
// `command`, `icon`, and the title/subtitle elements are functions and DOM
// nodes, and structured clone rejects all of them. So a row is authored as
// `Row` (a flat description PLUS a live closure), and the wire carries only the
// `RowSpec` half. The closure stays in the realm that wrote it and is called
// back by id.
export interface SpotlightHost {
  /** Declare this surface's rows. A full replacement, idempotent and cheap —
   * call it again on any state change rather than diffing. */
  publish(rows: SpotlightHost.Row[]): void;
  /** Ask for the palette. Owned: reveals it. Contributed: asks the shell. */
  toggle(): void;
}

export namespace SpotlightHost {
  /** The wire-safe half of a row: no functions, no DOM nodes, clonable by
   * `postMessage`. `id` is assigned by the publishing page and only has to be
   * unique within it — the shell namespaces by frame. */
  export type RowSpec = {
    id: string;
    name: string;
    subtitle?: Option<string>;
    /** An emoji glyph, or an absolute path/URL. Same discriminator the shell's
     * favicon layer uses, so one declaration serves both. */
    icon?: Option<string>;
    searchTerms: string[];
    priority?: Option<number>;
    showInNullState?: Option<boolean>;
  };

  /** What a page actually authors: the description plus the thing to run. */
  export type Row = RowSpec & { command: () => Promise<void> };

  /** Strip a row to the half that can cross a frame boundary. Explicit nulls
   * rather than omitted keys, so the receiving side never has to distinguish
   * "absent" from "cleared". */
  export function spec(row: Row): RowSpec {
    return {
      id: row.id,
      name: row.name,
      subtitle: row.subtitle ?? null,
      icon: row.icon ?? null,
      searchTerms: row.searchTerms,
      priority: priorityOf(row),
      showInNullState: row.showInNullState ?? false,
    };
  }

  // Priority 1 is the floor, and the reason is a rendering bug rather than
  // taste: `spotlight-layout.ts` stops its render loop once a run of
  // `score === -100` ends, and scoring adds `priority * 5`. A priority-0 row
  // that matches as an exact prefix lands on exactly -100, so the list
  // truncates to that single row. Priority 1 scores -95 and renders normally —
  // which is why lona only ever emits 1 and 2. Clamp rather than trust callers
  // to know this.
  function priorityOf(spec: RowSpec): number {
    const raw = spec.priority ?? 1;
    return Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 1;
  }

  function $icon(icon: Option<string>): Option<() => HTMLElement> {
    if (icon == null || icon.length === 0) return null;
    if (!icon.startsWith("/") && !icon.startsWith("http")) {
      return () => SpotlightIcons.text(icon);
    }
    return () => {
      const $img = document.createElement("img");
      $img.src = icon;
      $img.alt = "";
      // Written straight onto `style` rather than through `assignStyles`: that
      // helper is a prototype patch installed by `@tento-ui/init`, and a
      // miniapp publishing rows should not have to have imported init first.
      $img.style.height = "20px";
      $img.style.width = "20px";
      $img.style.objectFit = "contain";
      return $img;
    };
  }

  /** Rehydrate a spec into a real row. The command is supplied separately
   * because that is exactly the part the wire could not carry: a local host
   * passes the original closure, a shell passes one that calls back into the
   * frame that published it. */
  export function toSpotlightRow(
    spec: RowSpec,
    command: () => Promise<void>,
  ): Spotlight.Row {
    return {
      name: spec.name,
      searchTerms: spec.searchTerms,
      priority: priorityOf(spec),
      subtitle: spec.subtitle != null && spec.subtitle.length > 0
        ? SpotlightRow.$subtitle(spec.subtitle)
        : undefined,
      icon: $icon(spec.icon ?? null),
      showInNullState: spec.showInNullState ?? false,
      command,
    };
  }
}

/** The palette this page owns, for a page nobody is framing. */
export class LocalSpotlightHost implements SpotlightHost {
  private rows: SpotlightHost.Row[] = [];
  private dirty = false;

  constructor(private placeholder: string) {}

  publish(rows: SpotlightHost.Row[]): void {
    this.rows = rows;
    // Rebinding calls `setResults([], nullResults())`, which would erase a
    // half-typed query mid-keystroke. A page that republishes on every state
    // change will do exactly that, so defer to the next open instead.
    if (Spotlight.instance.get().revealed) {
      this.dirty = true;
      return;
    }
    this.rebind();
  }

  toggle(): void {
    const spotlight = Spotlight.instance.get();
    if (!spotlight.revealed && this.dirty) this.rebind();
    spotlight.toggleReveal();
  }

  private rebind(): void {
    this.dirty = false;
    Spotlight.instance.get().bind(
      this.rows.map((row) =>
        SpotlightHost.toSpotlightRow(SpotlightHost.spec(row), row.command)
      ),
      this.placeholder,
    );
  }
}
