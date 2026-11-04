import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { EditDistance } from "@tento-core/edit-distance";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Anchor, AnchorInstance } from "../anchor";
import { Position } from "../../anchor-positioning-utils";
import { CheckmarkIcon, LonaIcons } from "../../ui/icons";
import { ListCellLayout } from "../list/list-cell-layout";
import { PillButton } from "../pill-button";

function makeItemCell<Data>(
  item: InlineSelect.Item<Data>,
  $accessory?: Option<HTMLElement>,
): ListCellLayout {
  if (item.$el) {
    return ListCellLayout.makeWith({
      $content: item.$el.cloneNode(true) as HTMLElement,
      $accessory,
    });
  }
  if (item.icon) {
    return ListCellLayout.makeText(item.label, {
      $icon: item.icon.cloneNode(true) as HTMLElement,
      $accessory,
      titleStyle: "1-line",
    });
  }
  return ListCellLayout.makeText(item.label, {
    $accessory,
    titleStyle: "1-line",
  });
}

/**
 * Notion-style inline select that covers the trigger element.
 * On click, reveals a panel positioned over the trigger with optional search.
 */
@component({
  name: "std-inline-select",
})
export class InlineSelect<Data> extends LonaWebComponent {
  private items: InlineSelect.Item<Data>[] = [];
  private searchable: boolean = false;
  private onSelect?: Option<(item: InlineSelect.Item<Data>) => void>;
  private anchorInstance: Option<AnchorInstance>;

  bind(props: InlineSelect.Props<Data>): this {
    this.items = props.items;
    this.searchable = props.searchable ?? false;
    this.onSelect = props.onSelect;

    this.bindSelectedLabel();
    this.setupTrigger();

    return this;
  }

  private bindSelectedLabel() {
    DomUtils.clearChildren(this, false);
    const selected = this.items.find((item) => item.selected);
    if (selected) {
      const $label = this.makeItemLabel(selected);
      this.appendChild($label);
    }
  }

  private makeItemLabel(item: InlineSelect.Item<Data>): HTMLElement {
    const $label = makeItemCell(item);
    $label.assignStyles({ "--p-hover-color": "transparent" });
    return $label;
  }

