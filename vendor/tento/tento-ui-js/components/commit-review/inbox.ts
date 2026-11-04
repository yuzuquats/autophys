import { Point } from "@tento-core/point";
import { Position } from "../../anchor-positioning-utils";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { ButtonGroupRow } from "../button-group-row";
import { ContextMenu } from "../context-menu";
import { Table } from "../table/table";
import { agentActive, faceFor } from "./agent-face";
import { $nodePalette, CHILD_INDENT, ICON_GAP, ICON_W, InboxCell } from "./inbox-cell";
import { InboxValue } from "./inbox-value";
import { StackLog } from "./stack-log";

// The review inbox: the subsidebar's OTHER view. Where the stack rail is a
// truthful git log — stack-ordered, one row per commit — the inbox answers
// the one question the log structurally cannot: "what needs me first?"
// One row per project (plus ungrouped drafts as themselves), grouped into
// turn sections — needs you → with the agent → settled — plus a separate
// mirrored bay for borrowed, read-only work, and sorted
// oldest-waiting-first inside each, so the row that waited longest
// outranks the loudest. No lane, no graph: attention order deliberately
// abandons stack order, and drawing a lane over it would misreport the
// order commits sink in.
//
// Rows are a real TABLE — `std-table` (components/table) does the column
// layout, so cross-row alignment, the header, row height, hover and the
// selected band are the table system's rather than five hand-rolled `ch`
// widths. One table per turn section: `Table.Group` carries no label chrome
// of its own (it is `{id, filter, showRowDividers}`, and the grouped path
// emits bodies separated by a 1px divider — nothing labelled), and the
// section name + count is load-bearing here, so each section is its own
// table and the section name rides that table's OWN header in the primary
// column slot. The field labels are printed once, on the first section.
//
// Every per-item fact other than the title is a [`ReviewInbox.Field`] the
// operator can PLACE: as its own table column, folded into the caption line
// under the title, or hidden. The table has no column-visibility affordance
// of its own, so placement is a compact `ContextMenu` — one field per row,
// with its three placements beside it — and the component fires
// `onLayoutChange` so the OWNER persists it.
//
// The TRIGGER is the owner's too: `bindColumnsTrigger($anchor)` wires up any
// element the owner supplies, and the rail head hands it an icon button
// beside reload and collapse.
// The inbox used to carry its own right-aligned `columns` verb on a bar
// above the tables, which spent a row of a 300px rail on one word and put a
// second, differently-shaped control register directly under the header's
// buttons. A view's controls belong with the view's other controls — and
// the button sits in the slot the stack view's flat/nodes toggle occupies,
// so the header holds exactly three buttons either way.
//
// Right-clicking a project row opens the same primitive with the row's own
// verbs: open, and hold ⇄ resume. HELD items leave their turn section for a fourth
// "On hold" section at the bottom — the operator parks a project to keep the
// working set small, and the medallion keeps telling the truth about its
// state while it sits there. The project node owns the durable decoration;
// the component reports one requested mutation through `onSetHeld`.
//
// Project rows EXPAND: hovering the medallion swaps it for the rail's
// disclosure chevron, and clicking there splices the project's member
// commits in as child rows of the same table (the split affordance
// stack-log's container rows already teach — every other pixel of the row
// still selects the project). The table has no notion of hierarchy, so
// expansion is consumer state: a Set of open keys here, and the owning
// section's row list is rebuilt and re-bound around it.
//
// Cell innards are built by two nested components
// (`std-review-inbox-cell`, `std-review-inbox-value`) rather than plain
// elements, because a table cell is mounted inside `std-table-body`'s
// shadow root, out of reach of this component's stylesheet — Typography
// included. Each is its own module (`inbox-cell.ts`, `inbox-value.ts`)
// with its own storybook: they bind presentational models, not this
// component's rows, so this file's job is deciding — turns, sections,
// placements, widths — and theirs is painting.
//
// The component never fetches. The owner (std-stack-review) assembles
// items across every configured repo — the inbox spans repos, unlike the
// per-tab rail — and routes clicks back through `onSelect(item)`,
// switching repo tabs when the item lives elsewhere.

/** Column order, and row order in the popover. Fixed: a table whose columns
 * reorder under you is not a table. */
const FIELD_ORDER: ReviewInbox.Field[] = [
  "repo",
  "plans",
  "drafts",
  "id",
  "owner",
  "agent",
  "age",
  "pips",
];

/** The `agent` field's evidence, in precedence order.
 *
 * STRONGEST — an assignment. The service minted a spool job for this round
 * (`Item.assignment`); an agent holds, or will hold, a session addressing
 * it. This is the one state that is also a DOOR: the cell opens the
 * assignment's thread (`onOpenAgent`), because a claim you can talk to is
 * categorically different from evidence you can only read.
 *
 * NEXT — a live monitor. The service reports which identities are
 * currently attached to a change (`GET /api/watchers`); the owner filters
 * that to the fresh ones and folds it into `Item.watcher`. That is PRESENCE,
 * not inference: someone has this open right now, which is the thing the
 * operator actually wants to know before picking up a project.
 *
 * FALLBACK — commit evidence. With no watcher, a member commit younger than
 * AGENT_RECENT_S is all that is left to say anyone has been here. Strictly
 * weaker: an agent that is watching without having committed yet reads as
 * nothing, which is exactly why presence outranks it rather than blending
 * with it — the two glyphs stay distinct (● watched, ○ recent commit) so a
 * filled dot never means "probably".
 *
 * UPGRADE PATH — ownership heartbeats (commit-review-inbox plan,
 * ownership.md) retire the commit fallback entirely once they land. Evidence
 * either way, never a claim. */
const AGENT_RECENT_S = 6 * 60 * 60;

const PLACEMENT_ORDER: ReviewInbox.Placement[] = ["column", "caption", "hidden"];

/** Popover widths. `ContextMenu.builder` takes a fixed px width, and the
 * columns menu is right-aligned under its button, so the width is also what
 * the anchor point is computed from. */
const COLUMNS_MENU_W = 286;
const ROW_MENU_W = 132;

/** The shipped table: the numbers and the age as columns; `repo` and the
 * handle ride the caption. Both are legible there, and at the rail's default
 * 300px a `repo` column starves the title — the one cell that must never
 * lose (re-observed the day this shipped: every slug ellipsized, the age
 * column crushed to "a…"). The strip's floor is its header labels, so
 * column count is the real width budget; promote `repo` back on a widened
 * rail via the `columns` menu. */
const LAYOUT_DEFAULT: ReviewInbox.Layout = {
  repo: "caption",
  // Nearly every project has exactly one plan, so the plans column spends
  // ~40px saying "1" — and the fourth column is what pushed the header
  // into ellipsis at the rail's default 300px (the table shrinks columns
  // under viewport pressure, headers first). Caption placement keeps the
  // count readable where it varies; promote it back on a wider rail.
  plans: "caption",
  drafts: "column",
  owner: "column",
  agent: "caption",
  age: "column",
  id: "caption",
  pips: "caption",
};

/** Sections in reading order. Neither bookend is a turn: `pinned` is
 * somebody ASKING for a project to be next — usually an agent, blocked
 * behind the verdict — and `hold` is the operator parking one. Both outrank
 * the turn model, in opposite directions, so they sit at opposite ends: the
 * requests first, where the eye lands, and the parked work last. */
