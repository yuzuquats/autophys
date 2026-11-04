import "../icon-button";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { EditDistance } from "@tento-core/edit-distance";
import { $$, mutate } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { LazySync } from "../../lazy";
import { ScrollAncestorObserver } from "../../scroll-utils";
import { AngleRightIcon } from "../../ui/icons";
import { ZIndex } from "../../z-index";
import { IconButton } from "../icon-button";
import { ListCellLayout } from "../list/list-cell-layout";
import { Placeholder } from "../placeholder";

/**
 * Searchable dropdown component with keyboard navigation and hover states.
 * Uses factory pattern for efficient element creation.
 */
@component({
  name: "std-dropdown",
})
export class Dropdown<Data> extends LonaWebComponent {
  private state: Option<Dropdown.State<Data>>;
  private $container: LazySync<DropdownContainer<Data>> = new LazySync(() => {
    const $container = DropdownContainer.make();
    DomUtils.registerKeyListeners($container, {
      onEnterKey: this.onEnterKey.bind(this),
      onArrowKeyVertical: this.onArrowKeyVertical.bind(this),
    });
    return $container as DropdownContainer<Data>;
  });
  private observer: ScrollAncestorObserver = new ScrollAncestorObserver(
    this,
    () => {
      const $container = this.$container.maybeGet();
      if (!$container) return;
      this.layoutDropdownContainer();
    },
  );
  private resizeObserver: ResizeObserver = new ResizeObserver(([entry]) => {
    this.currentSize = {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    };
  });
  private currentSize: Option<Size>;
  private $root: HTMLElement = this.hydrate("root");
  private $searchInput: HTMLElement = this.hydrate("search-input");
  private $selected: HTMLElement = this.hydrate("selected");
  private $chevron: IconButton =
    this.hydrate<IconButton>("chevron").bindIcon(AngleRightIcon);

  private onSelectedRow?: Option<(row: Dropdown.Row<Data>) => void>;
  private modalContext?: Option<string>;
  onOpen?: () => void;
  private listenersInstalled = false;
  private openingEnterKeyUp = false;

  constructor() {
    super();
    this.addEventListener("blur", this.dismiss);
  }

  private dismiss = () => {
    this.openingEnterKeyUp = false;
    this.toggleAttribute("open", false);
    this.$root.setAttribute("aria-expanded", "false");
    this.$searchInput.tabIndex = -1;
    this.toggleDropdownContainer(false);
    GESTURE_MANAGER.clearOnClickOutside(this);

    // Clear search text and reset to show all items
    this.$searchInput.textContent = "";
    if (this.children.length > 0) {
      this.$searchInput.toggleAttribute("hidden", true);
      this.$selected.toggleAttribute("hidden", false);
    } else {
      this.$searchInput.toggleAttribute("hidden", false);
      this.$selected.toggleAttribute("hidden", true);
    }
  };

  private onEnterKey() {
    const $container = this.$container.maybeGet();
    if (!$container || !this.state) return;
    const row = $container.getHoveredRow();
    if (!row) return;
    this.bindSelectedRow(row.row);
    this.dismiss();
    this.focus({ preventScroll: true });
  }

  private onArrowKeyVertical = (key: "ArrowUp" | "ArrowDown") => {
    const $container = this.$container.maybeGet();
    if (!$container || !this.state) return;

    const currentRow = $container.getHoveredRow();
    if (!currentRow) {
      const firstRow = this.state.first();
      if (!firstRow) return;
      $container.bindHoveredRow(firstRow, true, false);
      return;
    }

    const direction = key === "ArrowUp" ? -1 : 1;
    const { row: nextRow, didWrap } = this.state.next(currentRow, direction);
    if (!nextRow) return;

    $container.bindHoveredRow(nextRow, true, !didWrap);
  };

  private toggleDropdownContainer(force: boolean) {
    const $container = this.$container.get();
    if (force) {
      $container.assignStyles({
        position: "absolute",
        top: "0px",
        left: "0px",
        zIndex: String(ZIndex.popoverLevel()),
      });
      this.layoutDropdownContainer();
      this.bindRows();
      $container.setAttribute("context", this.modalContext ?? "");
      $$.mutate(() => {
        if (!this.hasAttribute("open")) return;
        Hotkeys.pushEscapeHandler(this, () => {
          this.dismiss();
          this.focus({ preventScroll: true });
        });
        document.body.appendChild($container);
      });
    } else {
      Hotkeys.clearEscapeHandler(this);
      DomUtils.removeFromDom($container, false);
    }
  }