  private setupTrigger() {
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => {
        if (this.anchorInstance) return;
        this.reveal();
      },
    });
  }

  private reveal() {
    const $panel = InlineSelectPanel.make() as InlineSelectPanel<Data>;
    $panel.bind({
      items: this.items,
      searchable: this.searchable,
      onSelect: (item) => {
        this.onSelect?.(item);

        // Update selected state
        for (const i of this.items) {
          i.selected = i.id === item.id;
        }
        this.bindSelectedLabel();

        this.anchorInstance?.dismiss();
        this.anchorInstance = null;
      },
    });

    const hpad = -2;
    $panel.assignStyles({
      width: this.offsetWidth - hpad * 2 + "px",
    });

    this.anchorInstance = Anchor.reveal({
      $anchor: this,
      $content: $panel,
      position: Position.TOP_LEFT_OVERLAP,
      offset: { outer: { vertical: 2, horizontal: hpad } },
      escapeContainer: true,
      dismissOnClickOutside: true,
      onDismiss: () => {
        this.anchorInstance = null;
      },
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.anchorInstance?.dismiss();
    this.anchorInstance = null;
  }

  static $styles = [
    css`
      :host {
        display: block;
        cursor: pointer;
      }
    `,
  ];

  static $html = html`
    <slot></slot>
  `;
}

export namespace InlineSelect {
  export type Item<Data> = {
    id: string;
    label: string;
    icon?: Option<HTMLElement>;
    $el?: Option<HTMLElement>;
    selected?: Option<boolean>;
    data: Data;
  };

  export type Props<Data> = {
    items: Item<Data>[];
    searchable?: Option<boolean>;
    onSelect?: Option<(item: Item<Data>) => void>;
  };

  export function Pill<Data>(props: {
    id: string;
    label: string;
    data: Data;
    selected?: Option<boolean>;
    pillOptions?: Option<PillButton.Options>;
  }): Item<Data> {
    const pillOpts: PillButton.Options = {
      padding: "4px 8px",
      borderRadius: 4,
      fontSize: "var(--small-size)",
      ...props.pillOptions,
    };
    return {
      id: props.id,
      label: props.label,
      $el: PillButton.makeWith(props.label, pillOpts),
      selected: props.selected,
      data: props.data,
    };
  }

  export function Text<Data>(props: {
    id: string;
    label: string;
    data: Data;
    icon?: Option<HTMLElement>;
    selected?: Option<boolean>;
  }): Item<Data> {
    return {
      id: props.id,
      label: props.label,
      icon: props.icon,
      selected: props.selected,
      data: props.data,
    };
  }
}

/**
 * Panel component for InlineSelect. Renders the dropdown overlay with
 * optional search, items list, and hover animation.
 */
@component({
  name: "std-inline-select-panel",
})
export class InlineSelectPanel<Data> extends LonaWebComponent {
  private $searchInput: HTMLElement = this.hydrate("search-input");
  private $list: HTMLElement = this.hydrate("list");
  private $hoverBg: HTMLElement = this.hydrate("hover-bg");

  private items: InlineSelect.Item<Data>[] = [];
  private filteredItems: InlineSelect.Item<Data>[] = [];
  private $rows: HTMLElement[] = [];
  private hoveredIndex: number = -1;
  private onSelect?: Option<(item: InlineSelect.Item<Data>) => void>;

  bind(props: {
    items: InlineSelect.Item<Data>[];
    searchable: boolean;
    onSelect?: Option<(item: InlineSelect.Item<Data>) => void>;
  }) {
    this.items = props.items;
    this.filteredItems = [...props.items];
    this.onSelect = props.onSelect;

    this.$searchInput.toggleAttribute("hidden", !props.searchable);

    if (props.searchable) {
      this.$searchInput.focus();
      DomUtils.registerKeyListeners(this.$searchInput, {
        onTextChangeDEPRECATED: (t) => this.filterItems(t),
        onEnterKey: () => this.selectHovered(),
        onArrowKeyVertical: (key) => this.onArrowKey(key),
      });
    }

    DomUtils.registerKeyListeners(this, {
      onEnterKey: () => this.selectHovered(),
      onArrowKeyVertical: (key) => this.onArrowKey(key),
    });

    this.renderItems();

    // Focus the selected item initially
    const selectedIdx = this.filteredItems.findIndex((i) => i.selected);
    if (selectedIdx >= 0) {
      this.setHoveredIndex(selectedIdx, false);
    }
  }

  private filterItems(query: Option<string>) {
    if (!query) {
      this.filteredItems = [...this.items];
      this.renderItems();
      return;
    }

    const scored = this.items.map((item) => ({
      item,
      distance: EditDistance.distance(
        query.toLocaleLowerCase(),
        item.label.toLocaleLowerCase(),
      ),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    this.filteredItems = scored.map((s) => s.item);
    this.renderItems();

    if (this.filteredItems.length > 0) {
      this.setHoveredIndex(0, false);
    }
  }

  private renderItems() {
    DomUtils.clearChildren(this.$list, false);
    this.$rows = [];
    this.hoveredIndex = -1;

    const selectedItem = this.filteredItems.find((i) => i.selected);

    if (selectedItem) {
      const $selectedSection = document.createElement("div");
      $selectedSection.className = "section";
      const $displayRow = makeItemCell(selectedItem);
      $displayRow.assignStyles({
        "--p-hover-color": "transparent",
        cursor: "default",
      });
      $selectedSection.appendChild($displayRow);
      this.$list.appendChild($selectedSection);

      const $divider = document.createElement("div");
      $divider.className = "divider";
      this.$list.appendChild($divider);
    }

    const $optionsSection = document.createElement("div");
    $optionsSection.className = "section";
    this.$list.appendChild($optionsSection);

    for (let i = 0; i < this.filteredItems.length; i++) {
      const item = this.filteredItems[i];
      const $row = this.makeRow(item, i);
      this.$rows.push($row);
      $optionsSection.appendChild($row);
    }
  }

  private makeRow(item: InlineSelect.Item<Data>, index: number): HTMLElement {
    const $checkmark = LonaIcons.make(CheckmarkIcon, {
      sizePx: 14,
      color: "var(--text-pri)",
    });
    $checkmark.style.visibility = item.selected ? "visible" : "hidden";
    $checkmark.style.flexShrink = "0";

    const $row = makeItemCell(item, $checkmark);
    $row.assignStyles({
      position: "relative",
      zIndex: "1",
      cursor: "pointer",
    });

    $row.onpointerenter = () => {
      this.setHoveredIndex(index, true);
    };

    $row.onpointerleave = () => {
      this.$hoverBg.style.opacity = "0";
      this.hoveredIndex = -1;
    };

    GESTURE_MANAGER.addPointerEvent($row, {
      onClick: () => {
        this.onSelect?.(item);
      },
    });

    return $row;
  }

  private setHoveredIndex(index: number, animate: boolean) {
    if (index < 0 || index >= this.$rows.length) return;
    this.hoveredIndex = index;

    const $row = this.$rows[index];
    const listRect = this.$list.getBoundingClientRect();
    const rowRect = $row.getBoundingClientRect();

    this.$hoverBg.assignStyles({
      height: rowRect.height + "px",
      transform: `translateY(${rowRect.top - listRect.top + this.$list.scrollTop}px)`,
      opacity: "1",
      transition: animate ? "transform 0.15s ease, height 0.15s ease" : "none",
    });
  }

  private onArrowKey(key: "ArrowUp" | "ArrowDown") {
    if (this.filteredItems.length === 0) return;
    const direction = key === "ArrowDown" ? 1 : -1;
    let next = this.hoveredIndex + direction;
    if (next < 0) next = this.filteredItems.length - 1;
    if (next >= this.filteredItems.length) next = 0;
    this.setHoveredIndex(next, true);

    this.$rows[next].scrollIntoView({
      behavior: "auto",
      block: "nearest",
    });
  }

  private selectHovered() {
    if (this.hoveredIndex < 0 || this.hoveredIndex >= this.filteredItems.length)
      return;
    this.onSelect?.(this.filteredItems[this.hoveredIndex]);
  }

  connectedCallback() {
    super.connectedCallback();
    // Focus panel for keyboard events when not searchable
    if (this.$searchInput.hasAttribute("hidden")) {
      this.setAttribute("tabindex", "0");
      this.focus();
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
        background-color: var(--bg);
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1);
        overflow: hidden;
        outline: none;
      }

      .divider {
        height: 1px;
        background-color: var(--divider);
      }

      .section {
        padding: 2px;
      }

      #root {
        max-height: 240px;
        overflow-y: auto;
        overflow-x: hidden;
      }

      #search-input {
        padding: 6px 10px;
        border-bottom: 1px solid var(--divider);
        outline: none;
        width: 100%;
      }

      #search-input:focus {
        outline: none;
      }

      #search-input[hidden] {
        display: none;
      }

      #list {
        position: relative;
      }

      #hover-bg {
        position: absolute;
        top: 0;
        left: 6px;
        width: calc(100% - 12px);
        background-color: var(--hover-color);
        border-radius: 6px;
        transition: transform 0.15s ease, height 0.15s ease;
        z-index: 0;
        pointer-events: none;
        opacity: 0;
      }

      slot::slotted(*) {
        cursor: pointer;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <p id="search-input" contenteditable placeholder="Search..."></p>
      <std-col id="list">
        <div id="hover-bg"></div>
        <slot></slot>
      </std-col>
    </div>
  `;
}
