import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import {
  BarChartIcon,
  CalendarIcon,
  CheckSquareIcon,
  ClockIcon,
  CloudIcon,
  ComponentIcon,
  DatabaseIcon,
  FormulaIcon,
  GearIcon,
  GridIcon,
  HashIcon,
  JournalIcon,
  LinkIcon,
  ListUlIcon,
  SparkleIcon,
} from "../../ui/icons";
import { Accordion } from "../accordion";
import { Avatar } from "../avatar";
import { RailNav } from "../rail/rail-nav";
import { SelectionSync } from "../rail/selection-sync";

@component({
  name: "std-docs-nav",
})
export class DocsNav extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private activePath: string = "";
  private libraries: DocsNav.NavLibrary[] = [];
  private expandedLibraries = new Set<string>();
  private selection = new SelectionSync<string>();
  private onNavigate: Option<(path: string) => void> = null;
  private iconForLibrary: Option<DocsNav.LibraryIconResolver> = null;
  private defaultExpanded = false;

  bind(props: DocsNav.Props): this {
    this.libraries = props.items;
    this.activePath = props.activePath;
    this.onNavigate = props.onNavigate;
    this.iconForLibrary = props.iconForLibrary ?? null;
    this.defaultExpanded = props.defaultExpanded ?? false;
    if (this.defaultExpanded) {
      // Always open every library; ignore the shared, cross-surface
      // localStorage so this surface can't be collapsed by another's state.
      this.expandedLibraries = DocsNav.Storage.defaultExpanded(this.libraries);
    } else {
      this.expandedLibraries =
        DocsNav.Storage.load(this.libraries) ??
        DocsNav.Storage.defaultExpanded(this.libraries);
    }
    if (this.expandActivePath()) {
      this.persistExpanded();
    }
    // A rebind is routinely a refresh of mostly-unchanged content (a nav fed
    // from polled data); keeping the reader's place matters more than the
    // rebuild. When content did change above the fold the restored offset is
    // approximate — still far less disruptive than snapping to the top.
    this.renderPreservingScroll();
    return this;
  }

  /** Persist expand state, unless this surface is forced fully expanded. */
  private persistExpanded(): void {
    if (this.defaultExpanded) return;
    DocsNav.Storage.save(this.expandedLibraries);
  }

  setActivePath(path: string): void {
    this.activePath = path;
    if (this.expandActivePath()) {
      this.persistExpanded();
      this.renderPreservingScroll();
      return;
    }
    this.updateSelection();
  }

  private expandActivePath(): boolean {
    const library = DocsNav.Lookup.libraryForPath(
      this.libraries,
      this.activePath,
    );
    if (library == null) {
      return false;
    }
    if (this.expandedLibraries.has(library.namespace)) {
      return false;
    }
    this.expandedLibraries.add(library.namespace);
    return true;
  }

  private render(): void {
    DomUtils.clearChildren(this.$root);
    this.selection.clear();

    const $accordion = Accordion.makeWith({
      items: this.libraries.map((library) => ({
        header: library.title,
        headerAvatar: this.makeLibraryAvatar(library),
        content: this.renderLibrarySections(library),
      })),
      expandedIndexes: this.expandedLibraryIndexes(),
      onExpandedIndexesChange: (indexes) =>
        this.syncExpandedLibraries(indexes),
    });
    // The sections inset their header and rows by --rail-inset; the accordion
    // content gives that much back, so the row text lands where it did when the
    // list was pulled -8px under a title padded 0.
    $accordion.style.setProperty(
      "--accordion-content-padding",
      "0 12px 12px calc(36px - var(--rail-inset, 8px))",
    );
    this.$root.appendChild($accordion);
    this.updateSelection();
  }

  private renderPreservingScroll(): void {
    const snapshot = DocsNav.Scroll.snapshot(this);
    this.render();
    DocsNav.Scroll.restore(snapshot);
  }

  private renderLibrarySections(library: DocsNav.NavLibrary): HTMLElement {
    return DocsNav.Render.librarySections(
      library,
      this.selection,
      this.onNavigate,
    );
  }

  private makeLibraryAvatar(
    library: DocsNav.NavLibrary,
  ): Option<Avatar.Props> {
    if (this.iconForLibrary == null) {
      return null;
    }
    const resolved = this.iconForLibrary(library);
    const baseProps = Avatar.Props.fromUsername(library.title, {
      size: "20",
      tooltip: library.title,
    });
    return {
      ...baseProps,
      backgroundColor: resolved?.backgroundColor ?? baseProps.backgroundColor,
      icon: resolved?.icon ?? null,
      iconFallback: "empty",
      shadow: "0px 1px 0.5px var(--black33)",
    };
  }

  private expandedLibraryIndexes(): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < this.libraries.length; i++) {
      if (this.expandedLibraries.has(this.libraries[i].namespace)) {
        indexes.push(i);
      }
    }
    return indexes;
  }

  private syncExpandedLibraries(indexes: number[]): void {
    const expandedIndexes = new Set(indexes);
    this.expandedLibraries.clear();
    for (let i = 0; i < this.libraries.length; i++) {
      if (expandedIndexes.has(i)) {
        this.expandedLibraries.add(this.libraries[i].namespace);
      }
    }
    this.persistExpanded();
  }

  private updateSelection(): void {
    this.selection.select(this.activePath);
  }

  static $html = html`
    <div id="root"></div>
  `;

  static $styles = [
    css`
    :host {
      display: block;
    }

    #root {
      display: block;
    }
  `,
  ];
}