type SectionId = ReviewInbox.Turn | "mirrored" | "hold" | "pinned";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "yours", label: "Needs you" },
  { id: "theirs", label: "With the agent" },
  { id: "settled", label: "Settled" },
  { id: "mirrored", label: "Mirrored" },
  { id: "hold", label: "On hold" },
];

/** One derivation of what the inbox renders: the sections that have rows, and
 * the column placement and priced widths their tables are built from. Local,
 * not on the namespace — it names `Row` and `SectionId`, which are this
 * module's own. */
type TablePlan = {
  columns: ReviewInbox.Field[];
  captions: ReviewInbox.Field[];
  sections: { id: SectionId; label: string; rows: Row[] }[];
  widths: Map<ReviewInbox.Field, number>;
};

/** Field column widths are px, because `Table.Column.Spec.width` is px — and
 * an EXPLICIT width is also what makes the sections' separate tables agree
 * without measuring anything (natural widths are measured off the header,
 * which is labelled on the first section and blank on the others). Content
 * is priced at one small-size glyph ≈ 7px and clamped, so a fleet's
 * `host · repo` cannot eat the title column in a 300px rail. */
const CH_PX = 7;
/** Per-column slack beyond the glyph estimate: the header cell spends real
 * pixels on its own padding and hover chrome, and pricing only the glyphs
 * ellipsized every label at exactly its clamp ("age…" over a 44px agent
 * column — observed). */
const COLUMN_PAD_PX = 14;
const COLUMN_MIN_W = 30;
const COLUMN_MAX_W: Record<ReviewInbox.Field, number> = {
  repo: 88,
  plans: 54,
  drafts: 58,
  id: 78,
  owner: 92,
  agent: 58,
  age: 46,
  pips: 88,
};

/** Roomy on purpose (operator rounds 7–8): 30px/4px read as cramped once
 * the rows grew a caption line and sat in bordered sections. 34px gives the
 * title + caption pair its own air while the rail still holds a working
 * set on one screen. */
const ROW_HEIGHT = 34;
const CELL_PADDING = 8;
/** The hover/selection band's inset from the rail edges (round 8: wider
 * than the rail's own 8px gutters, so the band reads as a chip inside the
 * rail rather than a full-bleed stripe). */
const CONTAINER_MARGIN_INLINE = 10;
/** The row's own block padding — the divider's lane (rounds 8–9). The band
 * (the table row's shadow `#root`) sits INSIDE the host, so host padding
 * insets it, and the divider — painted on the host's background, i.e.
 * absolutely positioned at the host's top edge — lands in the strip the
 * padding opens up, never under the band. The asymmetry centers the line:
 * with the body's 1px row gap, a line at the very top of a 4px top pad
 * sits 3px clear of the band above (2px bottom pad + 1px gap) and 3px
 * clear of the band below. */
const ROW_PAD_TOP = 4;
const ROW_PAD_BOTTOM = 2;
/** Floor for the title column, so a squeezed rail ellipsizes titles rather
 * than collapsing them to nothing. */
const PRIMARY_MIN_W = 90;

/** What the table actually renders: an item plus the bookkeeping the table
 * needs (`id`) and the tree state the table has no concept of. A member row
 * IS a `ReviewInbox.Item`, which is what lets a child row route back out
 * through `onSelect` on exactly the path a top-level row takes. */
type Row = ReviewInbox.Item & {
  id: string;
  child: boolean;
  /** Indent level: 0 top level, 1 a project's own commit, 2 a commit (or the
   * header) of a MEMBER PROJECT nested under a master project. `child` is
   * `depth > 0` — kept as its own flag because it also selects the quieter
   * title color, which is about being nested at all, not about how deep. */
  depth: number;
  expandable: boolean;
  expanded: boolean;
  held: boolean;
  /** The hairline above this row: none on a section's first row (sections
   * separate by whitespace, not lines), `child` on a nested row (deeper
   * inset, lighter tint), `row` otherwise — which makes the divider under
   * an open project's LAST child the next project's own, at full strength
   * and top-level inset, closing the indented run visually. */
  divider: "none" | "row" | "child";
};

/** Row dividers, drawn on the table's row element rather than by the table
 * (rounds 7–8): the table's own divider is an edge-to-edge hairline plus
 * 3px of block margin, and the ruling is that a divider STARTS AT THE
 * TEXT — aligned to the title, one indent deeper again on a child row —
 * and runs to the row's end, sitting BETWEEN the hover bands rather than
 * under them (the `ROW_PAD_*` lane). Painted as a background gradient
 * because a border would add its pixel to the table's fixed row height. */
const DIVIDER_INSET = CONTAINER_MARGIN_INLINE + CELL_PADDING + ICON_W + ICON_GAP;

function applyRowDivider($row: HTMLElement, divider: Row["divider"], depth: number): void {
  // Every row carries the lane, divider or not — uniform pitch is what
  // makes the missing first-row divider read as air, not as a glitch.
  $row.style.paddingTop = `${ROW_PAD_TOP}px`;
  $row.style.paddingBottom = `${ROW_PAD_BOTTOM}px`;
  if (divider === "none") {
    $row.style.backgroundImage = "";
    return;
  }
  // A divider touching a child row is lighter: the seam inside an open
  // project is structure, not separation, and full-strength hairlines
  // there read as more projects.
  const color =
    divider === "child"
      ? "color-mix(in srgb, var(--divider) 55%, transparent)"
      : "var(--divider)";
  // A nested row's divider starts where its OWN title does, so a member
  // project's commits (depth 2) inset twice.
  const inset = DIVIDER_INSET + (divider === "child" ? Math.max(1, depth) * CHILD_INDENT : 0);
  $row.style.backgroundImage = `linear-gradient(${color}, ${color})`;
  $row.style.backgroundRepeat = "no-repeat";
  $row.style.backgroundPosition = `${inset}px top`;
  $row.style.backgroundSize = `calc(100% - ${inset + CONTAINER_MARGIN_INLINE}px) 1px`;
}

// The cell primitives live in their own modules — `inbox-cell.ts` (the
// primary cell: medallion ⇄ chevron, title, caption) and `inbox-value.ts`
// (a field column's right-aligned cell) — each reviewable alongside its own
// storybook. The icon-slot constants the divider inset math shares come
// from the cell's module, so the two cannot drift.