  @mutate
  private layoutDropdownContainer() {
    const $container = this.$container.maybeGet();
    if (!$container) return;
    if (!this.currentSize) return;

    const width = this.offsetWidth;
    const height = this.offsetHeight;
    const r = this.getBoundingClientRect();

    // Calculate position relative to viewport since container is appended to body
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;

    const style = getComputedStyle(this);
    $container.assignStyles({
      width: width + "px",
      transform: `translate(${x}px, ${y + height - 1}px)`,
      // The list lives on <body>, outside the host's tree, so it would take
      // the page's typeface and text size; it carries the control's instead.
      fontFamily: style.fontFamily,
      "--p-size": style.getPropertyValue("--p-size"),
      "--dropdown-border-width": style.getPropertyValue(
        "--dropdown-border-width",
      ),
      "--dropdown-outline-active-color": style.getPropertyValue(
        "--dropdown-outline-active-color",
      ),
      "--dropdown-outline-color": style.getPropertyValue(
        "--dropdown-outline-color",
      ),
    });
    $container.setAttribute("context", this.modalContext ?? "");
  }

  connectedCallback() {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    this.observer.observe();

    // Set up ARIA attributes for combobox pattern
    this.$root.setAttribute("role", "combobox");
    this.$root.setAttribute("aria-haspopup", "listbox");
    this.$root.setAttribute("aria-expanded", "false");
    this.$root.tabIndex = this.hasAttribute("disabled") ? -1 : 0;
    this.$searchInput.setAttribute("aria-label", "Search options");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver.unobserve(this);
    this.observer.unobserve();
  }

  bind(props: Dropdown.Props<Data>) {
    this.toggleAttribute("disabled", props.disabled ?? false);
    this.$root.tabIndex = props.disabled ? -1 : 0;
    this.$root.setAttribute("aria-disabled", String(props.disabled ?? false));
    this.$root.setAttribute("aria-label", props.placeholder ?? "Select an option");
    if (props.disabled) this.dismiss();
    this.onSelectedRow = props.onSelectedRow;
    this.onOpen = props.onOpen;
    this.$("search-input").setAttribute(
      "placeholder",
      props.placeholder ?? "Type to Search",
    );
    this.autobind = props.autobind != null ? props.autobind : true;

    this.modalContext = props.modalContext;
    this.state = this.makeState(props.rows);

    this.setupEventListeners();

    const initialSelectedRow = props.rows.find((row) => row.selected);
    this.bindSelectedRow(initialSelectedRow ?? null, false);
  }

  private autobind: boolean = true;

  private makeState(rows: Dropdown.Row<Data>[]): Dropdown.State<Data> {
    return new Dropdown.State(rows, {
      onHoveredRow: (row) => {
        const $container = this.$container.maybeGet();
        if (!$container) return;
        $container.bindHoveredRow(row);
      },
      onSelectedRow: (row) => {
        const $container = this.$container.maybeGet();
        if (!$container) return;
        this.autobind && this.bindSelectedRow(row);
        this.onSelectedRow?.(row);
      },
    });
  }

  /**
   * Replace the rows after the first `bind`, keeping the callbacks and
   * listeners. `bind` registers key listeners each time it runs, so a menu
   * whose entries follow the page's state (enabled actions, visible tools)
   * swaps its rows here instead of rebinding.
   */
  setRows(rows: Dropdown.Row<Data>[]): void {
    if (this.state == null) return;
    this.$container.maybeGet()?.bindHoveredRow(null);
    this.state = this.makeState(rows);
  }

  /** Close the list, as Escape or a click outside would. A caller using the
   * dropdown as an action menu closes it once the action has run. */
  close(): void {
    this.dismiss();
  }

  focus(options?: FocusOptions): void {
    this.$root.focus(options);
  }

  containsPath(path: EventTarget[]): boolean {
    const $container = this.$container.maybeGet();
    return path.includes(this) || path.includes(this.$root)
      || ($container != null && path.includes($container));
  }

