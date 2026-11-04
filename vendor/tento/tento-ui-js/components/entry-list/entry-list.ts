import "@tento-ui/components/round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { Point } from "@tento-core/point";
import { Round } from "../round";
import { Scrollbars } from "../scrollbars";
import { EntryRow } from "./entry-row";
import { EntryDisplay, ListItem } from "./list-item";

/**
 * `EntryList` (`std-entry-list`) — a vertical list of `EntryRow`s bound from a
 * source-agnostic `ListItem[]` viewmodel + a single list-level `EntryDisplay`.
 *
 * Generalizes the former `EventList`: events, stickers, and tasks all map their
 * own data-model into `ListItem[]` (each renderer owns that transform) and bind
 * the same component. The `card`/`cell`/`no-bg` presentation attributes are set
 * externally by consumers exactly as before; only the bind API and the CSS
 * custom-property names (`--entry-list-*`/`--entry-row-*`) are generalized.
 */
@component({ name: "std-entry-list" })
export class EntryList extends LonaWebComponent {
  private $bg: Round = this.hydrate<Round>("bg");
  private _callbacks: Option<EntryList.RowCallbacks> = null;
  private _rows: EntryRow[] = [];

  bindCallbacks(callbacks: EntryList.RowCallbacks): this {
    this._callbacks = callbacks;
    // Rebind existing rows with new callbacks
    for (let i = 0; i < this._rows.length; i++) {
      this.bindRowCallbacks(this._rows[i], i);
    }
    return this;
  }

  private bindRowCallbacks($row: EntryRow, rowIndex: number): void {
    if (!this._callbacks) return;
    const callbacks = this._callbacks;
    $row.bindCallbacks({
      onPointerDown: (e) => callbacks.onPointerDown(rowIndex, e.offset, $row),
      onPointerUp: (e) => callbacks.onPointerUp(rowIndex, e.offset),
      onPointerMove: (e) => callbacks.onPointerMove(rowIndex, e.offset),
      onContextMenu: (e) => callbacks.onContextMenu(rowIndex, e.offset),
    });
  }

  bind(props: EntryList.Props): this {
    // Rebind existing rows in place: EntryRow.bind writes every field it
    // renders, so a reused row carries no stale state, and skipping the
    // teardown avoids a shadow-scope style rebuild per row per bind.
    const $root = this.$("root");
    while (this._rows.length > props.items.length) {
      this._rows.pop()!.remove();
    }
    const onRowBound = props.onRowBound ?? null;
    for (let i = 0; i < props.items.length; i++) {
      const item = props.items[i];
      let $row = this._rows[i];
      if ($row == null) {
        $row = EntryRow.make();
        this._rows.push($row);
        $root.appendChild($row);
      }
      $row.bind(item, props.display);

      // Apply callbacks if set
      if (this._callbacks) {
        this.bindRowCallbacks($row, i);
      }

      if (onRowBound != null) {
        onRowBound(item, $row);
      }
    }
    this.$bg.bind({
      ...Round.Props.MODAL,
      bg: "var(--entry-list-bg-color)",
      shadow: null,
    });
    return this;
  }

  static makeWith(props: EntryList.Props): EntryList {
    const component = EntryList.make();
    component.bind(props);
    return component;
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        position: relative;
        display: block;
        width: 100%;
        min-height: 100%;
        --entry-list-bg-color: var(--bg);
      }

      #root {
        height: 100%;
        overflow-y: scroll;
      }

      :host([type=card]) #bg {
        display: block;
      }

      :host([type=card]) #root {
        padding: 8px 12px;
      }

      :host([type=cell]) {
        margin-inline: 2px;
        width: calc(100% - 5px);
        --entry-row-padding: 6px;
        --entry-list-bg-color: transparent;
      }

      :host([type=cell]) #root {
        padding: 3px;
        box-sizing: border-box;
        overflow: visible;
      }

      :host([card][no-bg]) #bg,
      :host([no-bg]) #bg {
        display: none;
      }

      :host([no-bg][type=card]) #root {
        padding: 0;
      }
    `,
  ];

  static $html = html`
    <std-round id="bg" floating></std-round>
    <std-col id="root"></std-col>
  `;
}

export namespace EntryList {
  export type Props = {
    items: ListItem[];
    display: EntryDisplay;
    onRowBound?: Option<RowBoundCallback>;
  };

  export type RowBoundCallback = (item: ListItem, $row: EntryRow) => void;

  export type RowCallbacks = {
    onPointerDown: (rowIndex: number, offset: Point, $row: HTMLElement) => void;
    onPointerUp: (rowIndex: number, offset: Point) => void;
    onPointerMove: (rowIndex: number, offset: Point) => void;
    onContextMenu: (rowIndex: number, offset: Point) => void;
  };

  export namespace RowCallbacks {
    export const DEFAULT: RowCallbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUp: Constants.EMPTY_FUNCTION,
      onPointerMove: Constants.EMPTY_FUNCTION,
      onContextMenu: Constants.EMPTY_FUNCTION,
    };
  }
}