@component({ name: "std-review-inbox" })
export class ReviewInbox extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  /** Set by the owner: a row was clicked. A member row reports its own
   * synthesised item, so the owner's routing stays one path, not two. */
  onSelect: Option<(item: ReviewInbox.Item) => void> = null;

  /** Set by the owner: the operator moved a field between column, caption
   * and hidden. A view preference, so the OWNER persists it — the component
   * only knows what is showing right now. */
  onLayoutChange: Option<(layout: ReviewInbox.Layout) => void> = null;

  /** Set by the owner: persist one project hold mutation. */
  onSetHeld: Option<(item: ReviewInbox.Item, held: boolean) => Promise<void>> = null;

  /** Set by the owner: persist one project pin mutation. The component never
   * supplies a reason — an operator pinning from this menu is looking at the
   * row as they do it; a reason is what the API asks of AGENTS, which are
   * pinning work nobody is currently looking at. */
  onSetPinned: Option<(item: ReviewInbox.Item, pinned: boolean) => Promise<void>> = null;
  /** Hand this project's round to a fresh agent. Unlike hold and pin there is
   * nothing optimistic to paint — the row does not move and no decoration
   * changes until the service answers with a job — so the component simply
   * reports the request and waits for the owner to re-bind. */
  onAssign: Option<(item: ReviewInbox.Item) => Promise<void>> = null;

  /** Set by the owner: open the conversation with the agent on this row —
   * the assignment's spool thread. Reported only from rows carrying an
   * assignment; presence-only evidence (a watcher, a recent commit) names
   * nobody drivable, so those rows have no thread to open. */
  onOpenAgent: Option<(item: ReviewInbox.Item) => void> = null;

  private items: ReviewInbox.Item[] = [];
  private bound = false;
  private selectedKey: Option<string> = null;
  private layout: ReviewInbox.Layout = { ...LAYOUT_DEFAULT };
  private compact = false;
  /** Open project rows, by item key. Session state, deliberately: which
   * project you have pulled apart is a reading position, not a preference,
   * and it has to survive the background refresh that lands under you — so
   * it lives here rather than in the item list the owner rebuilds. */
  private expanded = new Set<string>();
  /** One table per section, so opening a project re-binds only its own
   * section instead of repainting the inbox. */
  private tables = new Map<SectionId, Table<Row>>();
  /** What the showing tables were BUILT from — every input to their view
   * models except the row lists themselves (see [`shapeOf`]). A refresh that
   * agrees with this can swap row lists into the standing tables; one that
   * disagrees has genuinely changed the inbox's structure and re-renders. */
  private shape: Option<string> = null;

  bind(items: ReviewInbox.Item[]): void {
    this.items = items;
    this.bound = true;
    // Projects that went away take their open state with them, or the sets
    // grow without bound across a long session.
    const live = new Set(items.map((i) => i.key));
    for (const key of [...this.expanded]) {
      if (!live.has(key)) this.expanded.delete(key);
    }
    // A background refresh is the COMMON case and almost never changes the
    // inbox's shape — same sections, same counts, same column widths, new
    // review state inside the rows. `render` answers that with
    // `replaceChildren`, which drops every table shell and every header, so
    // the reader's scroll had nothing left to hold and the inbox jumped
    // under them once per refresh. Patch when only the rows moved; re-render
    // only when the structure actually did.
    if (this.patch()) return;
    this.render();
  }

  /** Swap row lists into the standing tables. Returns false when a full
   * render is required — the caller must then do one.
   *
   * The guard is [`shapeOf`], not a guess: every input the view models were
   * built from has to be byte-equal, because a table whose columns, widths or
   * header changed cannot be patched by handing it new rows. When they are
   * equal the section's height is unchanged too (rows are fixed-height —
   * `ROW_HEIGHT`), which is what makes the scroll carry below EXACT rather
   * than approximate. That is the difference from the rail, where the
   * hand-restore was retired for being neither: there rows have varying
   * height, so the offset it restored was only ever nearly right. */
  private patch(): boolean {
    if (!this.bound || this.compact || this.items.length === 0) return false;
    if (this.shape == null || this.tables.size === 0) return false;
    const plan = this.tablePlan();
    if (ReviewInbox.shapeOf(plan) !== this.shape) return false;
    // One read, on the path that replaced a whole-subtree rebuild — and only
    // written back if the table's own mutate pass actually moved it.
    const $scroller = this.scrollParent();
    const scroll = $scroller?.scrollTop ?? 0;
    const pending: Promise<void>[] = [];
    for (const section of plan.sections) {
      const $table = this.tables.get(section.id);
      if ($table == null) return false;
      $table.bindItems(section.rows).bindSelectedItem(this.selectedKey);
      if ($table.itemsReadyPromise != null) pending.push($table.itemsReadyPromise);
    }
    if ($scroller != null && pending.length > 0) {
      void Promise.all(pending).then(() => {
        if ($scroller.scrollTop !== scroll) $scroller.scrollTop = scroll;
      });
    }
    return true;
  }

  /** The scrolling ancestor the inbox is painted into — the owner's rail,
   * which is also the stack log's scroller. Found rather than injected so the
   * component keeps working standalone (the storybook has no rail), where
   * this is simply null and the carry is skipped. */
  private scrollParent(): Option<HTMLElement> {
    let $n: Option<HTMLElement> = this.parentElement;
    while ($n != null) {
      if ($n.scrollHeight > $n.clientHeight) {
        const overflow = getComputedStyle($n).overflowY;
        if (overflow === "auto" || overflow === "scroll") return $n;
      }
      $n = $n.parentElement;
    }
    return null;
  }

  /** Set by the owner from its stored preference. Re-renders off the cached
   * items, so restoring a layout costs no refetch. */
  /** Every row key this surface can show, including the members spliced under
   * a project. The rail's log answers the same question for its own rows, and
   * a selection is valid if EITHER can show it — the inbox spans repos and
   * carries project containers the log does not render in flat mode, so
   * validating against the log alone silently discards them. */
  keys(): string[] {
    const keys: string[] = [];
    for (const item of this.items) {
      keys.push(item.key);
      for (const m of item.members ?? []) keys.push(m.key);
    }
    return keys;
  }

  setLayout(layout: ReviewInbox.Layout): void {
    this.layout = { ...layout };
    this.render();
  }

  /** Mirrors the rail's compact treatment: the owner collapsed the rail to
   * its 52px strip. The table is NOT asked to lay five columns out in 52px
   * — it would auto-shrink every column and bank the result as resize
   * requests — so compact drops the tables for a medallion column, and
   * expanding rebuilds them at the real width. */
  setCompact(compact: boolean): void {
    if (this.compact === compact) return;
    this.compact = compact;
    this.toggleAttribute("compact", compact);
    this.render();
  }

  setSelected(key: Option<string>): void {
    this.selectedKey = key;
    for (const $table of this.tables.values()) $table.bindSelectedItem(key);
    for (const $m of this.$root.querySelectorAll<HTMLElement>(".cmed[data-key]")) {
      $m.toggleAttribute("selected", key != null && $m.dataset.key === key);
    }
  }

  /** Open or close a project row. Only the owning section re-binds: the
   * table's view model — columns, widths, header — is untouched, so this is
   * a row-list swap rather than a re-render. */
  private toggleExpanded(item: ReviewInbox.Item): void {
    if (this.expanded.has(item.key)) this.expanded.delete(item.key);
    else this.expanded.add(item.key);
    const section = this.sectionOf(item);
    const $table = this.tables.get(section);
    if ($table == null) {
      this.render();
      return;
    }
    $table.bindItems(this.rowsFor(section));
    $table.bindSelectedItem(this.selectedKey);
  }

  /** Which section an item renders in. Reflection outranks a pin, which
   * outranks parking, which outranks the verdict-derived turn model. */
  private sectionOf(item: ReviewInbox.Item): SectionId {
    // Reflection is identity, not workflow state: it outranks both the
    // verdict-derived turn and a stale hold decoration copied from the source.
    if (item.mirroredFrom != null) return "mirrored";
    // A pin beats a hold deliberately, and the pair is not a contradiction to
    // resolve: the operator parked this, somebody has since asked for it
    // back, and burying the ask under the parking would lose the newer fact.
    if (item.pin != null) return "pinned";
    if (
      item.kind === "project" &&
      item.status === "changes_requested" &&
      ownerLiveness(item.owner ?? null) === "stale"
    ) return "yours";
    return item.held ? "hold" : item.turn;
  }

  /** Park or un-park an item. A full re-render, not a section re-bind: the
   * row moves BETWEEN two tables, and both section headers' counts change. */
  private async toggleHold(item: ReviewInbox.Item): Promise<void> {
    if (item.mirroredFrom != null) return;
    // Table rows are snapshots produced by `rowsFor`, not the canonical
    // objects in `this.items`. Mutating the row only survives until this
    // render; mutate the source item so the optimistic move is visible now.
    const source = this.items.find((candidate) => candidate.key === item.key);
    if (source == null) return;
    const before = source.held;
    source.held = !before;
    this.render();
    try {
      await this.onSetHeld?.(source, source.held);
    } catch (error) {
      source.held = before;
      this.render();
      console.error("failed to persist project hold", error);
    }
  }

  /** Pin or unpin an item — the same optimistic move `toggleHold` makes, for
   * the same reason: the row changes SECTION, so waiting on the round trip
   * would leave it sitting under a heading that no longer describes it. */
  private async togglePinned(item: ReviewInbox.Item): Promise<void> {
    if (item.mirroredFrom != null) return;
    const source = this.items.find((candidate) => candidate.key === item.key);
    if (source == null) return;
    const before = source.pin;
    // Optimistic only in its EXISTENCE — the reason and the true `pinned_at`
    // are the service's to mint, and the next stack read brings them back.
    source.pin =
      before == null ? { slug: source.project ?? source.key, pinned_at: Date.now() / 1000 } : null;
    this.render();
    try {
      await this.onSetPinned?.(source, source.pin != null);
    } catch (error) {
      source.pin = before;
      this.render();
      console.error("failed to persist project pin", error);
    }
  }

  private setPlacement(field: ReviewInbox.Field, place: ReviewInbox.Placement): void {
    if (this.layout[field] === place) return;
    this.layout = { ...this.layout, [field]: place };
    this.render();
    this.onLayoutChange?.({ ...this.layout });
  }

  /** The `columns` menu: one row per field, with every placement directly
   * available. The segmented control updates itself before `setPlacement`
   * re-renders the inbox, and because the menu is document-mounted it stays
   * open for the next adjustment.
   *
   * Anchored to an element the CALLER owns — the trigger is the owner's
   * rail-head button, alongside reload and collapse, rather than a bar of the
   * inbox's own. The anchor math stays here because `COLUMNS_MENU_W` does:
   * `ContextMenu` positions as `position: fixed`, so it takes a viewport
   * POINT (the anchored `Position.*` constants are transform/edge-based and
   * land off-screen — the trap revision-compare and breadcrumb both
   * document), and right-aligning a 286px menu under a button in a 300px
   * rail is what the clamp is for. */
  private openColumnsMenu($anchor: HTMLElement): void {
    const rect = $anchor.getBoundingClientRect();
    this.showColumnsMenu($anchor, {
      x: Math.max(4, rect.right - COLUMNS_MENU_W),
      y: rect.bottom + 6,
    });
  }

  /** Wire `$anchor` up as the columns menu's trigger. The whole gesture lives
   * here rather than at the call site, because what makes it fiddly is a fact
   * about the MENU, not about any particular button: the caller would
   * otherwise have to know when the popover dismisses itself in order to
   * drive it correctly, and every trigger would re-derive the same latch.
   *
   * Two listeners for one gesture. `click` is the activation, native so the
   * Enter/Space `std-icon-button` synthesises still opens the menu. But the
   * menu is dismissed on any pointer-up outside itself — and the trigger IS
   * outside — so clicking an open menu's own trigger would dismiss and then
   * immediately reveal a fresh copy, which reads as a button that will not
   * close. `pointerdown` runs BEFORE that dismissal, so it is the only place
   * the open state can still be observed: latch it there, and let the click
   * that follows spend the latch instead of reopening.
   *
   * The anchor is also the menu's `ContextMenu` target, so it carries
   * `context-menu-open` for as long as the menu shows — which is both what
   * this reads and what a caller styles to light the button. */
  bindColumnsTrigger($anchor: HTMLElement): void {
    let openAtPointerDown = false;
    $anchor.addEventListener("pointerdown", () => {
      openAtPointerDown = $anchor.hasAttribute("context-menu-open");
    });
    $anchor.addEventListener("click", () => {
      // Keyboard activation never fires pointerdown, so a latch left standing
      // by an earlier mouse gesture would swallow the Enter that follows it.
      const wasOpen = openAtPointerDown;
      openAtPointerDown = false;
      if (wasOpen) return;
      this.openColumnsMenu($anchor);
    });
  }

  private showColumnsMenu($anchor: HTMLElement, at: Point): void {
    const builder = ContextMenu.builder(COLUMNS_MENU_W, 6);
    for (const field of FIELD_ORDER) {
      const $row = document.createElement("div").assignStyles({
        alignItems: "center",
        display: "grid",
        gap: "8px",
        gridTemplateColumns: "48px minmax(0, 1fr)",
        padding: "3px 2px",
      });
      $row.setAttribute("role", "none");

      const $label = Typography.small(field).assignStyles({
        color: "var(--text-sec)",
        margin: "0",
      });
      const $placements = ButtonGroupRow.makeWith<ReviewInbox.Placement>({
        selected: this.layout[field],
        entries: PLACEMENT_ORDER.map((place) => ({
          identifier: place,
          label: place,
        })),
        onSelected: (place) => this.setPlacement(field, place),
      }).setCompact();
      $placements.setAttribute("role", "group");
      $placements.setAttribute("aria-label", `${field} placement`);
      // Keep keyboard focus without reintroducing the blue focus ring that
      // context menus intentionally suppress on their own cells/container.
      $placements.style.setProperty("--button-group-focus-outline", "none");

      $row.append($label, $placements);
      builder.row($row);
    }
    builder.buildAndReveal($anchor, {
      position: Position.fromPoint(at),
      hideOnClickOutside: true,
    });
  }

  /** A row's own verbs. `Open` is first because a right-click user expects
   * the primary action in the menu too; `Pin` and `Hold` are the reason the
   * menu exists — the two directions the operator can move a project out of
   * its turn section. A member row can do neither on its own — it is pinned
   * or parked by pinning or parking the project that owns it — so it is
   * offered only `Open`. */
  private showRowMenu(row: Row, at: Point, $row: HTMLElement): void {
    const builder = ContextMenu.builder(ROW_MENU_W);
    builder.cellRow("Open", null, () => this.onSelect?.(row));
    if (!row.child && row.kind === "project" && row.pinnable) {
      builder.cellRow(row.pin != null ? "Unpin" : "Pin", null, () =>
        void this.togglePinned(row),
      );
    }
    if (!row.child && row.kind === "project" && row.holdable) {
      builder.cellRow(row.held ? "Resume" : "Hold", null, () => void this.toggleHold(row));
    }
    // The hand-off, on every row. A row that already has an agent reads
    // "Assigned" — the door to the job it holds, because a second agent on
    // one file set is the collision this exists to avoid (the service dedups
    // by members, so asking again answers with the same job anyway). Every
    // other row offers the hand-off unconditionally: an agent is not only a
    // reviser — a settled or pending draft is exactly the one an operator
    // wants explained before judging it — so "nothing to address" stopped
    // being a reason to hide the verb (`assignable` is vestigial now and
    // retires with its producers).
    if (row.assignment != null) {
      builder.cellRow("Assigned", null, () => void this.onAssign?.(row));
    } else {
      builder.cellRow("Assign to new agent", null, () => void this.onAssign?.(row));
    }
    builder.buildAndReveal($row, { position: Position.fromPoint(at) });
  }

  /** One section's rows in reading order: oldest-waiting-first, with an open
   * project's members spliced in directly beneath it. The table never
   * re-sorts this — no column carries a `sortComparator`, deliberately: the
   * table's comparator is applied to a FLAT item list with no notion of the
   * parent/child splice, so any sort would scatter members away from the
   * project they belong to. */
  private rowsFor(section: SectionId): Row[] {
    const rows: Row[] = [];
    // Oldest-waiting-first everywhere — except among pins, where the wait
    // that matters is the wait since somebody ASKED. A project pinned this
    // morning does not outrank one pinned on Monday just because its commits
    // are younger, and a re-pin does not re-queue (the service keeps the
    // original `pinned_at`), so this is FIFO on the requests themselves.
    const inSection = this.items
      .filter((i) => this.sectionOf(i) === section)
      .sort((a, b) =>
        section === "pinned"
          ? (a.pin?.pinned_at ?? a.since) - (b.pin?.pinned_at ?? b.since)
          : a.since - b.since,
      );
    for (const item of inSection) {
      const members = item.kind === "project" ? item.members : [];
      const expanded = this.expanded.has(item.key);
      // NOT `section === "hold"`, which is what this read before pins: a
      // parked project that someone has since pinned renders in the pinned
      // section and is still parked, and the row menu would otherwise offer
      // to `Hold` something already held. The section test was only ever
      // standing in for the one case it still has to cover — a MIRRORED row,
      // whose `held` is a decoration copied from the source host and means
      // nothing about this operator's own parking.
      const held = item.held && item.mirroredFrom == null;
      rows.push({
        ...item,
        id: item.key,
        child: false,
        depth: 0,
        expandable: members.length > 0,
        expanded,
        held,
        divider: rows.length === 0 ? "none" : "row",
      });
      if (!expanded) continue;
      for (const m of members) {
        rows.push({
          ...memberItem(m, item),
          id: m.key,
          child: true,
          // A master project's roll splices two levels: its member PROJECTS,
          // and under each of those that project's own commits.
          depth: m.depth,
          expandable: false,
          expanded: false,
          held,
          divider: "child",
        });
      }
    }
    return rows;
  }

  private render(): void {
    this.tables.clear();
    this.shape = null;

    if (!this.bound) {
      this.$root.replaceChildren();
      return;
    }
    if (this.compact) {
      this.$root.replaceChildren(this.$compactStrip());
      this.setSelected(this.selectedKey);
      return;
    }
    if (this.items.length === 0) {
      const $empty = Typography.small("nothing in review");
      $empty.id = "empty";
      this.$root.replaceChildren($empty);
      return;
    }

    const plan = this.tablePlan();
    const { columns, captions, sections, widths } = plan;
    this.shape = ReviewInbox.shapeOf(plan);

    const children: HTMLElement[] = [];

    sections.forEach((section, i) => {
      const heading = `${section.label} · ${section.rows.filter((r) => !r.child).length}`;
      // Field labels print once, on the first section's header: three
      // copies of "repo plans drafts id age" in a 300px rail is noise, and
      // they are the same columns in every section.
      const tvm = Table.ViewModel.makeDefault<Row>({
        columns: this.columnSpecs(heading, columns, captions, widths, i === 0),
        style: {
          rowHeight: ROW_HEIGHT,
          cellPadding: CELL_PADDING,
          showRowDividers: false,
          containerMarginInline: CONTAINER_MARGIN_INLINE,
        },
        delegate: {
          onRowClick: (row) => this.onSelect?.(row),
          onContextMenu: (row, point, $row) => this.showRowMenu(row, point, $row),
        },
      });
      const $table = Table.makeTyped<Row>();
      $table.classList.add("sect", `sect-${section.id}`);
      $table.style.width = "100%";
      $table.bind(tvm).bindItems(section.rows).bindSelectedItem(this.selectedKey);
      this.tables.set(section.id, $table);
      children.push($table);
    });

    this.$root.replaceChildren(...children);
  }

  /** Everything the section tables are built from, derived once so `render`
   * and `patch` cannot disagree about what the inbox currently looks like —
   * a drifting copy here would let a patch swap rows into tables priced for
   * different content, which reads as columns that no longer line up. */
  private tablePlan(): TablePlan {
    const columns = FIELD_ORDER.filter((f) => this.layout[f] === "column");
    const captions = FIELD_ORDER.filter((f) => this.layout[f] === "caption");
    const sections = SECTIONS.map((s) => ({ ...s, rows: this.rowsFor(s.id) })).filter(
      (s) => s.rows.length > 0,
    );
    // Widths are priced over EVERY row in the inbox, not per section, so a
    // column is one column all the way down.
    const all = sections.flatMap((s) => s.rows);
    const widths = new Map<ReviewInbox.Field, number>();
    for (const field of columns) widths.set(field, columnWidth(field, all));
    return { columns, captions, sections, widths };
  }

  /** The plan's STRUCTURE, as one comparable string: the column placement,
   * the priced widths, and each section's id and heading count in order.
   * Deliberately not the rows — their content is exactly what a patch is
   * allowed to change. Section order carries `showFieldLabels` (it is
   * `i === 0`), and the per-section count is what the heading prints, so a
   * section gaining a row re-renders rather than silently keeping a stale
   * header. */
  private static shapeOf(plan: TablePlan): string {
    return JSON.stringify([
      plan.columns,
      plan.captions,
      plan.columns.map((f) => plan.widths.get(f) ?? 0),
      plan.sections.map((s) => [s.id, s.rows.filter((r) => !r.child).length]),
    ]);
  }

  /** The table's column set: the title column (primary, flexes) plus one
   * fixed-width column per field placed as a column. */
  private columnSpecs(
    sectionLabel: string,
    columns: ReviewInbox.Field[],
    captions: ReviewInbox.Field[],
    widths: Map<ReviewInbox.Field, number>,
    showFieldLabels: boolean,
  ): Table.Column.Spec<Row>[] {
    const specs: Table.Column.Spec<Row>[] = [
      {
        id: "project",
        // The section heading rides the primary column's header label: the
        // table renders one header per table, and this IS that section's
        // header, so the two are one row rather than two stacked ones.
        label: sectionLabel,
        primary: true,
        minWidth: PRIMARY_MIN_W,
        make: () => InboxCell.make(),
        bind: ($e, row, $row) => {
          if (!($e instanceof InboxCell)) return;
          // The divider rides the row element itself (full row width); the
          // primary cell's bind is just the one place that element is handed
          // out per row.
          applyRowDivider($row, row.divider, row.depth);
          $row.style.opacity = row.mirroredFrom != null ? "0.58" : "";
          if (row.mirroredFrom != null) {
            $row.title = `Mirrored from ${row.mirroredFrom} — review it at the source`;
          } else {
            $row.removeAttribute("title");
          }
          $e.bind(
            cellModel(row, captions),
            $row,
            row.expandable ? () => this.toggleExpanded(row) : null,
          );
        },
      },
    ];
    for (const field of columns) {
      specs.push({
        id: field,
        label: field,
        showLabel: showFieldLabels,
        width: widths.get(field) ?? COLUMN_MIN_W,
        make: () => InboxValue.make(),
        bind: ($e, row) => {
          if (!($e instanceof InboxValue)) return;
          if (field === "pips") $e.bindPips(pipsFor(row));
          // The assigned-agent cell is a door, not a readout: clicking it
          // opens the assignment's thread. The row click still fires — the
          // window is ABOUT this row, so selecting it underneath is the
          // context the thread wants, not a conflict.
          else if (field === "agent" && row.assignment != null) {
            // Drawn as the harness's own mark when the job named one, and as
            // the plain ◆ when it did not. Both are the same door; the mark
            // just says who answers it. Falling back rather than inventing a
            // neutral avatar keeps "assigned by nobody we can name" visually
            // distinct from "assigned to an engine we have no logo for".
            const face = faceFor(row.assignment.engine);
            if (face == null) {
              $e.bindAction(columnValue(row, field), () => this.onOpenAgent?.(row));
            } else {
              $e.bindAgent(face, agentActive(row.assignment, Date.now()), () =>
                this.onOpenAgent?.(row)
              );
            }
          } else $e.bind(columnValue(row, field), field === "id" ? row.href : null);
        },
      });
    }
    return specs;
  }

  /** Collapsed rail: the medallion column alone, in the same order, with the
   * same selection band. No table — five columns in 52px is not a table. */
  private $compactStrip(): HTMLElement {
    const $strip = document.createElement("div");
    $strip.className = "compact";
    // A collapsed rail still navigates: the medallion is the whole row.
    GESTURE_MANAGER.addPointerEvent($strip, {
      onClick: (_captured, _offset, event) => {
        const $target = event.target as HTMLElement;
        // The id is its own link; its href navigates, so the row must not
        // also report a selection for the same click.
        if ($target.closest<HTMLElement>("a.handle[href]") != null) return;
        const key = $target.closest<HTMLElement>("[data-key]")?.dataset.key;
        if (key == null) return;
        const item = this.items.find((i) => i.key === key);
        if (item != null) this.onSelect?.(item);
      },
    });
    let $lastPinned: Option<HTMLElement> = null;
    let followsPinned = false;
    for (const section of SECTIONS) {
      for (const row of this.rowsFor(section.id)) {
        // Members are the expanded rows of a project; collapsed to a 52px
        // strip there is nothing to expand INTO.
        if (row.child) continue;
        const $m = document.createElement("span");
        $m.className = "cmed";
        $m.dataset.key = row.key;
        $m.toggleAttribute("held", row.held);
        $m.toggleAttribute("pinned", row.pin != null);
        $m.toggleAttribute("mirrored", row.mirroredFrom != null);
        const cls = row.hollow ? `node hollow ${row.status}` : `node ${row.status}`;
        $m.appendChild(StackLog.$node(row.shape, cls, false));
        $strip.appendChild($m);
        // Sections render in order and `pinned` is first, so the run is
        // contiguous: remember its last element, and only draw the rule once
        // something has actually followed it.
        if (section.id === "pinned") $lastPinned = $m;
        else if ($lastPinned != null) followsPinned = true;
      }
    }
    if ($lastPinned != null && followsPinned) $lastPinned.toggleAttribute("pin-end", true);
    return $strip;
  }

  static $styles = [
    Typography.$style,
    $nodePalette,
    css`
      /* The 2px top pad dates from when a columns bar sat above the first
         section and supplied the air itself. With the trigger moved up into
         the rail head there is nothing between the sticky title and the
         first table, so the gap has to be real padding. */
      #root {
        display: flex;
        flex-direction: column;
        padding: 8px 0 18px;
        position: relative;
      }
      /* Sections separate by block air, not lines — their first rows carry
         no divider — so the air has to actually exist (round 7). */
      .sect + .sect {
        margin-top: 14px;
      }
      /* Borrowed work keeps its own register even when its member verdicts
         span several colors. A hairline, not a new card surface: the section
         is an inbox partition rather than a second hierarchy. */
      .sect-mirrored {
        box-shadow: inset 1px 0 0
          color-mix(in srgb, var(--text-ter) 28%, transparent);
      }
      /* The table paints a rounded chip behind its header by default; the
         rail's register is flat, so retire it rather than let a card edge
         show up inside a sidebar. The header renders its label OUTSIDE this
         stylesheet's reach, so its type is set here on the host and sized
         off the same cap-height scale the typography builders use. */
      .sect {
        --bg-surface-light-opaque: transparent;
        color: var(--text-ter);
        font-size: calc(var(--small-size) / (1 - var(--cap-height) - var(--baseline)));
        line-height: 1.2;
      }
      .compact {
        display: flex;
        flex-direction: column;
        padding: 8px 0;
      }
      .cmed {
        display: flex;
        height: 24px;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        position: relative;
      }
      /* Where the pinned run ends — and ONLY in the collapsed strip. Expanded,
         the "Pinned · N" table header already says where the section stops, so
         a rule there is a second answer to a question nobody asked. Collapsed,
         there is no header and no text at all: the medallions are a single
         unbroken column, and without this the pinned ones are merely the top
         few of a list that looks continuous.

         Absolute, in the gap under the last pinned medallion: it adds no
         height, so it cannot shift the column or change which medallion sits
         under the pointer. Set only when a non-pinned row FOLLOWS — a rule
         under the last item in the strip is a line to nowhere. */
      .cmed[pin-end]::after {
        content: "";
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 0;
        height: 1px;
        background: var(--divider);
        pointer-events: none;
      }
      .cmed[selected] {
        background: var(--bg-surface-light);
      }
      /* Parked rows read quiet in the collapsed strip too. */
      .cmed[held] {
        opacity: 0.5;
      }
      /* …and a pinned one does not, even when it is also parked. Full
         strength is the whole of the mark here: the 52px strip has no room
         for a word, and an accent ring around a 12px medallion reads as a
         defect rather than a state. The pinned rows are still FIRST, and the
         divider below them is what says where they end. */
      .cmed[pinned] {
        opacity: 1;
      }
      .cmed[mirrored] {
        opacity: 0.58;
      }
      .cmed svg {
        width: 12px;
        height: 12px;
        display: block;
        overflow: visible;
      }
      #empty {
        padding: 18px 10px;
        color: var(--text-ter);
        text-align: center;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="root"></div>`;
}