export namespace DocsNav {
  export type Props = {
    items: NavLibrary[];
    activePath: string;
    onNavigate: Option<(path: string) => void>;
    iconForLibrary?: Option<LibraryIconResolver>;
    /** Force every library expanded and ignore saved (shared) collapse state. */
    defaultExpanded?: Option<boolean>;
  };

  export type NavLibrary = {
    title: string;
    namespace: string;
    path: string;
    sections: NavSection[];
  };

  export type NavSection = {
    title: string;
    children: NavItem[];
  };

  export type NavItem = {
    label: string;
    path: string;
    slug: string;
  };

  export type LibraryAvatar = {
    icon: Option<Avatar.Icon>;
    backgroundColor: Option<string>;
  };

  export type LibraryIconResolver = (library: NavLibrary) => Option<LibraryAvatar>;


  export namespace LibraryIcons {
    type LibraryIconCategory = {
      terms: string[];
      icon: LibraryAvatar["icon"];
    };

    const PLATFORM_CATEGORIES: LibraryIconCategory[] = [
      { terms: ["whoop", "garmin"], icon: { kind: "svg", svg: BarChartIcon } },
      { terms: ["google"], icon: { kind: "svg", svg: CalendarIcon } },
      { terms: ["openai", "gemini", "claude"], icon: { kind: "svg", svg: SparkleIcon } },
    ];

    const SVG_CATEGORIES: LibraryIconCategory[] = [
      { terms: ["weather", "cloudflare"], icon: { kind: "svg", svg: CloudIcon } },
      { terms: ["calendar", "calendars", "event", "events", "ical"], icon: { kind: "svg", svg: CalendarIcon } },
      { terms: ["task", "tasks"], icon: { kind: "svg", svg: CheckSquareIcon } },
      { terms: ["row", "rows"], icon: { kind: "svg", svg: ListUlIcon } },
      { terms: ["sheet", "sheets", "grid"], icon: { kind: "svg", svg: GridIcon } },
      { terms: ["data", "sync"], icon: { kind: "svg", svg: DatabaseIcon } },
      { terms: ["series", "chart", "charts"], icon: { kind: "svg", svg: BarChartIcon } },
      { terms: ["formula", "formulas", "lisp"], icon: { kind: "svg", svg: FormulaIcon } },
      { terms: ["chrono", "date", "dates", "time", "timezone", "tz", "recurrence"], icon: { kind: "svg", svg: ClockIcon } },
      { terms: ["oauth", "auth", "authentication", "connector", "connections", "requests"], icon: { kind: "svg", svg: LinkIcon } },
      { terms: ["api", "reference", "key", "keys", "identity"], icon: { kind: "svg", svg: HashIcon } },
      { terms: ["tool", "tools", "cli", "deploy", "bundle", "admin", "config"], icon: { kind: "svg", svg: GearIcon } },
      { terms: ["ai", "llm", "classifier", "monarch"], icon: { kind: "svg", svg: SparkleIcon } },
      { terms: ["component", "components", "ui", "core"], icon: { kind: "svg", svg: ComponentIcon } },
      { terms: ["docs", "documentation", "ssr", "blog"], icon: { kind: "svg", svg: JournalIcon } },
    ];

