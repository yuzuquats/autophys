import "../list/list-cell-layout";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { ListCellLayout } from "../list/list-cell-layout";

// A tree with the whole keyboard contract and no full re-render.
// `std-file-tree` speaks files, re-renders everything on toggle, and has no
// `role=tree`; `std-project-minitree` takes a domain key. This is `role=tree`
// with rows `role=treeitem aria-level aria-expanded aria-selected` and
// `role=group` children, one tab stop, and the WAI keys: Up/Down move,
// Right expands or descends, Left collapses or ascends, Home/End, Enter
// selects, `*` expands the siblings. Rows are keyed by id and reconciled —
// a toggle touches one subtree, never the whole tree — and selected state is
// a prop, so the caller owns it and rebinds.
//
// EXPANSION is the one piece of state the tree will keep for you, because it
// is the one piece that belongs to this column and to nothing else. Selection
// is a place in the app — it is in the hash — so it stays a prop and a
// callback; which branches happen to be open is not, and three surfaces were
// each keeping their own `Set<string>` and their own storage key to say so.
// `Expansion` is that choice made explicit: `"caller"` for a surface whose
// expansion genuinely lives somewhere else (the video editor writes it into
// the same record the groups themselves live in), `"owned"` for everyone else.
@component({ name: "std-tree-list" })
export class TreeList extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private props: Option<TreeList.Props>;
  /** Every row element by node id, in visible (flattened) order. */
  private rows: Map<string, HTMLElement> = new Map();
  private order: string[] = [];
  private focusedId: Option<string>;
  /**
   * The tree's own expansion, for `kind: "owned"`. Held as the set of branches
   * that are CLOSED rather than open, so a branch that appears in a later bind
   * — a project added while the page is up — inherits the default instead of
   * arriving collapsed because nothing had recorded it yet.
   */
  private closedIds: Set<string> = new Set();
  /** Whether `closedIds` has been seeded from storage for this binding. */
  private restoredKey: Option<string> = null;

  constructor() {
    super();
    this.$root.addEventListener("click", (e) => {
      const $row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
      if ($row == null) return;
      const id = $row.dataset.id ?? "";
      // The lead and chevron share a hit area; a transparent lead can still
      // be the event target while the chevron is visible above it.
      const onToggle = $row.hasAttribute("branch") && (e.target as Element).closest(".marks") != null;
      if (onToggle) this.toggle(id);
      else this.activate(id);
    });
    this.$root.addEventListener("keydown", this.onKeydown);
    this.$root.addEventListener("focusin", (e) => {
      const $row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
      if ($row == null) return;
      this.focusedId = $row.dataset.id ?? null;
      this.rove();
    });
  }

  bind(props: TreeList.Props): this {
    const wasSelected = this.props?.selectedId ?? null;
    this.props = props;
    this.restoreExpansion(props);
    const hadFocus = this.shadowRoot?.activeElement != null;
    this.setAttribute("role", "tree");
    this.setAttribute("aria-label", props.label);
    // Reconcile: reuse a row whose node id is still present, drop the rest,
    // build only what is new. Order and nesting are re-applied cheaply.
    const seen = new Set<string>();
    let $list = this.$root.firstElementChild as HTMLElement | null;
    if (!$list) {
      $list = document.createElement("ul"); $list.setAttribute("role", "none");
      this.$root.appendChild($list);
    }
    this.reconcileGroup($list, props.nodes, 1, seen);
    for (const [id, $row] of this.rows) if (!seen.has(id)) this.rows.delete(id);
    this.order = [...this.$root.querySelectorAll<HTMLElement>("[role=treeitem]")].map(($r) => $r.dataset.id ?? "");
    // A selection made from outside, while the keyboard is elsewhere, is
    // where the next Tab should land; one made from inside already moved
    // focus to the row it chose. A row that was collapsed away hands its
    // place to the nearest ancestor still on screen.
    const reselected = props.selectedId != null && props.selectedId !== wasSelected && this.rows.has(props.selectedId);
    this.focusedId = !hadFocus && reselected ? null : this.visible(this.focusedId);
    this.rove();
    // A collapsed focused descendant hands focus to its visible ancestor.
    // Unchanged rows stay connected, so their native focus needs no repair.
    if (hadFocus && this.shadowRoot?.activeElement == null) {
      this.$root.querySelector<HTMLElement>("[role=treeitem][tabindex='0']")?.focus();
    }
    return this;
  }

  private reconcileGroup($ul: HTMLElement, nodes: TreeList.Node[], level: number, seen: Set<string>): void {
    let $next = $ul.firstElementChild;
    for (const node of nodes) {
      seen.add(node.id);
      const $li = this.rows.get(node.id) ?? this.$row(node);
      this.rows.set(node.id, $li);
      this.applyRow($li, node, level);
      // Keep an already ordered row connected through expansion and selection.
      if ($li !== $next) $ul.insertBefore($li, $next);
      let $children = $li.querySelector<HTMLElement>(":scope > ul");
      if (node.children != null && this.isExpanded(node.id)) {
        if (!$children) {
          $children = document.createElement("ul"); $children.setAttribute("role", "group");
          $li.appendChild($children);
        }
        this.reconcileGroup($children, node.children, level + 1, seen);
      } else $children?.remove();
      $next = $li.nextElementSibling;
    }
    while ($next) {
      const $stale = $next; $next = $next.nextElementSibling; $stale.remove();
    }
  }

  /**
   * One row: a `std-list-cell-layout`, the primitive every other row in a rail
   * is built from, inside the `li` that carries the tree semantics.
   *
   * The cell owns the row BOX — padding, radius, hover, selected — so none of
   * that is drawn here twice; what stays is the three things a cell has no
   * opinion about: which level the row is at (the cell's inline-start
   * padding), which of the two marks is showing, and the guide down the side.
   *
   * The `li` keeps `role=treeitem` and the tab stop because the child `group`
   * has to live INSIDE the treeitem for the tree to be a tree; moving the role
   * onto the cell would put a row's children beside it instead of under it.
   */
  private $row(node: TreeList.Node): HTMLElement {
    const $li = document.createElement("li");
    $li.setAttribute("role", "treeitem");
    $li.dataset.id = node.id;
    $li.tabIndex = -1;
    const $line = ListCellLayout.make();
    $line.className = "line";
    // Both marks share ONE icon slot, because they are ONE mark: the twisty is
    // drawn on top of the lead in the same square, and a slot per mark would
    // have made that a negative margin.
    const $marks = document.createElement("span");
    $marks.className = "marks";
    $marks.slot = "icon";
    const $twisty = document.createElement("span");
    $twisty.className = "twisty";
    $twisty.setAttribute("aria-hidden", "true");
    const $lead = document.createElement("span");
    $lead.className = "lead";
    $marks.append($twisty, $lead);
    // `classList.add`, and the class is NOT "label". Typography carries the
    // SIZE as a class, so `className =` drops the `p` the element was built
    // with — and `label` is itself one of those size classes
    // (`--caption-size`), so naming the element after what it is re-sized
    // every row of every tree and nothing said so.
    const $label = Typography.p(node.label);
    $label.classList.add("name");
    $label.slot = "content";
    const $trail = document.createElement("span");
    $trail.className = "trail";
    $trail.slot = "accessory";
    $line.append($marks, $label, $trail);
    $li.appendChild($line);
    return $li;
  }

  private applyRow($li: HTMLElement, node: TreeList.Node, level: number): void {
    const props = this.props;
    $li.setAttribute("aria-level", String(level));
    $li.style.setProperty("--tree-level", String(level - 1));
    const branch = node.children != null;
    $li.toggleAttribute("branch", branch);
    if (branch) $li.setAttribute("aria-expanded", this.isExpanded(node.id) ? "true" : "false");
    else $li.removeAttribute("aria-expanded");
    // A row that cannot be selected is not a destination, and `aria-selected`
    // on it would advertise a state it can never enter. The attribute is
    // dropped rather than set false — a branch that only opens is furniture,
    // and furniture in a tree is announced by its expanded state alone.
    const selectable = TreeList.selectable(node);
    const selected = selectable && props?.selectedId === node.id;
    if (selectable) $li.setAttribute("aria-selected", selected ? "true" : "false");
    else $li.removeAttribute("aria-selected");
    $li.toggleAttribute("selected", selected);
    // The cell paints the selected band, so it is the cell that has to know.
    $li.querySelector(":scope > .line")?.toggleAttribute("selected", selected);
    const $label = $li.querySelector<HTMLElement>(":scope > .line > .name");
    if ($label != null && $label.textContent !== node.label) $label.textContent = node.label;
    // The twisty's glyph is a tree-wide prop, but it is written here because
    // this is the only place a row is (re)built and reconciled — a row created
    // by a later bind must get the same glyph as the rows created by the first.
    const $twisty = $li.querySelector<HTMLElement>(":scope > .line > .marks > .twisty");
    if ($twisty != null) {
      const icon = props?.twisty?.icon ?? null;
      if (icon == null) {
        if ($twisty.textContent !== "›") $twisty.replaceChildren("›");
      } else if ($twisty.querySelector("svg") == null) {
        const $svg = LonaIcons.$svg(icon);
        $svg.setAttribute("aria-hidden", "true");
        $twisty.replaceChildren($svg);
      }
    }
    const $lead = $li.querySelector<HTMLElement>(":scope > .line > .marks > .lead");
    if ($lead != null) {
      let $content: Option<Element> = node.$lead?.() ?? null;
      if (!$content && node.icon != null) {
        $content = LonaIcons.$svg(node.icon); $content.setAttribute("aria-hidden", "true");
      }
      if ($lead.firstChild !== $content || $lead.childNodes.length !== ($content ? 1 : 0)) {
        $lead.replaceChildren(...($content ? [$content] : []));
      }
      $lead.toggleAttribute("empty", node.$lead == null && node.icon == null);
    }
    const $trail = $li.querySelector<HTMLElement>(":scope > .line > .trail");
    if ($trail != null) {
      const $content = node.$trail?.() ?? null;
      if ($trail.firstChild !== $content || $trail.childNodes.length !== ($content ? 1 : 0)) {
        $trail.replaceChildren(...($content ? [$content] : []));
      }
      $trail.toggleAttribute("hidden", node.$trail == null);
    }
  }

  /**
   * Whether a click on this row navigates. A LEAF is always a destination —
   * a tree of names nobody can pick is a picture of a tree — so `selectable`
   * is read only on branches, where the two answers are both real: a shape in
   * the asset catalog names a group and nothing else, while "All tests" and a
   * video editor's project group are places you can actually be.
   */
  private static selectable(node: TreeList.Node): boolean {
    return node.children == null || node.selectable;
  }

  private isExpanded(id: string): boolean {
    const expansion = this.props?.expansion;
    if (expansion == null) return false;
    if (expansion.kind === "caller") return expansion.expandedIds.includes(id);
    return !this.closedIds.has(id);
  }

  /**
   * Seed `closedIds` once per storage key, from the key if there is one and
   * from `default` otherwise.
   *
   * The default is expressed as which branches are OPEN and stored as which
   * are closed, because those are two different questions asked at two
   * different times: the default answers "what should a reader who has never
   * been here see", and the store answers "what did this reader last close".
   * A stored set of open ids would silently answer the first question with the
   * second the moment a new branch appeared.
   */
  private restoreExpansion(props: TreeList.Props): void {
    if (props.expansion.kind !== "owned") return;
    const key = props.expansion.storageKey;
    if (key != null && this.restoredKey === key) return;
    if (key == null && this.restoredKey === "") return;
    this.restoredKey = key ?? "";
    this.closedIds = new Set();
    if (key != null) {
      try {
        const raw = localStorage.getItem(key);
        if (raw != null) {
          const saved: unknown = JSON.parse(raw);
          if (Array.isArray(saved)) {
            for (const id of saved) if (typeof id === "string") this.closedIds.add(id);
            return;
          }
        }
      } catch {
        // Storage can be unavailable or hold something else's value; the
        // default below is a working tree, which is the point of falling
        // through rather than throwing.
      }
    }
    const fallback = props.expansion.default;
    if (fallback === "all") return;
    if (fallback === "none") {
      TreeList.eachBranch(props.nodes, (node) => this.closedIds.add(node.id));
      return;
    }
    const open = new Set(fallback.openIds);
    TreeList.eachBranch(props.nodes, (node) => {
      if (!open.has(node.id)) this.closedIds.add(node.id);
    });
  }

  private static eachBranch(nodes: TreeList.Node[], visit: (node: TreeList.Node) => void): void {
    for (const node of nodes) {
      if (node.children == null) continue;
      visit(node);
      TreeList.eachBranch(node.children, visit);
    }
  }

  private persistExpansion(): void {
    const expansion = this.props?.expansion;
    if (expansion == null || expansion.kind !== "owned" || expansion.storageKey == null) return;
    try {
      localStorage.setItem(expansion.storageKey, JSON.stringify([...this.closedIds]));
    } catch {
      // Best effort; the tree still works for this page's life.
    }
  }

  private find(id: string, nodes: TreeList.Node[] = this.props?.nodes ?? []): Option<TreeList.Node> {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = n.children == null ? null : this.find(id, n.children);
      if (hit != null) return hit;
    }
    return null;
  }

  private parentOf(id: string, nodes: TreeList.Node[] = this.props?.nodes ?? [], parent: Option<TreeList.Node> = null): Option<TreeList.Node> {
    for (const n of nodes) {
      if (n.id === id) return parent;
      const hit = n.children == null ? null : this.parentOf(id, n.children, n);
      if (hit != null) return hit;
    }
    return null;
  }

  /**
   * One tab stop: the row the keyboard last stood on, else the selected one,
   * else the first. Focus is not selection — ArrowDown browses without
   * choosing — so Tab away and back must return to where the user was, not
   * to the selection they have already moved past.
   */
  private rove(): void {
    const stop = this.visible(this.focusedId) ?? this.visible(this.props?.selectedId ?? null) ?? this.order[0] ?? null;
    for (const [id, $row] of this.rows) $row.tabIndex = id === stop ? 0 : -1;
  }

  /** `id` if its row is on screen, else its nearest visible ancestor. */
  private visible(id: Option<string>): Option<string> {
    let at = id;
    while (at != null && !this.rows.has(at)) at = this.parentOf(at)?.id ?? null;
    return at;
  }

  private focusRow(id: string): void {
    this.focusedId = id;
    this.rove();
    this.rows.get(id)?.focus();
  }

  /** Open or close a branch, through whoever owns the answer. */
  private setExpanded(id: string, expanded: boolean): void {
    const expansion = this.props?.expansion;
    if (expansion == null) return;
    if (expansion.kind === "caller") {
      expansion.onToggle(id, expanded);
      return;
    }
    if (expanded) this.closedIds.delete(id);
    else this.closedIds.add(id);
    this.persistExpansion();
    // The caller does not rebind for an owned toggle, so the tree redraws
    // itself against the props it already holds.
    if (this.props != null) this.bind(this.props);
  }

  private toggle(id: string): void {
    const node = this.find(id);
    if (this.props == null || node == null || node.children == null) return;
    this.setExpanded(id, !this.isExpanded(id));
  }

  /**
   * A click or Enter on a row. A branch that is not a destination opens or
   * closes instead of navigating — which is the whole of what asset-studio's
   * `id.startsWith("shape:")` test was doing inside its own `onSelect`, moved
   * to the node that knows the answer.
   */
  private activate(id: string): void {
    const node = this.find(id);
    if (node == null) return;
    this.focusRow(id);
    if (!TreeList.selectable(node)) {
      this.setExpanded(id, !this.isExpanded(id));
      return;
    }
    this.props?.onSelect(id);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    const $row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (props == null || $row == null) return;
    const id = $row.dataset.id ?? "";
    const i = this.order.indexOf(id);
    const node = this.find(id);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        if (i < this.order.length - 1) this.focusRow(this.order[i + 1]);
        break;
      case "ArrowUp":
        if (i > 0) this.focusRow(this.order[i - 1]);
        break;
      case "ArrowRight":
        if (node?.children != null && !this.isExpanded(id)) this.setExpanded(id, true);
        else if (node?.children != null && i < this.order.length - 1) this.focusRow(this.order[i + 1]);
        break;
      case "ArrowLeft":
        if (node?.children != null && this.isExpanded(id)) this.setExpanded(id, false);
        else {
          const parent = this.parentOf(id);
          if (parent != null) this.focusRow(parent.id);
        }
        break;
      case "Home":
        if (this.order.length > 0) this.focusRow(this.order[0]);
        break;
      case "End":
        if (this.order.length > 0) this.focusRow(this.order[this.order.length - 1]);
        break;
      case "Enter":
      case " ":
        this.activate(id);
        break;
      case "*": {
        const parent = this.parentOf(id);
        const siblings = parent?.children ?? props.nodes;
        for (const s of siblings) if (s.children != null && !this.isExpanded(s.id)) this.setExpanded(s.id, true);
        break;
      }
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.rows.clear();
    this.order = [];
    this.focusedId = null;
    this.closedIds.clear();
    this.restoredKey = null;
    this.$root.replaceChildren();
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: TreeList.Props): TreeList {
    return TreeList.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        /* Where the first level's marks begin, measured from the tree's own
           box. A tree standing inside a rail sets this to the rail's row inset
           so its glyph column IS the rail's text edge, and the whole sidebar
           reads as one grid rather than a rail with a tree pushed into it. */
        --tree-inset: var(--tree-inset-preset, 4px);
        --tree-indent: var(--tree-indent-preset, 16px);
        --tree-row-height: var(--tree-row-height-preset, 28px);
        --tree-row-gap: var(--tree-row-gap-preset, 1px);
        /* A LIST CELL's own size, which is the point: a tree row and a
           std-list row are the same row, so a sidebar that has both — the
           video editor's project list beside a tree of the same projects —
           must not set them in two registers. The knob stays for a column
           that genuinely needs to be denser; the DEFAULT is the thing the
           cell would have picked on its own. */
        --tree-name-size: var(--tree-name-size-preset, var(--p-size));
        /* The one square every row's mark is drawn in — the twisty on a
           branch, the lead glyph on a leaf, nothing on a leaf that carries
           none. One number, because it is one box. */
        --tree-mark-size: 16px;
        --tree-guide-color: var(--divider);
        --tree-color: var(--text-sec);
        --tree-color-selected: var(--text-pri);
        /* The row's two bands, as presets, because a tree standing in a RAIL
           has to draw std-list's bands and not its own: a sidebar whose tree
           rows highlight a shade differently from the list rows beside them
           reads as two materials in one column, which is the divergence the
           kit exists to remove. The defaults stay the quieter pair — a tree
           of files in a content region wants them — and a rail overrides. */
        --tree-bg-hover: var(--tree-bg-hover-preset, var(--bg-hover-very-light));
        --tree-bg-selected: var(--tree-bg-selected-preset, var(--bg-surface-light));

        display: block;
        width: 100%;
      }

      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      /* Where this row's marks begin: the line's text inset, the absolute
         twisty's left edge, and the guide beside this row's children are all
         the same number, so they cannot drift apart. Declared on the row
         because that is where --tree-level lives; a child ul inherits its
         PARENT's value, which is exactly the column the guide belongs in. */
      li {
        --tree-mark-inset: calc(var(--tree-inset) + var(--tree-level, 0) * var(--tree-indent));

        outline: none;
      }

      /* THE ROW IS A CELL. std-list-cell-layout draws the box — the padding,
         the radius, the hover tint, the selected band — so this rule hands it
         the four facts a cell cannot know and draws nothing itself:

           the LEVEL, as the cell's inline-start padding, which is the one
             number the whole row hangs off (see the li rule above);
           the HEIGHT. The host is a GRID, one explicit row tall, because a
             grid item stretches on BOTH axes: as a flex host, the cell's own
             #root is a flex ITEM and sizes to its content, so a name long
             enough to overflow pushed #root past the row instead of
             ellipsizing inside it. Cross-axis stretch alone fixes one axis or
             the other depending on the direction; a grid track fixes both.
             The cell's trailing catch-all slot takes an implicit row and is
             empty, so it measures 0. --cell-align then centres the slots
             inside the track;
           the two COLOURS, which the cell reads through its own knobs rather
             than from a rule this sheet could not reach into the shadow to
             write;
           and the row GAP.

         The gap goes on the ROW, not between the list items. Rows that follow
         one another are not always siblings — a branch's row is followed by
         the first row of its own child group, one level down the tree — so an
         adjacent-sibling rule separates some pairs and misses exactly the pair
         a reader looks at most. A bottom margin on every row separates it from
         whatever comes next, wherever that lives. It exists so the hover and
         selected bands do not touch: two of them meeting edge to edge read as
         one taller band with a notch rather than as two rows. */
      .line {
        --list-cell-padding: 0 8px 0 var(--tree-mark-inset);
        --list-cell-layout-hover-color: var(--tree-bg-hover);
        --list-cell-selected-background-color: var(--tree-bg-selected);
        --cell-align: center;

        display: grid;
        grid-template-rows: var(--tree-row-height);
        height: var(--tree-row-height);
        margin-block-end: var(--tree-row-gap);
        color: var(--tree-color);
        cursor: pointer;
      }

      .line[selected] {
        color: var(--tree-color-selected);
      }

      /* The ring goes on the cell, not on the li: the li also contains the
         child group, so an outline there would encircle a whole open subtree.
         The host's border box IS the row, which is what the cell fills. */
      li:focus-visible > .line {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
        border-radius: 8px;
      }

      /* ---- ONE MARK, ONE COLUMN ----

         A folder and a file are the same row. Each has exactly one mark square
         at the head of its content, always the same size and always in the
         same place for its level, and what goes IN it is the only difference:
         a branch draws its twisty, a leaf draws whatever glyph it carries, and
         a leaf carrying nothing keeps the square empty. The square is reserved
         either way — that is what makes every name on a level start at the
         same x, so the step from a parent's name to its child's is exactly one
         --tree-indent and nothing else.

         This used to be TWO boxes side by side: a twisty column that only
         branches drew in, then a lead column that existed only if some row in
         the whole tree carried an icon. Two boxes meant a folder and a file
         were different shapes — a file's name sat a whole square and gap
         further in than its folder's, or the tree spent a permanent empty
         column on rows that would never fill it. One box is the same node
         drawn twice.

         The cell's 8px icon gutter is restated as the tree's 6px. A rule here
         beats the cell's own ::slotted default, because for slotted content
         the tree the element LIVES in wins. */
      .marks {
        position: relative;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        width: var(--tree-mark-size);
        height: var(--tree-mark-size);
        margin-right: 6px;
      }

      /* The twisty is out of flow, stacked ON the square rather than beside
         it, so a branch that also carries a glyph can trade one for the other
         without either moving. Against the MARKS box rather than the row: the
         marks box already sits at this level's inset, so the twisty needs no
         arithmetic to find it. */
      .twisty {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--tree-mark-size);
        height: var(--tree-mark-size);
        color: var(--text-ter);
        opacity: 0;
        transition: opacity 0.12s ease, transform 0.15s ease;
      }

      li[aria-expanded="true"] > .line .twisty {
        transform: translateY(-50%) rotate(90deg);
      }

      /* A branch with no glyph of its own has nothing to trade with, so its
         twisty simply IS its mark and stands there always. The twisty precedes
         the lead in the DOM, so a sibling combinator cannot reach back to it;
         :has on the row is what expresses "this branch has no icon". The child
         combinators are load-bearing: a bare :has(.lead[empty]) also matches a
         branch whose CHILDREN have empty leads, which is every branch in a
         tree of plain names, and the chevron would then sit on top of a glyph
         at rest. */
      li[branch]:has(> .line > .marks > .lead[empty]) > .line .twisty {
        opacity: 1;
      }

      /* ...and a branch that DOES carry one shows the glyph at rest and trades
         it for the chevron under the pointer or the keyboard. Only a branch
         trades: a leaf has nothing to expand, so its glyph must never blink
         out from under the pointer. */
      li[branch] > .line:hover .twisty,
      li[branch]:focus-visible > .line .twisty {
        opacity: 1;
      }

      li[branch] > .line:hover .lead,
      li[branch]:focus-visible > .line .lead {
        opacity: 0;
      }

      /* Size only — no fill. A CSS fill property beats the SVG's own fill="none"
         presentation attribute, so forcing one here (as .lead does, because
         lead glyphs are solid) turns a stroked chevron into a filled wedge.
         The mark's own markup decides whether it is drawn or filled; both
         inherit their colour from the row through currentColor. */
      .twisty > svg {
        width: 100%;
        height: 100%;
      }

      /* The lead fills the square and centres whatever it is given, because a
         caller's own element is not always a full-bleed glyph — the ux-tests
         console hands it an 8px status dot, and a dot pinned to the corner of
         a 16px box is not in the column at all.

         [empty] keeps the box and drops its contents. It is NOT display: none
         and it is not the hidden attribute: the square is the row's mark
         column, and a row with nothing to put in it still stands in that
         column. That is the whole of what makes a file and a folder the same
         row. */
      .lead {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--tree-mark-size);
        height: var(--tree-mark-size);
        transition: opacity 0.12s ease;
      }

      .lead[empty] {
        visibility: hidden;
      }

      .lead > svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      .name {
        --font-size: var(--tree-name-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* No margin-inline-start: auto any more — the cell's accessory slot is
         already held to the trailing edge, and its content slot is the one
         that grows. That is the third hand-drawn arrangement the cell
         replaced. */
      .trail {
        flex: 0 0 auto;
        padding-inline-start: 8px;
        display: inline-flex;
        align-items: center;
        color: var(--text-ter);
      }

      .trail[hidden] {
        display: none;
      }

      /* A guide down the left of each group, in the PARENT's mark column —
         under the twisty that opened it, clear of the children's own marks.
         It is the child group that draws it, and it inherits --tree-mark-inset
         from the row it hangs under, which is exactly the column it belongs
         in. */
      li > ul {
        position: relative;
      }

      /* :not(:empty) because an OPEN branch with no children has nothing to
         guide, and a guide with nothing beside it is a stub hanging under a
         row. An empty branch is a real state — a corpus whose last group was
         filtered out keeps its twisty — so this is not a case that cannot
         happen. */
      li > ul:not(:empty)::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: calc(var(--tree-mark-inset) + var(--tree-mark-size) / 2);
        width: 1px;
        background: var(--tree-guide-color);
      }

      @media (prefers-reduced-motion: reduce) {
        .twisty,
        .lead {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace TreeList {
  export type Node = {
    id: string;
    label: string;
    icon: Option<LonaIcons.RawSvg>;
    /** `null` is a leaf; an empty array is an empty branch. */
    children: Option<Node[]>;
    $lead: Option<() => HTMLElement>;
    /** Drawn at the row's trailing edge — a count, a status dot, a size.
     * Built lazily and replaced on every `applyRow`, exactly as `$lead` is, so
     * a caller may return a fresh element per bind without leaking the old. */
    $trail: Option<() => HTMLElement>;
    /**
     * Whether clicking this BRANCH navigates. Read only on branches — a leaf
     * is always a destination.
     *
     * `false` is a branch that names a group and nothing else: the asset
     * catalog's output shapes, where selecting one would navigate to nothing,
     * so a click opens or closes it instead. `true` is a branch that is also a
     * place: the ux-tests console's per-project "All tests", a video editor
     * project group that filters the library to itself.
     */
    selectable: boolean;
  };

  /**
   * How the expand mark is drawn. There is no placement choice any more: the
   * twisty and the lead are one square, always, because a folder and a file
   * are the same row. A branch with no glyph of its own shows its twisty
   * there permanently; a branch that has one shows the glyph and trades it for
   * the chevron under the pointer.
   */
  export type Twisty = {
    /** The glyph. `null` keeps the built-in text chevron. */
    icon: Option<LonaIcons.RawSvg>;
  };

  /**
   * Who owns which branches are open.
   *
   * `"caller"` when the answer already lives somewhere else and must not fork
   * into a second store — the video editor keeps a group's collapse in the
   * same `ProjectGroups` record the group itself lives in, and a tree holding
   * its own copy would disagree with it the first time a group was renamed in
   * another tab.
   *
   * `"owned"` otherwise, which is most trees. `storageKey` is per SURFACE, not
   * per component: two consoles that show the same tree are two readers with
   * two opinions about what is worth having open, and one hard-coded key made
   * /dev and /docs share a collapse state until `defaultExpanded` was invented
   * to opt one of them out.
   */
  export type Expansion =
    | { kind: "caller"; expandedIds: string[]; onToggle: (id: string, expanded: boolean) => void }
    | {
        kind: "owned";
        storageKey: Option<string>;
        /** What a reader who has never been here sees. */
        default: "all" | "none" | { openIds: string[] };
      };

  export type Props = {
    nodes: Node[];
    selectedId: Option<string>;
    onSelect: (id: string) => void;
    expansion: Expansion;
    /** The tree's accessible name. */
    label: string;
    /** `null` is the default: a text chevron in its own column. */
    twisty: Option<Twisty>;
  };
}