/** A project member, as an item. It carries the PARENT's repo tab and place:
 * a `foreign:<repo>:<sha>` key is resolved against the tab that LISTED it —
 * that is the whole reason foreign keys exist — so reporting the foreign
 * repo here would send the owner switching tabs and lose the row. */
function memberItem(
  m: ReviewInbox.Member,
  parent: ReviewInbox.Item,
): ReviewInbox.Item {
  return {
    kind: "member",
    project: null,
    key: m.key,
    repo: m.repo,
    place: parent.place,
    title: m.title,
    plans: null,
    drafts: null,
    handle: m.handle,
    href: m.href,
    lastActivity: m.since,
    // Presence is reported per ITEM by the owner, and it resolves a project's
    // members collectively — a spliced child row is not separately looked up,
    // so it says nothing rather than inheriting its parent's claim.
    watcher: null,
    status: m.status,
    shape: m.shape,
    hollow: m.hollow,
    turn: parent.turn,
    since: m.since,
    blocked: false,
    held: parent.held,
    holdable: false,
    // A member inherits its project's pin the way it inherits its hold: the
    // pin is on the container, and a spliced child is drawn under it.
    pin: parent.pin,
    owner: null,
    pinnable: false,
    changeId: m.changeId,
    // Unlike hold and pin, assignment IS meaningful on a child: one commit is
    // one file set, and handing that over is a smaller, sharper act than
    // handing over the whole round. The service's guard keys on member cids,
    // so it refuses whichever of the two arrives second.
    assignable: parent.assignable && m.status === "changes_requested" && m.changeId != null,
    assignment: null,
    mirroredFrom: m.mirroredFrom ?? parent.mirroredFrom,
    members: [],
  };
}