    const JS_LIBRARY_BG = "var(--blue-dimmed)";
    const LONA_LIBRARY_BG = "var(--red-dimmed)";
    const RUST_LIBRARY_BG = "var(--orange-dimmed)";
    const PROJECT_LIBRARY_BG = "var(--purple-dimmed)";

    export const docs: LibraryIconResolver = (library) => ({
      icon: libraryIcon(library),
      backgroundColor: docsBackgroundColor(library),
    });

    export const projects: LibraryIconResolver = (library) => ({
      icon: libraryIcon(library) ?? { kind: "svg", svg: JournalIcon },
      backgroundColor: PROJECT_LIBRARY_BG,
    });

    function libraryIcon(library: NavLibrary): Option<Avatar.Icon> {
      const terms = iconTerms(library);
      const category =
        firstCategoryForTerms(terms, PLATFORM_CATEGORIES) ??
        firstCategoryForTerms(terms, SVG_CATEGORIES);
      return category?.icon ?? null;
    }

    function docsBackgroundColor(library: NavLibrary): string {
      if (isJsLibrary(library)) return JS_LIBRARY_BG;
      if (isLonaLibrary(library)) return LONA_LIBRARY_BG;
      return RUST_LIBRARY_BG;
    }

    function isJsLibrary(library: NavLibrary): boolean {
      return library.title.startsWith("@");
    }

    function isLonaLibrary(library: NavLibrary): boolean {
      return library.namespace.startsWith("lona-") || library.namespace === "so.lona";
    }

    function iconTerms(library: NavLibrary): Set<string> {
      return new Set(
        [library.namespace, library.title]
          .join(" ")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((part) => part.length > 0),
      );
    }

    function firstCategoryForTerms(
      terms: Set<string>,
      categories: LibraryIconCategory[],
    ): Option<LibraryIconCategory> {
      for (const category of categories) {
        if (matchesAnyTerm(terms, category.terms)) {
          return category;
        }
      }
      return null;
    }

    function matchesAnyTerm(terms: Set<string>, candidates: string[]): boolean {
      for (const candidate of candidates) {
        if (terms.has(candidate)) {
          return true;
        }
      }
      return false;
    }
  }

  export namespace Lookup {
    export function libraryForPath(
      libraries: NavLibrary[],
      path: string,
    ): Option<NavLibrary> {
      for (const library of libraries) {
        if (library.path === path) {
          return library;
        }
        if (sectionContainingPath(library, path) != null) {
          return library;
        }
      }
      return null;
    }

    function sectionContainingPath(
      library: NavLibrary,
      path: string,
    ): Option<NavSection> {
      for (const section of library.sections) {
        for (const item of section.children) {
          if (item.path === path) {
            return section;
          }
        }
      }
      return null;
    }
  }

  export namespace Storage {
    const STORAGE_KEY = "std-docs-nav.expandedLibraries.v1";

    export function defaultExpanded(libraries: NavLibrary[]): Set<string> {
      return new Set(libraries.map((library) => library.namespace));
    }

    export function load(libraries: NavLibrary[]): Option<Set<string>> {
      if (typeof localStorage === "undefined") {
        return null;
      }

      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) {
        return null;
      }

      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return null;
        }