  private open(): void {
    if (this.hasAttribute("disabled") || this.hasAttribute("open")) return;
    this.onOpen?.();
    this.$searchInput.toggleAttribute("hidden", false);
    this.$selected.toggleAttribute("hidden", true);
    this.toggleAttribute("open", true);
    this.$root.setAttribute("aria-expanded", "true");
    this.$searchInput.tabIndex = 0;
    this.$searchInput.textContent = "";
    this.$searchInput.focus();
    DomUtils.setEndOfContenteditable(this.$searchInput);
    this.toggleDropdownContainer(true);
    GESTURE_MANAGER.setOnClickOutside(this, ($element) => {
      if ($element && this.$container.maybeGet()?.contains($element)) return;
      this.dismiss();
    });
  }

  private setupEventListeners() {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    GESTURE_MANAGER.addPointerEvent(this.$root, {
      onClick: () => this.open(),
    });
    this.$root.addEventListener("keydown", (event) => {
      if (event.target !== this.$root || event.repeat || this.hasAttribute("open")) return;
      if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      this.openingEnterKeyUp = event.key === "Enter";
      this.open();
    });
    this.$searchInput.addEventListener("keyup", (event) => {
      // Opening transfers focus here before Enter is released. That release
      // belongs to the opener, not to selecting (and blurring) a search result.
      if (event.key !== "Enter" || !this.openingEnterKeyUp) return;
      this.openingEnterKeyUp = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    DomUtils.registerKeyListeners(this.$searchInput, {
      onEnterKey: this.onEnterKey.bind(this),
      onArrowKeyVertical: this.onArrowKeyVertical.bind(this),
      onTextChangeDEPRECATED: (t) => this.bindRows(t),
    });
  }

  bindSelectedRow(row: Option<Dropdown.Row<Data>>, notify: boolean = true) {
    this.clearChildren();
    if (row) {
      // Create a clean element for the selected state (no dropdown event listeners)
      const $row = Dropdown.RowContent.makeClean(row.content);
      $row.slot = "selected";
      this.appendChild($row);

      // Trigger the callback when a row is selected
      notify && this.onSelectedRow?.(row);
    }
    this.$searchInput.toggleAttribute("hidden", row != null);
    this.$selected.toggleAttribute("hidden", row == null);
  }

  private bindRows(query: Option<string> = null) {
    const $container = this.$container.maybeGet();
    if (!$container) return;

    DomUtils.clearChildren($container, false);
    $container.dropdownScrollToTop();

    const layout = this.state?.bind(query);
    if (!layout) return;

    const elementsWithRows: Dropdown.BoundRowWithElement<Data>[] = [];
    for (const row of layout.rows) {
      const $element = row.$row();
      $container.appendChild($element);
      elementsWithRows.push({
        row: row.row,
        $row: $element,
      });
    }

    // Store the created elements for container methods
    $container.bindCreatedRows(elementsWithRows);

    if (layout.candidate) {
      $container.bindHoveredRow(layout.candidate);
    }
  }

  static $styles = [
    Placeholder.$style,
    css`
      :host {
        display: block;
        width: 100%;
      }

      #root {
        border: var(--dropdown-border-width, 1px) solid var(--dropdown-outline-color, #aaa);
        background-color: var(--dropdown-background-color, var(--bg));
        border-radius: 8px;
        padding: 4px;
        align-items: center;

        width: 100%;
        transition: border-radius 0.15s ease, border-color 0.3s ease, background-color 0.3s ease;
        cursor: pointer;
        z-index: 1;
      }

      :host([open]) #root {
        border-bottom-left-radius: 0px;
        border-bottom-right-radius: 0px;
        border-color: var(--dropdown-outline-active-color, var(--dropdown-outline-color, #aaa));
        background-color: var(--dropdown-active-background-color, var(--dropdown-background-color, var(--bg)));
        cursor: text;
      }

      :host([disabled]) #root {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      #search-row {
        padding: 0px 8px;
        align-items: center;
        flex-grow: 1;
        min-height: var(--dropdown-search-row-height, 28px);
        height: var(--dropdown-search-row-height, auto);
      }

      #search-input {
        width: 100%;
        padding-inline-start: 8px;
        --placeholder-left: 8px;
      }

      #search-input:focus {
        outline: none;
      }

      #root:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #chevron svg {
        transform: rotate(90deg);
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <std-row id="search-row">
        <slot id="selected" name="selected"></slot>
        <p id="search-input" contenteditable></p>
      </std-row>

      <std-icon-button id=chevron square style="margin-right:8px;"></std-icon-button>
    </std-row>
  `;
}

@component({
  name: "std-dropdown-container",
})
/**
 * Container for dropdown options. Handles scrolling and element positioning.
 */
export class DropdownContainer<Data> extends LonaWebComponent {
  private hoveredRow: Option<Dropdown.BoundRowWithElement<Data>>;
  private createdRows: Dropdown.BoundRowWithElement<Data>[] = [];

  constructor() {
    super();
    this.addEventListener(
      "scroll",
      (e) => {
        e.stopPropagation();
      },
      {
        passive: true,
      },
    );
  }

  connectedCallback() {
    super.connectedCallback();
    this.$("dropdown").setAttribute("role", "listbox");
  }

  bindCreatedRows(rows: Dropdown.BoundRowWithElement<Data>[]) {
    this.createdRows = rows;
  }

  bindHoveredRow(
    row: Option<Dropdown.BoundRow<Data>>,
    scrollTo: boolean = false,
    animate: boolean = true,
  ) {
    const $buttonBackground = this.$("button-background");
    if (!row) {
      this.hoveredRow = null;
      $buttonBackground.style.height = "0px";
      return;
    }

    const createdRow = this.createdRows.find((cr) => cr.row === row.row);
    if (!createdRow || createdRow.$row.parentElement !== this) {
      // $buttonBackground.assignStyles({
      //   height: r.height + "px",
      //   transform: "0px",
      // });
      return;
    }

    this.hoveredRow = createdRow;
    const parentR = this.$("dropdown").getBoundingClientRect();
    const r = createdRow.$row.getBoundingClientRect();
    $buttonBackground.assignStyles({
      height: r.height + "px",
      transform: `translateY(${
        r.top - parentR.top + this.$("dropdown").scrollTop
      }px)`,
    });
    if (!scrollTo) return;

    createdRow.$row.scrollIntoView({
      behavior: animate ? "auto" : "instant",
      block: "center",
      inline: "center",
    });
  }

  getHoveredRow(): Option<Dropdown.BoundRowWithElement<Data>> {
    return this.hoveredRow;
  }

  dropdownScrollToTop() {
    this.$("dropdown").scrollTop = 0;
  }

  static $styles = [
    css`
      :host {
        position: absolute;
        top: 0px;
        left: 0px;
        max-height: 160px;
        width: 100px;
        z-index: 4000; /* ZIndex.POPOVER */
        margin-top: calc(var(--dropdown-border-width, 1px) * -1px);
      }

      #root {
        height: 100%;
        width: 100%;
        max-height: inherit;

        padding: var(--dropdown-container-padding, 4px 8px);
        border-radius: 8px;
        border-top-left-radius: 0px;
        border-top-right-radius: 0px;

        border: var(--dropdown-border-width, 1px) solid var(--dropdown-outline-active-color, var(--dropdown-outline-color, #aaa));
        background-color: var(--dropdown-background-color, var(--bg));
        overflow-y: scroll;
        overflow-x: hidden;
        // transition: border-color 0.3s ease;
      }

      #dropdown {
        position: relative;
        width: 100%;
      }

      #button-background {
        position: absolute;
        top: 0;
        left: -2px;
        width: calc(100% + 4px);
        background-color: var(--bg-surface-light);
        border-radius: 10px;
        transition: transform 0.15s ease, height 0.15s ease;
        z-index: 0;
        pointer-events: none;
      }

      slot::slotted(*) {
        cursor: pointer;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <std-col id="dropdown">
        <div id="button-background"></div>
        <slot></slot>
      </std-col>
    </div>
  `;
}

export namespace Dropdown {
  export type Legacy<T> = Dropdown<T>;
  export const Legacy = Dropdown;

  export type RowContent = string | HTMLElement;

  export type Props<Data> = {
    rows: Dropdown.Row<Data>[];
    onOpen?: () => void;
    onSelectedRow?: Option<(row: Dropdown.Row<Data>) => void>;
    autobind?: Option<boolean>;
    placeholder?: Option<string>;
    modalContext?: Option<string>;
    disabled?: Option<boolean>;
  };

  export namespace RowContent {
    export function make(content: RowContent): HTMLElement {
      if (content instanceof HTMLElement) {
        return content;
      }
      const $row = ListCellLayout.makeText(content);
      ($row.$content.firstChild! as HTMLElement).assignStyles({
        textOverflow: "ellipsis",
        display: "-webkit-box",
        webkitBoxOrient: "vertical",
        webkitLineClamp: String(1),
        overflow: "hidden",
      });
      return $row.assignStyles({
        "--p-hover-color": "transparent",
      });
    }

    export function makeClean(content: RowContent): HTMLElement {
      // Create a fresh, clean element without any dropdown-specific event listeners
      if (content instanceof HTMLElement) {
        // Clone the element to avoid sharing the same instance
        return content.cloneNode(true) as HTMLElement;
      }
      const $row = ListCellLayout.makeText(content);
      ($row.$content.firstChild! as HTMLElement).assignStyles({
        textOverflow: "ellipsis",
        display: "-webkit-box",
        webkitBoxOrient: "vertical",
        webkitLineClamp: String(1),
        overflow: "hidden",
      });
      return $row.assignStyles({
        "--p-hover-color": "transparent",
      });
    }
  }

  export type Row<Data> = {
    selected?: Option<boolean>;
    content: RowContent;
    searchIndicies?: string[];
    data: Data;
  };

  export type BoundRow<Data> = {
    row: Row<Data>;
    $row: () => HTMLElement;
  };

  export type SearchResult<Data> = {
    row: BoundRow<Data>;
    minDistance: number;
    minDistanceIndex: Option<string>;
  };

  export type BoundRowWithElement<Data> = {
    row: Row<Data>;
    $row: HTMLElement;
  };

  export class State<Data> {
    private rows: BoundRow<Data>[] = [];
    private currentSearch: Option<{
      query?: Option<string>;
      results: BoundRow<Data>[];
    }>;

    constructor(
      rows: Dropdown.Row<Data>[],
      callbacks: {
        onHoveredRow: (row: Dropdown.BoundRow<Data>) => void;
        onSelectedRow: (row: Dropdown.Row<Data>) => void;
      },
    ) {
      this.rows = rows.map((row) => {
        const boundRow: Dropdown.BoundRow<Data> = {
          row,
          $row: () => {
            const $element = RowContent.make(row.content);
            // Set ARIA attributes for option
            $element.setAttribute("role", "option");
            $element.setAttribute(
              "aria-selected",
              String(row.selected ?? false),
            );
            $element.onpointerenter = () => callbacks.onHoveredRow(boundRow);
            GESTURE_MANAGER.addPointerEvent($element, {
              onClick: () => callbacks.onSelectedRow(row),
            });
            return $element;
          },
        };
        return boundRow;
      });
    }

    first(): Option<BoundRow<Data>> {
      return this.rows[0];
    }

    next(
      currentRow: BoundRow<Data> | Dropdown.BoundRowWithElement<Data>,
      offset: number,
    ): {
      row: Option<BoundRow<Data>>;
      didWrap: boolean;
    } {
      const targetRow: Row<Data> =
        "row" in currentRow ? currentRow.row : currentRow;
      const idx = this.rows.findIndex((curr) => curr.row === targetRow);
      if (idx === -1)
        return {
          row: null,
          didWrap: false,
        };
      return {
        row: this.rows[(idx + offset + this.rows.length) % this.rows.length],
        didWrap: offset > idx,
      };
    }

    bind(searchQuery: Option<string>): {
      candidate: Option<BoundRow<Data>>;
      rows: BoundRow<Data>[];
    } {
      const rows = this.rows;
      if (!searchQuery || searchQuery == null) {
        return {
          candidate: null,
          rows,
        };
      }

      const results = this.search(searchQuery);
      return {
        candidate: results[0]?.row,
        rows: results.map((r) => r.row),
      };
    }

    private search(query: string): Dropdown.SearchResult<Data>[] {
      const distances: Dropdown.SearchResult<Data>[] = this.rows.map(
        (boundRow) => {
          let minDistance = Number.MAX_SAFE_INTEGER;
          let minDistanceIndex: Option<string>;
          let rowDisplay =
            typeof boundRow.row.content === "string"
              ? boundRow.row.content
              : null;

          for (const index of [
            rowDisplay,
            ...(boundRow.row.searchIndicies ?? []),
          ]) {
            if (index == null) continue;
            const distance = EditDistance.distance(
              query.toLocaleLowerCase(),
              index.toLocaleLowerCase(),
            );
            if (minDistance > distance) {
              minDistance = distance;
              minDistanceIndex = index;
            }
          }
          return {
            row: boundRow,
            minDistance,
            minDistanceIndex,
          };
        },
      );
      return distances.sort((a, b) => a.minDistance - b.minDistance);
    }
  }
}