/** The primary cell's presentational model, decided HERE: the turn model
 * and the hold set fold into `quiet`, and the placed caption fields are
 * formatted into ordered fragments — the cell primitive only paints what
 * this returns, which is what keeps it storybookable without an inbox. */
function cellModel(row: Row, captions: ReviewInbox.Field[]): InboxCell.Model {
  return {
    title: row.title,
    caption: [
      ...(row.mirroredFrom != null
        ? [{ text: `⇄ ${row.mirroredFrom}`, href: null }]
        : []),
      // The pin's reason leads the caption, ahead of every placed field: it
      // is the argument for the row being where it is, and a reason the
      // reader has to hunt for is one the pinned section can't be read by.
      ...(row.pin?.reason != null && row.pin.reason !== ""
        ? [{ text: `⚑ ${row.pin.reason}`, href: null }]
        : []),
      ...captions.flatMap((f) => {
        if (f === "pips") return [];
        const v = captionValue(row, f);
        if (v == null || v === "") return [];
        // Only the id is an address; every other field is a fact about the row.
        return [{ text: v, href: f === "id" ? row.href : null }];
      }),
    ],
    pips: captions.includes("pips") ? pipsFor(row) : [],
    blocked: row.blocked,
    shape: row.shape,
    hollow: row.hollow,
    status: row.status,
    child: row.child,
    depth: row.depth,
    // Parked rows read quiet whatever their turn says — that IS the point
    // of parking one. A pin is the same statement inverted, so it un-quiets
    // a row its turn would otherwise have dimmed: something is being asked
    // for here. Reflection still wins over both, exactly as `sectionOf`
    // ranks them — a borrowed row is quiet because it is not this
    // operator's to act on, which no local decoration changes.
    quiet:
      row.mirroredFrom != null ||
      (row.pin == null && (row.turn !== "yours" || row.held)),
    expandable: row.expandable,
    expanded: row.expanded,
  };
}

