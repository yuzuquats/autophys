import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { List } from "../list/list";
import { RailSection } from "./rail-section";
import { SelectionSync } from "./selection-sync";

// The simple sidebar layout: sections of rows, one selection, clicks routed
// out.
//
// `std-rail-section` settled what a group's label looks like and
// `SelectionSync` settled how a row lights, but neither says how the two go
// together — so every body still wrote the assembly by hand, and wrote the
// same one. docs-nav had `sectionBlock` + `sectionList`; admin-nav had a
// builder loop over a route table; ux-rail, acme and the spool rail each have
// their own copy of the same twelve lines. They agree on all of it: a title
// (or no title), a `std-list` under it, one `ref` per row, and a click that
// calls OUT rather than selecting in place.
//
// That assembly is this element. A body that is a flat run of labelled groups
// now has nothing left to write but its model.
//
// What it deliberately is not: a data source, a router, or a tree. It never
// selects on click — the click is routed out and the owner of the route calls
// `select` back in, because the selection is a place in the app and not a
// property of the column (the rule SelectionSync was extracted under, kept
// here where it is easiest to break). Rows that contain rows are
// `std-tree-list`, a different element with expansion state and a keyboard
// contract; this one is flat on purpose, and a sidebar holding both keeps one
// material because both are built from the same list cell.

@component({ name: "std-rail-nav" })
export class RailNav extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private selection: SelectionSync<string> = new SelectionSync();
  // Whether `selection` is ours to clear. A caller that passes its own sync
  // is sharing ONE selection across several navs (docs-nav: one per library,
  // and only one row in the whole accordion may be lit). Clearing on rebind
  // would then drop the sibling navs' refs, and every library but the last
  // would go dark on the next render. The owner of a shared sync clears it
  // once, around the whole rebuild.
  private ownsSelection: boolean = true;
  private onSelect: Option<(key: string) => void> = null;

  bind(model: RailNav.Model): this {
    this.selection = model.selection ?? this.selection;
    this.ownsSelection = model.selection == null;
    this.onSelect = model.onSelect ?? null;

    DomUtils.clearChildren(this.$root);
    if (this.ownsSelection) {
      this.selection.clear();
    }
    for (const section of model.sections) {
      this.$root.appendChild(this.renderSection(section));
    }
    if (this.ownsSelection) {
      this.selection.apply();
    }
    return this;
  }

  /** Light the row with this key, or none for `null`. Valid on an owned
   * selection; with a shared one, call `select` on the sync itself so every
   * nav sharing it agrees. */
  select(key: Option<string>): void {
    this.selection.select(key);
  }

  selected(): Option<string> {
    return this.selection.selected();
  }

  private renderSection(section: RailNav.Section): HTMLElement {
    const $list = this.renderRows(section.rows);
    // No title means no header — the bare list. A section that drew an empty
    // label would spend its 10px+8px of air on nothing, which is how a
    // library with no grouping used to sit lower than one with it.
    if (section.title == null || section.title === "") {
      return $list;
    }
    return RailSection.makeWith(
      { title: section.title, count: section.count ?? null },
      $list,
    );
  }

  private renderRows(rows: RailNav.Row[]): HTMLElement {
    let builder = List.builder();
    for (const row of rows) {
      builder = builder.row(row.label, {
        $icon: row.$icon ?? undefined,
        $accessory: row.$accessory ?? undefined,
        ref: this.selection.ref(row.key),
        pointerEvents: {
          onClick: (_$el, _offset, e) => {
            // Anchors are the common row content and a navigating body is
            // about to do its own routing; letting the browser follow the
            // href as well would load the page twice.
            e.preventDefault();
            this.onSelect?.(row.key);
          },
        },
      });
    }
    return builder.build();
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$root);
    this.onSelect = null;
    if (this.ownsSelection) {
      this.selection.clear();
    }
  }

  static makeWith(model: RailNav.Model): RailNav {
    return RailNav.make().bind(model);
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

export namespace RailNav {
  export type Row = {
    /** What `select` matches on, and what a click hands back. A path, a route
     * key, an id — the nav never reads it, so it is whatever the owner of the
     * selection already keys by. Unique per nav: a repeated key keeps the last
     * row and the earlier one never lights. */
    key: string;
    label: string;
    $icon?: Option<HTMLElement>;
    $accessory?: Option<HTMLElement>;
  };

  export type Section = {
    /** Absent or blank draws no header at all, rather than an empty one. */
    title?: Option<string>;
    /** Beside the title; `null` and `0` both omit it. */
    count?: Option<number>;
    rows: Row[];
  };

  export type Model = {
    sections: Section[];
    /** A row was clicked. The nav does NOT light it — route, then call
     * `select` (or the shared sync's) with what the route resolved to. */
    onSelect?: Option<(key: string) => void>;
    /** Share one selection across several navs. Absent, the nav keeps its own
     * and clears it on every bind; present, the CALLER owns the clear. */
    selection?: Option<SelectionSync<string>>;
  };
}
