import { ListCellLayout } from "../list/list-cell-layout";

// The selection map, once.
//
// Four sidebars kept the same three lines: a `Map<key, { $cell }>` filled while
// the rows were built, a `selected` key, and a loop that flips the `selected`
// attribute across every cell whenever the key changes (docs-nav, admin-nav,
// acme-sidebar, ux-rail — see the sidebar(1)-kit survey). The shape is right:
// selection is an ATTRIBUTE flip on the cells that already exist, never a
// rebuild of the rows, which is what keeps a click on a 40-row nav from
// blinking the whole column. It was only wrong in being written four times,
// with four names for the same map and four ways of forgetting to clear it.
//
// It is a helper, not an element, and it holds no DOM of its own: the body
// that builds the rows hands each row a ref, and the OWNER of the selection
// (the page — a place in the route, not a property of the rail) calls
// `select`. A body that changed its own selection on click would be a second
// source of truth for the URL; every survey surface routes the click out and
// lets the route call back in.

export class SelectionSync<K, C extends HTMLElement = ListCellLayout> {
  private refs = new Map<K, SelectionSync.Ref<C>>();
  private current: Option<K> = null;

  /** A slot for one row's cell. Hand it to `List.builder().row(…, { ref })`,
   * which fills `$cell` when the row is built. Keys must be unique per body;
   * a repeated key keeps the LAST ref and the earlier row never lights. */
  ref(key: K): SelectionSync.Ref<C> {
    const ref: SelectionSync.Ref<C> = { $cell: null };
    this.refs.set(key, ref);
    return ref;
  }

  /** Light exactly one row — or none, for `null`. The whole cost of a
   * selection change: one attribute per known cell. */
  select(key: Option<K>): void {
    this.current = key;
    this.apply();
  }

  selected(): Option<K> {
    return this.current;
  }

  /** The rows are about to be rebuilt: forget the cells, keep the key. Call
   * `apply` once the new refs are filled, and the remembered selection lands
   * on the new rows — the pattern `bind → clear → build → apply` every body
   * follows, so a data rebind never loses what the route had chosen. */
  clear(): void {
    this.refs.clear();
  }

  /** Re-flip every known cell against the current key. */
  apply(): void {
    for (const [key, ref] of this.refs) {
      ref.$cell?.toggleAttribute("selected", key === this.current);
    }
  }
}

export namespace SelectionSync {
  /** The ref shape `List.builder().row` fills. Any element that answers to a
   * `selected` attribute works; the default is the list cell because every
   * body in the kit is a `std-list` today. */
  export type Ref<C extends HTMLElement> = { $cell: Option<C> };
}