/** A column's px width: the widest thing that has to fit, priced at one
 * small-size glyph each and clamped so no field can eat the title. */
function columnWidth(field: ReviewInbox.Field, rows: Row[]): number {
  if (field === "pips") {
    // The DRAWN pips, not the member list: a master project's list also holds
    // its member projects' header rows, which draw no dot.
    const count = rows.reduce((n, row) => Math.max(n, pipsFor(row).length), 0);
    return Math.min(COLUMN_MAX_W.pips, Math.max(COLUMN_MIN_W, count * 12 + COLUMN_PAD_PX));
  }
  let chars = field.length;
  for (const row of rows) chars = Math.max(chars, columnValue(row, field).length);
  return Math.min(
    COLUMN_MAX_W[field],
    Math.max(COLUMN_MIN_W, chars * CH_PX + COLUMN_PAD_PX),
  );
}

/** A field's column text. Empty string = nothing to show; the value cell
 * renders that as a dim placeholder so the column keeps its width. */
function columnValue(item: ReviewInbox.Item, field: ReviewInbox.Field): string {
  switch (field) {
    case "repo":
      return item.place;
    case "plans":
      return item.plans != null && item.plans > 0 ? String(item.plans) : "";
    case "drafts":
      return item.drafts != null && item.drafts > 0 ? String(item.drafts) : "";
    case "id":
      return item.handle ?? "";
    case "owner": {
      if (item.kind !== "project") return "";
      if (item.owner == null) return "—";
      const state = ownerLiveness(item.owner ?? null);
      const mark = state === "active" ? "●" : state === "idle" ? "○" : "⚠";
      return `${mark} ${item.owner.actor.label}`;
    }
    case "agent":
      // The glyphs do not blend: ◆ only ever means "a spool agent holds this
      // round" (the one state you can OPEN — the cell becomes the door to its
      // thread), ● only ever means "someone has this open", ○ only ever means
      // "a commit landed recently". Assignment outranks presence because it is
      // the strongest claim: a job record, not an observation.
      //
      // The TOP rung has since grown a face: when the job names its harness,
      // the cell draws that harness's mark instead of ◆, ringed while the
      // agent looks live (`bindAgent`, via `agent-face.ts`). That is a
      // deliberate, narrow amendment to "do not blend" — identity and
      // activity are two facts about the SAME agent, and one mark is how you
      // read them at a glance. ● and ○ are untouched, and ◆ survives verbatim
      // for a job that named nobody. This string stays correct on its own:
      // the caption and the collapsed strip still read it.
      if (item.assignment != null) return "◆";
      if (item.watcher != null) return "●";
      return Date.now() / 1000 - item.lastActivity < AGENT_RECENT_S ? "○" : "";
    case "age":
      return age(item.since);
    case "pips":
      return "";
  }
}