        const validNamespaces = defaultExpanded(libraries);
        const expanded = new Set<string>();
        for (const namespace of parsed) {
          if (typeof namespace !== "string") {
            continue;
          }
          if (validNamespaces.has(namespace)) {
            expanded.add(namespace);
          }
        }
        return expanded;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `std-docs-nav: localStorage read failed key="${STORAGE_KEY}" - ${message}`,
        );
        return null;
      }
    }

    export function save(expanded: Set<string>): void {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([...expanded].sort((a, b) => a.localeCompare(b))),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `std-docs-nav: localStorage write failed key="${STORAGE_KEY}" - ${message}`,
        );
      }
    }
  }

  export namespace Render {
    /** One library's groups, as the shared sidebar layout. The selection is
     * passed IN rather than owned: a library is one accordion item among
     * several and only one row in the whole nav may be lit, so all of them
     * share the map docs-nav clears once per render. */
    export function librarySections(
      library: NavLibrary,
      selection: SelectionSync<string>,
      onNavigate: Option<(path: string) => void>,
    ): HTMLElement {
      return RailNav.makeWith({
        sections: library.sections.map((section) => ({
          title: section.title,
          rows: section.children.map((item) => ({
            key: item.path,
            label: item.label,
          })),
        })),
        selection,
        onSelect: (path) => onNavigate?.(path),
      });
    }
  }

  export namespace Scroll {
    type Snapshot = {
      $container: HTMLElement;
      scrollTop: number;
    };

    export function snapshot($host: HTMLElement): Option<Snapshot> {
      const $container = nearestContainer($host);
      if ($container == null) {
        return null;
      }
      return {
        $container,
        scrollTop: $container.scrollTop,
      };
    }

    /** One live restore per container — a newer render's restore supersedes
     * any retry loop still in flight from the previous one. */
    const restoreTokens = new WeakMap<HTMLElement, number>();

    export function restore(snapshot: Option<Snapshot>): void {
      if (snapshot == null) {
        return;
      }
      const { $container, scrollTop } = snapshot;
      const token = (restoreTokens.get($container) ?? 0) + 1;
      restoreTokens.set($container, token);
      // The freshly-rendered content mounts asynchronously (components hydrate
      // a frame later), so the container is often still too short to accept the
      // offset and the write clamps. Retry over a bounded number of frames
      // until it sticks, on fastdom's queue rather than a private rAF loop: the
      // write joins the frame's write phase with every other DOM mutation, and
      // the check that follows it lands in the NEXT frame's read phase — after
      // the layout that write produced, before that frame's writes. A private
      // loop instead reads scrollTop back in the same tick it wrote it, which
      // is a forced synchronous layout on every retry.
      let framesLeft = 20;
      // Where WE last left scrollTop. Any other value at the next read means
      // the reader scrolled during the retry window, and their position wins.
      let expected: Option<number> = null;
      const attempt = (): void => {
        $$.mutate(() => {
          if (restoreTokens.get($container) !== token) return;
          $container.scrollTop = scrollTop;
        });
        // measureNext, not measure: issued from inside a flush it yields to the
        // next frame's read phase, which is the first moment the write above
        // has been laid out.
        $$.measureNext(() => {
          if (restoreTokens.get($container) !== token) return;
          const settled = $container.scrollTop;
          if (Math.abs(settled - scrollTop) < 1) return;
          if (expected != null && Math.abs(settled - expected) >= 1) return;
          expected = settled;
          if (--framesLeft <= 0) return;
          attempt();
        });
      };
      attempt();
    }

    function nearestContainer($host: HTMLElement): Option<HTMLElement> {
      let $current = flattenedParent($host);
      while ($current != null) {
        const overflowY = getComputedStyle($current).overflowY;
        if (
          overflowY === "auto" ||
          overflowY === "scroll" ||
          overflowY === "overlay"
        ) {
          return $current;
        }
        $current = flattenedParent($current);
      }
      return null;
    }

    /** The rendered (flattened-tree) parent. Slotted content scrolls inside
     * the shadow tree it is slotted INTO, so the walk follows `assignedSlot`
     * into that tree and hops shadow-host boundaries — a plain
     * `parentElement` walk dead-ends at the first boundary and never finds a
     * scroll container that lives in an ancestor component's shadow root. */
    function flattenedParent($el: HTMLElement): Option<HTMLElement> {
      const $anchor = $el.assignedSlot ?? $el;
      if ($anchor.parentElement != null) {
        return $anchor.parentElement;
      }
      const root = $anchor.getRootNode();
      return root instanceof ShadowRoot && root.host instanceof HTMLElement
        ? root.host
        : null;
    }
  }
}