/** A field's caption text. Counts carry their noun here — a bare `2` reads
 * as a number in a column and as nothing in a sentence. */
function captionValue(item: ReviewInbox.Item, field: ReviewInbox.Field): Option<string> {
  switch (field) {
    case "repo":
      return item.place;
    case "plans":
      return item.plans != null && item.plans > 0
        ? `${item.plans} plan${item.plans === 1 ? "" : "s"}`
        : null;
    case "drafts":
      return item.drafts != null && item.drafts > 0
        ? `${item.drafts} draft${item.drafts === 1 ? "" : "s"}`
        : null;
    case "id":
      return item.handle;
    case "owner": {
      if (item.kind !== "project") return null;
      if (item.owner == null) return "unowned";
      const state = ownerLiveness(item.owner ?? null);
      return `owned by ${item.owner.actor.label} · ${state} ${age(item.owner.heartbeat_at)}`;
    }
    case "agent":
      // The caption has room to NAME the evidence, which is the whole reason
      // the ladder exists: "assigned agent" and "watched by claude-a7" are
      // actionable in a way that "last commit 2h" never is.
      if (item.assignment != null) {
        // Name the harness when the job named one: "assigned agent" answers a
        // weaker question than the mark already answers visually.
        const who = item.assignment.engine ?? "agent";
        return item.watcher != null
          ? `assigned ${who} · watched by ${item.watcher}`
          : `assigned ${who}`;
      }
      if (item.watcher != null) return `watched by ${item.watcher}`;
      return Date.now() / 1000 - item.lastActivity < AGENT_RECENT_S
        ? `last commit ${age(item.lastActivity)}`
        : null;
    case "age":
      return age(item.since);
    case "pips":
      return null;
  }
}

function pipsFor(item: ReviewInbox.Item) {
  // One dot per COMMIT. A master project's roll splices its member projects'
  // header rows into the same list, and those are groupings — counting them
  // would report more commits than the project has. `ready` is the same test
  // spelled in the type: only a project can be planned-but-unwritten, and the
  // pip vocabulary is per-commit review state.
  return item.kind === "project"
    ? item.members.flatMap((member) =>
        member.container || member.status === "ready"
          ? []
          : [{ state: member.status, hollow: member.hollow }],
      )
    : [];
}

/** Compact waiting age — "3d", "5h", "12m"; sub-minute reads "now". */
function age(sinceEpochSec: number): string {
  const s = Math.max(0, Date.now() / 1000 - sinceEpochSec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ownerLiveness(owner: Option<StackLog.ProjectOwner>): "active" | "idle" | "stale" {
  if (owner == null) return "stale";
  const seconds = Date.now() / 1000 - owner.heartbeat_at;
  if (seconds < 5 * 60) return "active";
  if (seconds < 2 * 60 * 60) return "idle";
  return "stale";
}

export namespace ReviewInbox {
  /** Whose move: `yours` = a member awaits this reviewer's verdict,
   * `theirs` = every open verdict is out with the agent (revisions
   * requested, or an approved plan awaiting its build), `settled` =
   * approved and riding the sink/publish conveyor. */
  export type Turn = "yours" | "theirs" | "settled";

  /** Everything a row says other than its title — each one placeable. */
  export type Field =
    | "repo"
    | "plans"
    | "drafts"
    | "id"
    | "owner"
    | "agent"
    | "age"
    | "pips";

  /** Where a field renders: its own table column, folded into the caption
   * line under the title, or not at all. */
  export type Placement = "column" | "caption" | "hidden";

  export type Layout = Record<Field, Placement>;

  export const DEFAULT_LAYOUT: Layout = { ...LAYOUT_DEFAULT };

  /** The field and placement vocabularies, exported so the owner can
   * validate a stored layout against the SAME lists the component renders
   * from rather than a second copy that can drift. */
  export const FIELDS: Field[] = [...FIELD_ORDER];
  export const PLACEMENTS: Placement[] = [...PLACEMENT_ORDER];

  /** The agent working a project's review round. `id` addresses the job in
   * the spool that owns it, which is where the transcript lives. */
  export type Assignment = {
    spool_id: string;
    id: string;
    subject_kind: "project" | "change";
    subject_id: string;
    /** The harness on the other end — `claude`, `codex`, and so on. Null
     * while the job is unclaimed and on services that predate the field;
     * both draw as the neutral mark rather than a guessed one. */
    engine: Option<string>;
    /** Whether a consumer holds the job. Sticky on its own — see
     * `agentActive`, which is the question this half cannot answer. */
    state: "pending" | "running";
    /** RFC 3339, the spool's own stamp for the job's last runtime change. */
    updated_at: string;
  };

  /** One commit inside a project row, as the expanded child rows render it.
   * `key`/`repo` are what the owner routes on: `repo` is the repo TAB the
   * key resolves under (the project's own repo), which for a `foreign:` key
   * is deliberately NOT the repo the commit itself lives in.
   *
   * A `container` member is the exception to "one commit": it is a MEMBER
   * PROJECT's header row inside a master project's roll, which is why the
   * status widens to the project palette (`ready` — planned, no code — has
   * no meaning for a single commit). */
  export type Member = {
    key: string;
    repo: string;
    title: string;
    shape: StackLog.NodeShape;
    hollow: boolean;
    status: StackLog.ProjectStatus | StackLog.State;
    /** The member's handle, sha9 when it has none — see [`Item.handle`]. */
    handle: string;
    /** The app's URL for this member — see [`Item.href`]. */
    href: Option<string>;
    since: number;
    /** The `Change-Id` trailer, or null for an untagged draft. The subject an
     * agent is assigned when a single commit is handed over. */
    changeId: Option<string>;
    /** Source host for a reflected member; null for native work. */
    mirroredFrom: Option<string>;
    /** Indent level under the project row: 1 for its own commits, 2 for the
     * commits of a MEMBER PROJECT nested under a master project. */
    depth: number;
    /** True for the header row of a nested member project — a grouping, not a
     * commit. It routes like any other row (its key is `project:<slug>`), but
     * it is not counted among the project's commit pips. */
    container: boolean;
  };

  export type Item = {
    /** `project` = a container row, expandable into its `members`;
     * `member` = a single commit, whether spliced under a project or
     * standing on its own as an ungrouped draft. */
    kind: "project" | "member";
    /** Stable service-local slug for a project container; null for a commit. */
    project: Option<string>;
    /** Rail selection key (`project:<slug>` / `draft:<sha>`), host-prefixed
     * in fleet mode — the same key vocabulary every other surface routes. */
    key: string;
    /** The repo tab this item lives under; the owner switches tabs before
     * selecting when it differs from the showing one. */
    repo: string;
    /** The repo column's display string: the repo key alone in solo mode,
     * `host · repo` in fleet mode. Distinct from `repo`, which is a routing
     * key and must stay unqualified. */
    place: string;
    title: string;
    /** Member counts, already split the way the columns want them: null on
     * a member row, which is a commit rather than a project. */
    plans: Option<number>;
    drafts: Option<number>;
    /** What the `id` field shows for a commit row: its handle — `D-1234`
     * once landed, else `L-142` — falling back to a sha9 for an untagged
     * commit that has no cid to hang a handle on. Null for a project, which
     * has no identity of its own; its members each have one.
     *
     * NOT named `id`: the table's `Row` wrapper spreads an Item and then
     * assigns the row identity to `id` (= the rail key), and the first cut
     * of this type did call it that — every caption promptly rendered
     * `project:<slug>` key noise where the name belonged (observed,
     * operator round 3). */
    handle: Option<string>;
    /** Medallion + badge-dot color class — the rail's state palette. */
    status: StackLog.ProjectStatus | StackLog.State;
    shape: StackLog.NodeShape;
    hollow: boolean;
    turn: Turn;
    /** Epoch seconds the age is measured from (oldest member commit). */
    since: number;
    /** Epoch seconds of the NEWEST member commit — the `agent` field's
     * evidence that someone is actively producing revisions here. The dual
     * of `since`: one asks how long the oldest work has waited, the other
     * how recently anyone touched it. */
    lastActivity: number;
    /** The identity currently WATCHING this item (a live monitor attached to
     * one of its commits), or null. The `agent` field's primary signal — see
     * the AGENT_RECENT_S block. Presence, not inference: the owner only sets
     * this from a watcher whose heartbeat is still fresh. */
    watcher: Option<string>;
    blocked: boolean;
    /** Durable project decoration supplied by the service. */
    held: boolean;
    /** Whether this item's host exposes the project-hold mutation endpoint. */
    holdable: boolean;
    /** The standing request to review this project first, or null — the
     * durable decoration the `pinned` section, its order and its captions are
     * all read from. */
    pin: Option<StackLog.ProjectPin>;
    /** Explicit accountability, separate from assignment and presence. */
    owner?: Option<StackLog.ProjectOwner>;
    /** Whether this item's host exposes the project-pin mutation endpoint. */
    pinnable: boolean;
    /** The `Change-Id` this row is, when it is a single commit. Null on a
     * project container, whose subject is its slug. */
    changeId: Option<string>;
    /** Whether this project could be handed to a fresh agent right now: the
     * host serves the route, the row is not borrowed, and there is a round to
     * address. False on a project nobody has asked for changes to — an agent
     * spun there would have no brief. */
    assignable: boolean;
    /** The agent already working this project's round, or null. A project
     * with one is not offered again: two agents on one file set is the
     * collision the whole feature exists to avoid. */
    assignment: Option<ReviewInbox.Assignment>;
    /** Source host when this row is borrowed, which assigns the Mirrored
     * section and is inherited by expanded project members. */
    mirroredFrom: Option<string>;
    /** The project's commits, in stack order (natives first, then the
     * cross-repo members) — empty on a member row.
     *
     * For a MASTER PROJECT (one whose plan declares an ordered `Member:`
     * roll) this is the whole group in reading order: the master's own
     * commits, then each member project's header row followed by that
     * project's commits, members in the order the plan declares them rather
     * than the order they were committed. Those member projects do not also
     * appear as top-level items — the master row speaks for them. */
    members: Member[];
    /** The app's URL for this item, supplied by the owner. The row is
     * clickable either way; this is what makes the id itself an address the
     * reader can copy or open in a new tab. Null for a project container,
     * which is a grouping rather than a commit, and for any row the owner
     * cannot address. */
    href: Option<string>;
  };
}
