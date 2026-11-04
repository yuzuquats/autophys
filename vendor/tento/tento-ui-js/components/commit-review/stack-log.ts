import { Point } from "@tento-core/point";
import { Position } from "../../anchor-positioning-utils";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ContextMenu } from "../context-menu";

// The two-lane stack log (absorb-stack spec — ui.md): the mainline is
// remote-master (public history, diamond rows), and master's draft stack
// renders as a branch lane forking off it at origin/master. The service
// delivers drafts already in autosquash display order — a pending fixup sits
// directly above the commit it will be absorbed into.
//
// Above the drafts, the branch lane carries the pre-commit region on dotted
// connectors: the working copy (`@ unstaged`) and any queued `.commits/`
// sets (frozen patch sets awaiting drain — commits-to-be, so they stack
// between the worktree and the tip, bottom = first to drain).
//
// The graph is SVG: full-height lane lines per row (so segments meet
// seamlessly at row boundaries), filled nodes drawn over the line, hollow
// pre-commit nodes sitting in a percent-sized line gap. The fork curve is a
// bezier merging the branch lane into the mainline.
//
// Fleet mode (bindFleet) renders a whole fleet with the same two lanes: the
// mainline is the most advanced host's public history, and every host's
// branch section forks off it at that host's own origin/master — lagging
// hosts visibly attach lower. Row keys are host-prefixed (fleetKey).
//
// Two render modes (commit-review-v2 — design.md "The rail (nodes mode)"):
// flat is the plain per-commit log; nodes groups drafts by their `Project:`
// trailer under project rows — hollow hexagon medallions (a container, not
// a reviewable node) that absorb their members by default, so the resting
// rail reads as project rows + ungrouped singles. Nodes mode drops every
// chip: medallion shape = kind, color = state, and per-commit detail lives
// in the pane. The owner drives the mode via setMode(); flat is the
// default and is exactly the pre-nodes renderer.
//
// Selection is driven by the owner: clicking a row only reports through
// `onSelect(key)`; the owner calls setSelected() to reflect it.

/** `.handle` styling, duplicated into every shadow root that draws one — the
 * medallion palette does the same, and for the same reason: shadow roots
 * share no stylesheet. It deliberately does NOT look like a web link.
 * Underlining every id would stripe the rail; a handle reads as text until
 * the pointer is on it, and only then admits that it goes somewhere.
 *
 * The sizing is NOT here — [`$handleLink`] inlines `font: inherit` on the
 * element itself, and the reason is worth the paragraph. `component.ts`
 * injects `Typography.style` into EVERY shadow root, and there an `<a>` is a
 * first-class typography element: `a { --font-size: var(--p-size) }` plus
 * `font-size: var(--rfont-size)` retypesets it as a cap-height-scaled
 * PARAGRAPH. Measured, a handle came out at 13.9px inside a 12px warn
 * sentence, an 11.5px header sub, a 9.72px rail sub and a 9.5px minitree row
 * alike — it never consulted its container at all, because the machinery
 * keys off `--font-size` and most of these containers set a plain
 * `font-size`. Inheriting the whole `font` shorthand takes the parent's
 * COMPUTED family, size, weight and line-height, which is right whether that
 * parent went through the typography scale or set its own px.
 *
 * Nothing that decorates a handle may set a font property either: a handle is
 * a word inside somebody else's line, and that line already chose a family
 * and a size that agree. A `font-family: mono` on the blocker rule — carried
 * over from when the content was a 16-hex Change-Id — was the other half of
 * this bug. */
const HANDLE_STYLE = css`
  a.handle {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  a.handle:hover {
    color: var(--text-pri);
    text-decoration: underline;
  }
`;

/** The project row menu's fixed width — `ContextMenu.builder` takes px, and
 * three short verbs need no more than the inbox's own row menu. */
const PROJECT_MENU_W = 132;

@component({ name: "std-stack-log" })
export class StackLog extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private $tip: HTMLElement = this.$("tip");

  /** Set by the owner: a row was clicked. Cross-repo (foreign) project
   * members report through this too — they carry a `foreign:<repo>:<sha>`
   * key like every other selectable row, and the owner opens them in place
   * without moving the rail. */
  onSelect: Option<(key: StackLog.Key) => void> = null;

  /** Set by the owner: the app's own URL for a row key, or null when that row
   * has no address. Every handle the rail draws becomes a link through this —
   * the owner answers because the route grammar is its property, not the
   * rail's. Unset (the default) draws handles as plain text. */
  hrefOf: Option<(key: StackLog.Key) => Option<string>> = null;

  /** Set by the owner: persist one project hold / pin mutation, by slug.
   * Unset means the host cannot take that write, and the verb is left out of
   * the row menu rather than offered and refused — the same degradation the
   * inbox makes through its `holdable`/`pinnable` flags.
   *
   * The rail reports a REQUEST and re-renders when the owner re-binds. It
   * does not mutate its own row: the decoration is on the project node in
   * the owner's stack cache, and a rail that painted its own optimistic
   * answer would be a second source of truth for the same bit. */
  onSetHeld: Option<(key: StackLog.Key, slug: string, held: boolean) => void> = null;
  onSetPinned: Option<(key: StackLog.Key, slug: string, pinned: boolean) => void> = null;

  /** The element whose right edge the row tooltip hugs. Rows keep their full
   * width in compact mode and are clipped by the owner's rail, so this
   * component's own box is the WRONG anchor — it would park the tooltip a
   * rail-width out into the pane. Defaults to self when the owner sets
   * nothing. */
  tipAnchor: Option<HTMLElement> = null;

  private mode: StackLog.Mode = "flat";
  /** Last-bound model, kept so setMode() can re-render without the owner
   * re-fetching; exactly one of the two is live. */
  private model: Option<StackLog.Model> = null;
  private fleetModel: Option<StackLog.FleetModel> = null;
  /** Nodes mode: slugs of the projects the operator opened. Survives
   * rebinds (a reload must not slam every container shut again). */
  private openProjects = new Set<string>();
  /** The last render's reuse units — what [`reconcile`] diffs the next render
   * against. Cleared whenever the rows on screen stop being a render's output
   * (placeholders, recycle). */
  private units = new Map<string, Rows.Unit>();
  /** The owner's selection, kept so a re-render can hand the band back to a
   * row it just rebuilt. Reconciliation reuses unchanged nodes, which KEEP
   * the class — so without this the band would appear to fall off the
   * selected row whenever that one row happened to change. */
  private selected: Option<StackLog.Key> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$root, {
      onClick: (_captured, _offset, event) => {
        const $target = event.target as HTMLElement;
        // A project row's affordance is split: the CARET is the collapse
        // control (design.md calls it exactly that), the rest of the cell
        // selects the project. Handled before the keyed-row path so the
        // caret never doubles as a selection.
        const $caret = $target.closest<HTMLElement>(".row.project .accessory");
        if ($caret != null) {
          const $project = $caret.closest<HTMLElement>(".row.project");
          const setOpen = $project != null ? Rows.PROJECT_OPEN.get($project) : null;
          if ($project != null && setOpen != null) {
            setOpen(!$project.classList.contains("opened"));
            return;
          }
        }
        // A handle link names a row that is NOT the one it sits in (a
        // blocker, a fixup target), so the row's own key must not claim the
        // click. The anchor's `href` does the navigating — see
        // [`Rows.$handleLink`].
        if ($target.closest<HTMLElement>("a.handle[href]") != null) return;
        const $row = $target.closest<HTMLElement>(".row[data-key]");
        const key = $row?.dataset.key;
        if (key != null) this.onSelect?.(key);
      },
    });
    // Row tooltip. Plain listeners rather than GESTURE_MANAGER: this is
    // hover, not a gesture, and it must not compete for the pointer.
    // Matches `.row`, NOT `.row[data-key]` — a host-head row is unkeyed (it
    // is a section marker, not a selection), but in compact mode its chip is
    // a 3-letter abbreviation and the tooltip is the only way to expand it.
    // Rows with nothing to say (fork, tail, collapsed-run) fall out of
    // showTip's own guard.
    this.$root.addEventListener("pointerover", (event) => {
      const $row = (event.target as HTMLElement).closest<HTMLElement>(".row");
      if ($row == null) this.hideTip();
      else this.showTip($row);
    });
    this.$root.addEventListener("pointerleave", () => this.hideTip());
    // Project rows carry the same two verbs the inbox offers on its own
    // project rows. The rail is where the operator actually is when they
    // decide a project can wait (or cannot), so making them switch views to
    // say so was the gap this closes.
    this.$root.addEventListener("contextmenu", (event) => {
      const $project = (event.target as HTMLElement).closest<HTMLElement>("[data-project-row]");
      const slug = $project?.dataset.projectRow;
      if ($project == null || slug == null) return;
      if (this.onSetHeld == null && this.onSetPinned == null) return;
      event.preventDefault();
      // The tooltip is hover-driven and would otherwise sit over the menu it
      // has no relationship with.
      this.hideTip();
      this.showProjectMenu($project, slug, { x: event.clientX, y: event.clientY });
    });
  }

  /** A project row's verbs. Open is first because a right-click user expects
   * the primary action in the menu too; the state each verb reads comes off
   * the ROW's own classes, which the render just set — not from a copy this
   * component would have to keep in step with its own re-renders. */
  private showProjectMenu($project: HTMLElement, slug: string, at: Point): void {
    // The row's OWN key, not `projectKey(slug)`: in fleet mode keys carry a
    // host prefix, and re-deriving one here would send the owner resolving
    // the wrong host's project.
    const key = $project.dataset.key ?? StackLog.projectKey(slug);
    // A reflection takes neither verb, the same refusal the inbox makes
    // through `holdable`/`pinnable`: the decoration belongs on the host that
    // owns the work, and one placed here could never be answered from here.
    const mirrored = $project.dataset.mirrored === "1";
    const held = $project.classList.contains("held");
    const pinned = $project.classList.contains("pinned");
    const builder = ContextMenu.builder(PROJECT_MENU_W);
    builder.cellRow("Open", null, () => this.onSelect?.(key));
    if (!mirrored && this.onSetPinned != null) {
      builder.cellRow(pinned ? "Unpin" : "Pin", null, () => this.onSetPinned?.(key, slug, !pinned));
    }
    if (!mirrored && this.onSetHeld != null) {
      builder.cellRow(held ? "Resume" : "Hold", null, () => this.onSetHeld?.(key, slug, !held));
    }
    builder.buildAndReveal($project, { position: Position.fromPoint(at) });
  }

  /** Compact = the owner collapsed its rail to the graph lane. Rows keep
   * their full 300px layout and the text is simply clipped away, so the
   * lane, node colors and selection band all keep working untouched. */
  setCompact(compact: boolean): void {
    this.toggleAttribute("compact", compact);
    this.hideTip();
  }

  private hideTip(): void {
    this.$tip.toggleAttribute("shown", false);
  }

  /** Shown when the row has something the eye cannot already read: always
   * in compact mode (no text at all), and otherwise only when the subject
   * is genuinely ellipsized. A tooltip that repeats a legible label is
   * noise on every mouse move. */
  private showTip($row: HTMLElement): void {
    const compact = this.hasAttribute("compact");
    const $text = $row.querySelector<HTMLElement>(".subject .text, .host-name");
    if ($text == null) return this.hideTip();
    const clipped = $text.scrollWidth > $text.clientWidth + 1;
    if (!compact && !clipped) return this.hideTip();

    const $title = document.createElement("div");
    $title.className = "tip-title";
    $title.textContent = $text.textContent;
    const $children: HTMLElement[] = [$title];
    // Compact mode hides the sub line too, so carry it — it is what tells
    // two same-colored nodes apart. `data-tip-sub` is the opt-out for rows
    // whose caption is not all text: a project container's state roll-up is
    // a strip of svg dots, and its textContent would drop the whole signal.
    const sub = compact
      ? ($row.dataset.tipSub ?? $row.querySelector<HTMLElement>(".sub")?.textContent)
      : null;
    if (sub != null && sub !== "") {
      const $sub = document.createElement("div");
      $sub.className = "tip-sub";
      $sub.textContent = sub;
      $children.push($sub);
    }
    this.$tip.replaceChildren(...$children);

    // `position: fixed` so the tooltip escapes the owner's collapsed rail,
    // which clips every positioned descendant (this is exactly why
    // std-tooltip cannot be used for rows).
    const row = $row.getBoundingClientRect();
    const anchor = (this.tipAnchor ?? this).getBoundingClientRect();
    this.$tip.style.top = `${row.top + row.height / 2}px`;
    this.$tip.style.left = `${anchor.right + 8}px`;
    this.$tip.toggleAttribute("shown", true);
  }

  bind(model: StackLog.Model): void {
    this.model = model;
    this.fleetModel = null;
    this.render();
  }

  /** Fleet mode: one tree — the trunk is the most advanced host's public
   * history, and every host's branch lane forks off it at that host's
   * origin/master. Row keys are host-prefixed ([`StackLog.fleetKey`]). */
  bindFleet(model: StackLog.FleetModel): void {
    this.fleetModel = model;
    this.model = null;
    this.render();
  }

  /** Placeholder rows for a tab whose data has never been read.
   *
   * The rail must not sit on the previous repo's commits while a cold tab
   * loads. Those rows are *wrong* for the tab that is now active, and leaving
   * them up for the length of a fetch reads as "these are this tab's commits"
   * — the click appears to have done nothing, then the list lurches. Showing
   * placeholders makes the click land immediately and says plainly that the
   * answer is still coming.
   *
   * `rowCount` is the caller's estimate — pass the outgoing tab's row count so
   * the column keeps roughly its height and the scrollbar does not jump when
   * the real rows arrive. Cleared implicitly: the next `bind`/`bindFleet`
   * replaces these children wholesale. */
  setLoading(rowCount: number): void {
    this.model = null;
    this.fleetModel = null;
    // Placeholders are not a render's output, so nothing here may be matched
    // against the next one — a skeleton reused as a commit row would be a row
    // that never repaints.
    this.units.clear();
    const $rows: HTMLElement[] = [];
    for (let i = 0; i < rowCount; i++) {
      const $r = document.createElement("div");
      $r.className = "row skeleton";
      const $bar = document.createElement("div");
      $bar.className = "pulse skel-bar";
      // Uneven widths so it reads as a list of subjects, not a grid. Derived
      // from the index rather than randomly, so a re-render is stable.
      $bar.style.width = `${48 + ((i * 37) % 38)}%`;
      $r.appendChild($bar);
      $rows.push($r);
    }
    this.$root.replaceChildren(...$rows);
  }

  /** Flat ⇄ nodes. Re-renders the last-bound model in place; the owner
   * re-applies selection afterwards (setSelected auto-opens the project a
   * hidden selection sits in). */
  setMode(mode: StackLog.Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
  }

  private render(): void {
    const ctx: Rows.Ctx = {
      nodes: this.mode === "nodes",
      open: this.openProjects,
      hrefOf: this.hrefOf,
    };
    const $rows =
      this.model != null
        ? Rows.build(this.model, ctx)
        : this.fleetModel != null
          ? Rows.buildFleet(this.fleetModel, ctx)
          : null;
    if ($rows == null) return;
    this.reconcile($rows);
    // The rows just built carry no selection band (nothing in `Rows` knows
    // about one); the reused ones carry whichever they had. Re-assert it so
    // the two agree. NOT via setSelected: its expand-for-a-hidden-key pass
    // rewrites the very children this just placed.
    this.markSelected();
  }

  /** KEYED RECONCILIATION — the reason a refresh that lands while you are
   * reading no longer moves the rail under you.
   *
   * Every bind used to `replaceChildren` the whole list, so the rail's scroll
   * container lost every node it was anchored to and the owner had to read
   * `scrollTop` before the bind and write it back after. That hand-restore
   * cost a forced layout per refresh and was only ever approximately right:
   * the rows above the reader may have changed height in the very refresh
   * being restored, and the row under the pointer was a different element
   * afterwards either way.
   *
   * Here each row is matched to its previous node by KEY — its own `data-key`
   * (sha/cid/queue-id/project, stable across refetches), or a positional
   * stand-in for the handful of unkeyed structural rows (fork curves, tails,
   * host heads, collapsed runs) — and REUSED IN PLACE when its rendered
   * content is byte-identical. A changed row swaps, a moved row is moved (one
   * `insertBefore`, not a re-render), and the nodes the browser's scroll
   * anchoring is holding simply stay where they are.
   *
   * UNITS, not rows, are the reuse quantum. A project container's open/close
   * setter captures its member NODES ([`Rows.PROJECT_OPEN`]) and a collapsed
   * run holds its hidden rows the same way, so reusing half of such a group
   * would leave a caret toggling elements no longer on screen. A project and
   * all of its members — native and foreign, however the stack interleaves
   * them — therefore reuse together or re-render together. */
  private reconcile($next: HTMLElement[]): void {
    const units = Rows.unitize($next);
    // Decide once per unit, then place per row: a project's rows are not
    // contiguous when another project interleaves with it, but the verdict on
    // them is one verdict.
    const kept = new Map<string, HTMLElement[]>();
    for (const [key, unit] of units) {
      const prev = this.units.get(key);
      if (prev != null && prev.sig === unit.sig && prev.$rows.length === unit.$rows.length) {
        kept.set(key, prev.$rows);
      }
    }
    const placed = new Map<string, number>();
    // The cursor is the next node the desired order has not claimed yet;
    // everything before it is already correct.
    let $cursor: Option<ChildNode> = this.$root.firstChild;
    for (const $new of $next) {
      const key = Rows.UNIT_KEY.get($new);
      if (key == null) continue;
      const at = placed.get(key) ?? 0;
      placed.set(key, at + 1);
      const $place = kept.get(key)?.[at] ?? $new;
      // Keep the unit pointing at the nodes actually on screen, so the NEXT
      // reconcile diffs against what is there rather than what was built.
      const unit = units.get(key);
      if (unit != null) unit.$rows[at] = $place;
      if ($cursor === $place) $cursor = $place.nextSibling;
      else this.$root.insertBefore($place, $cursor ?? null);
    }
    // Whatever the walk never claimed is gone from the model — including any
    // row a reader had expanded out of a collapsed run, which the new build
    // has collapsed again.
    while ($cursor != null) {
      const $after: Option<ChildNode> = $cursor.nextSibling;
      $cursor.remove();
      $cursor = $after;
    }
    this.units = units;
  }

  onRecycle(): void {
    super.onRecycle();
    this.mode = "flat";
    this.model = null;
    this.fleetModel = null;
    this.openProjects.clear();
    this.units.clear();
    this.selected = null;
  }

  setSelected(key: Option<StackLog.Key>): void {
    this.selected = key;
    // A key hidden inside a collapsed public run expands its run first, so
    // deep links and kept selections always land on a visible row.
    if (key != null) this.expandFor(key);
    this.markSelected();
  }

  /** Paint the selection band onto the rows currently on screen. */
  private markSelected(): void {
    const key = this.selected;
    for (const $r of this.$root.querySelectorAll<HTMLElement>(".row")) {
      $r.classList.toggle("active", key != null && $r.dataset.key === key);
    }
  }

  /** Keys of the selectable rows in display order — including rows tucked
   * inside collapsed public runs (they are live, just not shown yet). */
  keys(): StackLog.Key[] {
    const keys: StackLog.Key[] = [];
    for (const $r of this.$root.querySelectorAll<HTMLElement>(".row")) {
      const hidden = Rows.COLLAPSED.get($r);
      if (hidden != null) {
        for (const $h of hidden) if ($h.dataset.key != null) keys.push($h.dataset.key);
      } else if ($r.dataset.key != null) {
        keys.push($r.dataset.key);
      }
    }
    return keys;
  }

  /** If `key` sits inside a collapsed run or a closed project, expand its
   * container in place. */
  private expandFor(key: StackLog.Key): void {
    const $found = this.$root.querySelector<HTMLElement>(`.row[data-key="${key}"]`);
    if ($found != null) {
      // A project member absorbed by its closed container: open the
      // container so the selection band has a visible row to land on.
      if ($found.classList.contains("absorbed")) {
        const slug = $found.dataset.project;
        const $p =
          slug != null
            ? this.$root.querySelector<HTMLElement>(`.row[data-project-row="${slug}"]`)
            : null;
        if ($p != null) Rows.PROJECT_OPEN.get($p)?.(true);
      }
      return;
    }
    for (const $c of this.$root.querySelectorAll<HTMLElement>(".row.collapse")) {
      const hidden = Rows.COLLAPSED.get($c);
      if (hidden != null && hidden.some(($h) => $h.dataset.key === key)) {
        $c.replaceWith(...hidden);
        return;
      }
    }
  }

  static $styles = [
    HANDLE_STYLE,
    css`
      #root {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .row {
        display: flex;
        align-items: center;
        min-height: 40px;
        border-radius: 6px;
      }
      .row[data-key] {
        cursor: pointer;
      }
      /* Cold-load placeholders. Same pitch and padding as a real row, so the
         column keeps its rhythm and nothing reflows when the rows land. */
      .row.skeleton {
        padding: 0 10px;
        pointer-events: none;
      }
      .skel-bar {
        height: 9px;
        border-radius: 3px;
        background: var(--bg-surface-light);
        animation: stack-log-pulse 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }
      @keyframes stack-log-pulse {
        50% {
          opacity: 0.45;
        }
      }
      .row[data-key]:hover {
        background: var(--bg-hover-light);
      }
      /* Compact (owner collapsed to the graph lane). The content cell starts
         at x=40 and the strip is 52 wide, so the first ~12px of every subject
         would bleed down the edge as a column of half-letters. Push the text
         out past the strip edge rather than fading it: an opacity: 0 cell is
         still laid out and still takes the pointer, so it would sit on top of
         the graph lane and swallow hovers meant for the nodes. Offsetting
         leaves the row's own box where it was, so nothing reflows mid-collapse
         and the rail's overflow does the clipping. */
      :host([compact]) .content {
        padding-left: 16px;
      }
      /* The node is the only thing left to aim at — grow it on hover so the
         strip still gives per-row feedback rather than one undifferentiated
         band of color. */
      svg.node-svg {
        transition: transform 0.12s ease;
      }
      :host([compact]) .row[data-key]:hover svg.node-svg {
        transform: translate(-50%, -50%) scale(1.3);
      }
      @media (prefers-reduced-motion: reduce) {
        svg.node-svg {
          transition: none;
        }
      }
      /* Row tooltip. Fixed, so it escapes the owner's collapsed rail (which
         clips every positioned descendant). Placed by showTip(). */
      #tip {
        position: fixed;
        z-index: 20;
        max-width: 280px;
        transform: translateY(-50%);
        padding: 6px 10px;
        border-radius: 6px;
        background: var(--bg-tooltip);
        color: var(--fg-tooltip);
        pointer-events: none;
        user-select: none;
        opacity: 0;
        transition: opacity 0.18s ease;
      }
      #tip[shown] {
        opacity: 1;
        transition-delay: 150ms;
      }
      .tip-title {
        font-size: 12.5px;
        line-height: 1.35;
      }
      .tip-sub {
        font-family: var(--mono, monospace);
        font-size: 10.5px;
        line-height: 1.35;
        margin-top: 2px;
        opacity: 0.7;
      }
      .row.active {
        background: var(--bg-hover);
      }
      /* The accepted bottom segment and public history read as bands. */
      .row.seg-approved {
        background: color-mix(in srgb, var(--green) 7%, transparent);
      }
      .row.seg-approved:hover {
        background: color-mix(in srgb, var(--green) 14%, transparent);
      }
      .row.seg-approved.active {
        background: color-mix(in srgb, var(--green) 20%, transparent);
      }
      .row.seg-public .subject {
        color: var(--text-ter);
      }
      /* A MIRRORED draft: someone else's work in progress, replayed onto this
         host (a Mirrored-From trailer). It must read as NOT-YOURS at a glance,
         and the only register free to say so is opacity — the row already
         spends shape on kind and color on state, and this host cannot vote on
         it, so it must not look like a row merely waiting for a verdict.

         Dimming COMPOSES; a grey fill would replace. A color or background
         rule here would flatten an approved medallion's green into the same
         neutral a pending one gets, which is exactly the failure the block
         wash above is written against — grey, the worst of both. At 0.5 the
         medallion keeps its hue and its silhouette, just quieter, so the two
         signals stack: "approved, and not mine to approve".

         Applied to the content and the node, never to the lane lines: the
         branch lane is continuous history through this commit, and fading it
         would put a gap in the rail where a mirrored draft happens to sit. */
      .row.mirror .content,
      .row.mirror svg.node-svg {
        opacity: 0.5;
      }

      /* Hold is workflow state, not review state: keep the status colour and
         graph lane, but quiet the project itself. */
      .row.project.held .content,
      .row.project.held svg.node-svg {
        opacity: 0.52;
      }
      /* A pin outranks the quieting, including on a project that is BOTH
         parked and pinned: the pin is somebody asking for it back, and a
         request rendered at 52% is a request nobody reads. */
      .row.project.pinned .content,
      .row.project.pinned svg.node-svg {
        opacity: 1;
      }
      .hold-mark {
        flex: none;
        margin-left: 6px;
        color: var(--text-ter);
        font-family: var(--mono, monospace);
        font-size: 9px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      /* Same shape AND the same tertiary ink as the hold mark — they are the
         same kind of fact, and a rail whose every workflow mark shouts in a
         different colour is one where none of them read. The pin's emphasis
         comes from POSITION (the inbox floats it to the top, behind a
         divider), never from an outline or an accent fill. */

      /* ── graph cell: two lanes (main x=9, branch x=23), all SVG ── */
      .graph {
        position: relative;
        width: 36px;
        flex-shrink: 0;
        align-self: stretch;
      }
      /* Overdrawn by the row gap (0.5px each side) so lane lines meet
         seamlessly across the 1px space between rows. */
      svg.lines {
        position: absolute;
        left: 0;
        width: 100%;
        top: -0.5px;
        height: calc(100% + 1px);
        display: block;
        overflow: visible;
      }
      .lane {
        stroke: var(--divider);
        stroke-width: 1.5;
        fill: none;
      }
      .lane.dotted {
        stroke-dasharray: 2 3;
      }
      svg.node-svg {
        position: absolute;
        left: 23px;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 12px;
        height: 12px;
        display: block;
        overflow: visible;
      }
      svg.node-svg.main {
        left: 9px;
      }
      /* Bare nodes (public diamonds, the unstaged hollow) stay gray; only
         state-classed nodes carry the verdict palette:
         yellow = needs-review, red = request-revisions, green = accepted. */
      .node {
        fill: var(--text-ter);
        stroke: none;
      }
      .node.pending {
        fill: var(--yellow);
      }
      .node.approved {
        fill: var(--green);
      }
      .node.changes_requested {
        fill: var(--red);
      }
      .node.hollow {
        fill: none;
        stroke: var(--text-ter);
        stroke-width: 1.4;
      }
      .node.hollow.pending {
        fill: none;
        stroke: var(--yellow);
      }
      .node.hollow.approved {
        fill: none;
        stroke: var(--green);
      }
      .node.hollow.changes_requested {
        fill: none;
        stroke: var(--red);
      }
      /* Purple is the project container's own state — "pure planning: docs
         and no code yet" — and belongs to no commit verdict, which is
         exactly why it gets a hue the verdict palette never uses.

         --purple-fg, not --purple: the raw token is #dbacff, a pale lavender
         sized for fills, and at a 1.4px stroke on a white rail it reads as a
         smudge next to the yellow and green it has to be told apart from.
         The -fg variant is light-dark(#c78af3, #dbacff) — the same colour
         deepened for light mode — which is the identical fix
         --sys-yellow-deep already exists for. */
      .node.ready {
        fill: var(--purple-fg);
      }
      .node.hollow.ready {
        fill: none;
        stroke: var(--purple-fg);
      }
      .node.hollow.dashed {
        stroke-dasharray: 2 2;
      }
      .row.fork {
        min-height: 18px;
      }
      /* Fleet mode: a host's branch section opens with its head row — the
         host name + caption as a badge that hugs its text on a subtle
         background, sitting over the start of the branch lane. */
      .row.host-head {
        min-height: 34px;
      }
      .host-badge {
        background: var(--bg-hover-light);
        border: 1px solid var(--divider);
        border-radius: 7px;
        padding: 4px 9px 5px;
      }
      /* Same typography as commit rows: name = .subject, caption = .sub. */
      .host-badge .host-name {
        --font-size: var(--text-9px);
        color: var(--text-pri);
        white-space: nowrap;
      }
      /* The connector from the badge back into the branch lane: a rounded
         corner drawn with borders — horizontal out of the badge's left
         edge, sweeping down into the lane. Left edge matches the lane
         stroke (x=23 center, 1.5 wide → 22.25); bottom overdraws the row
         gap like svg.lines so it meets the next row's lane. */
      .badge-link {
        position: absolute;
        left: 22.25px;
        right: 0;
        top: 50%;
        bottom: -0.5px;
        border-left: 1.5px solid var(--divider);
        border-top: 1.5px solid var(--divider);
        border-top-left-radius: 10px;
      }
      /* ── compact host marker ──
         The badge lives in the content cell, which compact mode fades out —
         so the elbow that pointed at it would run to nothing and read as a
         severed branch, and nothing would say whose branch this is. Drop the
         elbow, and put a short host label right on the branch lane. */
      .host-chip {
        display: none;
      }
      :host([compact]) .badge-link {
        display: none;
      }
      /* LEFT-anchored, not centred. The mainline runs at x=9 (1.5px stroke,
         so its right edge is 9.75) and the branch lane at x=23; pinning the
         left edge at 14.5 keeps ~4.75px of air off the mainline no matter how
         wide the label gets. At the usual 1–2 characters the 17px min-width
         lands the chip centred on the branch lane anyway, and a rare 3-char
         label (two hosts colliding, e.g. aws-01/aws-11 -> a1/a11) simply grows
         rightward into the strip's spare room instead of being clipped. */
      :host([compact]) .host-chip {
        display: flex;
        align-items: center;
        justify-content: center;
        position: absolute;
        left: 14.5px;
        top: 50%;
        transform: translateY(-50%);
        box-sizing: border-box;
        min-width: 17px;
        padding: 1px 2px;
        border: 1px solid var(--divider);
        border-radius: 4px;
        background: var(--bg-elevated, var(--bg));
        color: var(--text-sec);
        font-family: var(--mono, monospace);
        font-size: 9px;
        line-height: 1.3;
        letter-spacing: -0.02em;
        white-space: nowrap;
      }
      :host([compact]) .host-chip.warn {
        color: var(--red);
        border-color: color-mix(in srgb, var(--red) 45%, var(--divider));
      }
      /* The badge stays in the DOM — the row tooltip reads its .host-name —
         but it must stop reserving the height the expanded badge needs. */
      :host([compact]) .row.host-head .content {
        height: 0;
        padding: 0;
        overflow: hidden;
      }
      :host([compact]) .row.host-head {
        min-height: 28px;
      }

      /* ── content cell ── */
      .content {
        flex: 1;
        min-width: 0;
        padding: 5px 8px 5px 0;
      }
      /* Row text is baseline-capheight (Typography.style, in every
         component's base sheet). The machinery keys off the .text class
         and a declared --font-size: without one, --rfont-size computes
         invalid, the negative cap/baseline trim silently no-ops, and the
         box keeps its full leading — which is why the subject/sub used to
         sit optically low against the medallion the row centers on.
         --font-size is baseline-to-capheight, NOT em-square: --text-9px
         means the caps measure exactly 9px. */
      .subject {
        display: flex;
        align-items: baseline;
        gap: 5px;
        color: var(--text-pri);
        white-space: nowrap;
      }
      .subject .text {
        --font-size: var(--text-9px);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chip {
        flex-shrink: 0;
        font-family: var(--mono, monospace);
        font-size: 9.5px;
        color: var(--text-ter);
        border: 1px solid var(--divider);
        border-radius: 4px;
        padding: 0 4px;
      }
      /* --margin-top is baseline-of-subject to capheight-of-sub, so it
         reads tighter than the plain margin it replaces. */
      .sub {
        --font-size: var(--text-7px);
        --margin-top: 7px;
        color: var(--text-ter);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub.warn {
        color: var(--orange);
      }
      .row.tail {
        min-height: 22px;
      }
      .tail .content {
        color: var(--text-ter);
      }
      .tail .content .text {
        --font-size: var(--text-7px);
      }
      /* A collapsed run of public commits: "⋯ N commits", click to expand
         in place. Dotted lane = elided history, same voice as the tail.
         The label is a baseline-capheight element (.label), so it centers
         optically in the row; --font-size is cap-height units (~1.4×). */
      .row.collapse {
        min-height: 24px;
        cursor: pointer;
      }
      .row.collapse:hover {
        background: var(--bg-hover-light);
      }
      .row.collapse .label {
        --font-size: var(--text-7px);
        color: var(--text-ter);
      }
      /* ── nodes mode: project rows (commit-review-v2) ──
         The project row is the same list-cell as every row — hexagon
         medallion, caret, slug, counts sub — carrying exactly the same text
         treatment as a commit row, so only the medallion says "container".
         Expanded =
         opened container: a dashed outline wraps the ENTIRE cell, drawn by
         an inset pseudo-element so nothing reflows, and the slug drops to
         tertiary; medallion and lane stay solid either way. */
      .row.project {
        position: relative;
        cursor: pointer;
      }
      .row.project:hover {
        background: var(--bg-hover-light);
      }
      /* The caret sits in the ACCESSORY position — the trailing slot of the
         list cell (components/list/list-cell-layout.ts: icon, then content,
         then accessory, the last flex-shrink: 0). It used to sit inside the
         subject ahead of the slug, which is the icon's position, and the row
         already has an icon there: the medallion. Two leading accessories
         competing, with the disclosure control buried in the text flow
         instead of anchored where a disclosure belongs.

         Rotation is the open/close feedback — one chevron moving, not two
         glyphs swapped. Drawn as an svg (the accordion/dropdown chevron) so
         it carries no text leading: as a glyph it was the tallest box in the
         subject row under baseline alignment and pushed the container's sub
         ~4px below a commit row's. Out of the content entirely, it cannot
         reach the row's type at all. */
      .row.project .accessory {
        position: relative;
        display: flex;
        align-self: center;
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        margin-right: 8px;
      }
      /* 14px is the BOX, not the caret. The path is the shared 0 0 24 24
         chevron and its ink covers only x 8.59-16 / y 6-18 of that square,
         so the visible mark is ~4.3 x 7px — next to 9px caps that reads as
         a caret. At the 8px box it first shipped at, the ink was 2.5 x 4px:
         a speck. Size the box by the ink you want, not by the viewBox. */
      .row.project .accessory svg {
        width: 14px;
        height: 14px;
        fill: var(--text-ter);
        transition: transform 0.3s ease;
      }
      .row.project.opened .accessory svg {
        transform: rotate(90deg);
      }
      @media (prefers-reduced-motion: reduce) {
        .row.project .accessory svg {
          transition: none;
        }
      }
      /* The caret is the collapse control and the rest of the cell selects
         the project, so it needs a target bigger than its 8px of ink. An
         overlay pseudo-element rather than padding, which would grow the
         accessory box and pull the content cell in. */
      .row.project .accessory::after {
        content: "";
        position: absolute;
        inset: -11px -8px;
      }
      .row.project.opened .subject .text {
        color: var(--text-ter);
      }
      /* ── the container's state roll-up ──
         The container's caption, and the whole of it. A closed project
         absorbs its members entirely, so the row could say how BIG the
         project was ("2 plans · 5 drafts") but not how FAR it had got — the
         one question the container is asked from across the rail. The pips
         answer it: one dot per member, in stack order, in exactly the
         medallion vocabulary the rows below already teach — color = state,
         hollow = no diff to review inside. Nothing new to learn; it is the
         members' own column of medallions, shrunk.

         They REPLACE the counts rather than joining them, because the strip
         already is the count: its length is the member total and its hollow
         dots are the plans. Two readings of one fact, and the numbers were
         the slower one.

         This does NOT re-open the chip question nodes mode closed. A chip is
         a per-commit label repeating what that commit's own medallion
         already says. These dots stand for rows that are NOT on screen, and
         they are the medallion, not a word about it.

         The strip WRAPS, and so has no cap: a long project spends rail
         height rather than hiding most of itself behind a "+15". Height is
         the cheap axis on a scrolling rail; truncation was the expensive
         one, because the commits a cap dropped were exactly the ones
         furthest from review. */
      .pips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
        /* The caption line box is cap-height-trimmed, so baseline-sitting
           dots hang optically low against the x-band a commit row's sub
           occupies — and a single-line container's caption has to sit on the
           same band as its neighbours' or the rail's rhythm breaks. */
        position: relative;
        top: 0.5px;
      }
      .pip-svg {
        width: 7px;
        height: 7px;
        flex-shrink: 0;
        display: block;
        overflow: visible;
      }
      /* The shared 1.4 stroke is written for the 12px medallion; at pip
         scale it lands near half a pixel and the ring dissolves into a
         washed-out version of its own fill. Restate it in the pip's scale so
         hollow still reads as an outline. */
      .pip-svg .node.hollow {
        stroke-width: 2;
      }
      /* Wrapping is the whole point of the strip, so the caption that holds
         it must stop being a single ellipsized line. Scoped to the container
         row: every other sub in the rail is a one-line locator that SHOULD
         ellipsize. */
      .row.project .sub {
        white-space: normal;
        overflow: visible;
      }
      /* ── what a wrapped strip costs in row height ──
         A wrapping caption only grows the row honestly if the cell has NO
         SLACK to eat first. Every .row carries min-height: 40px while a
         container's ink measures ~16.4px, so ~13.6px of that pitch was
         unclaimed padding — and the first wrapped line simply vanished into
         it. Measured: a 2-line container was still exactly 40px tall, and
         the THIRD line was the first to cost anything, at ~10px. Growth that
         is 0px, then 10px, then 12px reads as a rendering accident.

         So the cell claims the whole pitch itself. With the padding sized to
         fill 40px at one strip line, the content box IS the row at one line
         and the binding constraint at two or more — every wrapped line then
         costs exactly --pip-line and nothing else. The single-line row does
         not move a pixel: 11.8px of padding is precisely what the old
         5px-padding-plus-centring already produced (6.8 + 5).

         --project-ink is MEASURED, not derived: the subject and sub are
         cap-height-trimmed by negative margins, so their boxes do not sum to
         their ink. If the type tokens change, re-measure it — everything
         else here follows from it. */
      .row.project .content {
        --row-pitch: 40px;
        --pip-line: 12px; /* 7px pip + the strip's 5px row-gap */
        --project-ink: 16.4px; /* subject + trimmed gap + one strip line */
        padding-block: calc((var(--row-pitch) - var(--project-ink)) / 2);
      }
      /* Opened: every member is on screen wearing its own medallion, so the
         roll-up recedes with the slug rather than competing with the rows it
         is a summary of. */
      .row.project.opened .pips {
        opacity: 0.45;
      }
      /* Blocked is not a verdict — it is a reason the project cannot move —
         so it rides beside the palette rather than inside it, in the same
         orange a blocked commit's own sub uses. A flex item of the strip, so
         it wraps with the dots instead of stranding on a line of its own.

         Boxed to the pip's own 7px and centred inside it. Left to its text
         box the glyph measured 9.7px, so whichever strip line carried it
         grew 2.7px taller than the others — enough to make an otherwise
         uniform stack of rows step out of line, and enough to break the
         "every wrapped line costs exactly one PIP_LINE" arithmetic the cell
         padding below depends on. The glyph may overflow the box; only its
         layout contribution is being pinned. */
      .pips .flag {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 7px;
        margin-left: 2px;
        font-size: 9px;
        line-height: 1;
        color: var(--orange);
      }
      /* Opened container: the dashed boundary wraps the container row AND
         the commits it holds, not just its own cell. Members keep honest
         stack order, so an interleaved project arrives as several runs and
         each run is closed off on its own — the continuation stitch. Drawn
         as edges on the member rows (inset pseudo-element, nothing
         reflows): sides on every row of a run, caps on its first and last.
         The 1px flex gap between rows would otherwise break the side
         strokes, so each row overdraws it downward, the same trick the lane
         SVG uses to meet the next row. */
      .row.in-block.open-block {
        position: relative;
        isolation: isolate;
      }
      /* The wash is what makes the block read as one surface; the dashed
         edge alone only draws its outline, so a long run reads as two
         far-apart strokes with unclaimed rows between them.

         It rides its OWN layer rather than the row's background, because
         the rows underneath already own that channel — hover, .active, the
         green .seg-approved band — and a background here would replace
         whichever of those a row has, silently erasing approved-state color
         inside an opened project. As a separate layer it composites over
         them instead. isolation + z-index: -1 is what orders it: the row
         becomes a stacking context, so the wash lands above the row's own
         background and below its text, and cannot escape behind the rail.

         The tint is BLUE MIXED INTO THE TEXT COLOR, not blue mixed into
         transparent. Anchoring the value to --text-pri is what makes one
         rule work in both themes: it stays a dark cast on a light ground
         and a light cast on a dark one, where a flat blue would go nearly
         invisible against white and muddy against black.

         Blue because it marks a REGION, and every other hue on this rail
         marks a MARK: yellow/red/green a commit's verdict, purple a
         container's "cleared to build". Those all live on 12px medallions;
         this is a wash behind whole rows, and it must not read as one of
         them at a glance. Blue and teal are the two the marks never use;
         blue is the conventional region hue and the calmest here. 8% rather
         than the neutral 4% it replaces: below ~6% a tint this desaturated
         stops reading as a hue at all and just looks like a slightly dirty
         grey, the worst of both. It lands in the same weight class as the
         .seg-approved band (7% green) — a different signal in the same
         register, not a louder one. */
      .row.in-block.open-block::before {
        content: "";
        position: absolute;
        z-index: -1;
        top: 0;
        right: 1px;
        bottom: -1px;
        left: 1px;
        background: color-mix(
          in srgb,
          color-mix(in srgb, var(--blue) 70%, var(--text-pri)) 8%,
          transparent
        );
        pointer-events: none;
      }
      .row.in-block.open-block.block-start::before {
        top: 1px;
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
      }
      .row.in-block.open-block.block-end::before {
        bottom: 1px;
        border-bottom-left-radius: 6px;
        border-bottom-right-radius: 6px;
      }
      .row.in-block.open-block::after {
        content: "";
        position: absolute;
        top: 0;
        right: 1px;
        bottom: -1px;
        left: 1px;
        border-right: 1.5px dashed var(--divider);
        border-left: 1.5px dashed var(--divider);
        pointer-events: none;
      }
      .row.in-block.open-block.block-start::after {
        top: 1px;
        border-top: 1.5px dashed var(--divider);
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
      }
      .row.in-block.open-block.block-end::after {
        bottom: 1px;
        border-bottom: 1.5px dashed var(--divider);
        border-bottom-left-radius: 6px;
        border-bottom-right-radius: 6px;
      }
      /* Members a closed project absorbed. display: none (not opacity):
         the rows must vanish from layout so the lane stays continuous, but
         they stay in the DOM so keys() and deep links still resolve. */
      .row.absorbed {
        display: none;
      }
      /* ── nodes mode: foreign (cross-repo) project members ──
         A commit living in another repo's stack, grouped under this project
         by the server and rendered below the native members. It is an
         ordinary selectable row (foreign:<repo>:<sha> key), so hover, the
         selection band and the compact-mode node grow all come from the
         shared .row[data-key] rules above — nothing extra here. Only its
         graph cell differs: the DOTTED branch lane (dotted = elsewhere),
         with the mono <repo> · <sha7> locator as its sub. */
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root"></div>
    <div id="tip" role="tooltip"></div>
  `;
}

// ── SVG + row construction (pure element factories) ─────────────────────────
namespace Rows {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const BRANCH_X = "23";
  const MAIN_X = "9";

  /** Render context, threaded through the factories. `nodes` = the v2
   * project-grouped rail (chip-free rows, drafts absorbed into project
   * rows); `open` is the component's set of opened project slugs — build
   * reads it to seed each container and mutates it as the operator
   * toggles, so the state survives rebinds. */
  /** `hrefOf` turns a row key into the app's own URL for it. The OWNER
   * supplies it, because the route grammar (host, repo tab, the handle-vs-cid
   * choice) lives there — a component re-spelling it would be a second
   * serializer to keep in step with the first. Null while the owner has bound
   * no resolver, which renders every handle as plain text rather than as a
   * link to nowhere. */
  export type Ctx = {
    nodes: boolean;
    open: Set<string>;
    hrefOf: Option<(key: string) => Option<string>>;
  };

  /** Project row → its open/close setter, for the component's auto-expand
   * path (a deep link or kept selection landing on an absorbed member). */
  export const PROJECT_OPEN = new WeakMap<HTMLElement, (open: boolean) => void>();

  /** A reuse unit for [`StackLog.reconcile`]: the rows that must be reused or
   * rebuilt TOGETHER, plus the render signature they were built from. */
  export type Unit = { sig: string; $rows: HTMLElement[] };

  /** Row → the key of the unit it belongs to, stamped by [`unitize`]. */
  export const UNIT_KEY = new WeakMap<HTMLElement, string>();

  /** What a row renders as, for the byte comparison reconciliation makes.
   * Read off a FRESHLY BUILT node only — a live one carries the owner's
   * selection band, which is not something the model said. A collapsed run's
   * hidden rows ride along: two runs of the same LENGTH can hide different
   * commits, and the `⋯ N commits` label alone would call them equal. */
  function signature($r: HTMLElement): string {
    const hidden = COLLAPSED.get($r);
    return hidden == null ? $r.outerHTML : [$r, ...hidden].map(($h) => $h.outerHTML).join("");
  }

  /** Group a freshly built row list into its reuse units, in build order.
   *
   * A project container and every row belonging to it share ONE key — both
   * kinds of member carry `data-project` and the container `data-project-row`
   * — because the container's open/close setter captures those member nodes,
   * so a half-reused group would leave its caret toggling elements that are no
   * longer on screen. Everything else is its own unit: keyed rows by their
   * key, and the unkeyed structural rows (fork curve, tail, host head,
   * collapsed run) by kind + ordinal, which is the only identity they have —
   * and the right one, since one of them appearing or vanishing genuinely does
   * change what the ones after it are. */
  export function unitize($rows: HTMLElement[]): Map<string, Unit> {
    const units = new Map<string, Unit>();
    const ordinals = new Map<string, number>();
    for (const $r of $rows) {
      const slug = $r.dataset.projectRow ?? $r.dataset.project;
      let key: string;
      if (slug != null) {
        key = `project:${slug}`;
      } else if ($r.dataset.key != null) {
        key = `row:${$r.dataset.key}`;
      } else {
        const kind = `kind:${$r.className}`;
        const n = ordinals.get(kind) ?? 0;
        ordinals.set(kind, n + 1);
        key = `${kind}#${n}`;
      }
      UNIT_KEY.set($r, key);
      const unit = units.get(key);
      if (unit == null) {
        units.set(key, { sig: signature($r), $rows: [$r] });
      } else {
        unit.sig += signature($r);
        unit.$rows.push($r);
      }
    }
    return units;
  }

  function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string>,
  ): SVGElementTagNameMap[K] {
    const $e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) $e.setAttribute(k, v);
    return $e;
  }

  /** One member of a project container, reduced to what the roll-up shows:
   * its review state (color) and whether there is a diff to review inside
   * it (solid vs hollow). */
  type Pip = { state: StackLog.State; hollow: boolean };

  /** No cap. The strip wraps, so a long project costs rail HEIGHT rather
   * than truncation — and height is the cheap axis here, where a `+15`
   * that hid most of a project's state was the expensive one. */

  /** Foreign members carry a wire-loose `state` string; anything the review
   * palette does not know reads as not-yet-reviewed. */
  export function reviewState(state: string): StackLog.State {
    return state === "approved" || state === "changes_requested" ? state : "pending";
  }

  /** A project container's state roll-up: one dot per member, in stack
   * order, carrying exactly the medallion vocabulary of the rows it stands
   * for — color = state (yellow needs-review, red needs-revision, green
   * accepted), hollow = nothing to review inside (a plan or a primitive).
   * It is the members' own column of medallions, shrunk and laid on its
   * side, so it needs no vocabulary the rail has not already taught.
   *
   * Shape is deliberately NOT carried across: at this size a square and a
   * circle are the same smudge, and the roll-up's question is "how far have
   * these got", not "what kind are they" — a fixup's square earns its
   * distinction on its own row, not here.
   *
   * The blocked flag rides INSIDE the strip rather than after it, so it
   * wraps with the dots instead of being stranded on a line of its own. */
  function $pips(pips: Pip[], blocked: boolean): HTMLElement {
    const $p = document.createElement("span");
    $p.className = "pips";
    for (const pip of pips) {
      const $s = svgEl("svg", { class: "pip-svg", viewBox: "0 0 12 12" });
      $s.appendChild(
        svgEl("circle", {
          class: pip.hollow ? `node hollow ${pip.state}` : `node ${pip.state}`,
          cx: "6",
          cy: "6",
          // The hollow ring is inset by its own stroke so both kinds occupy
          // the same optical diameter.
          r: pip.hollow ? "3.8" : "4.4",
        }),
      );
      $p.appendChild($s);
    }
    if (blocked) {
      const $flag = document.createElement("span");
      $flag.className = "flag";
      $flag.textContent = "⚠";
      $p.appendChild($flag);
    }
    return $p;
  }

  /** The roll-up in words, for the compact-rail tooltip — where the caption
   * is not on screen at all and the pips cannot be read. */
  const STATE_WORDS: [StackLog.State, string][] = [
    ["approved", "accepted"],
    ["pending", "needs review"],
    ["changes_requested", "needs revision"],
  ];

  function stateTally(pips: Pip[]): string[] {
    return STATE_WORDS.flatMap(([state, word]) => {
      const n = pips.filter((p) => p.state === state).length;
      return n > 0 ? [`${n} ${word}`] : [];
    });
  }

  /** What a project container's medallion says. Every other medallion on
   * this rail reports one commit's review VERDICT; a container reports WHO
   * the project is waiting on, which is a different question and why it
   * earns a color the verdict palette does not have. Four states, mutually
   * exclusive and exhaustive, tested in this order:
   *
   *   yellow — some member awaits review: the reviewer must unblock it.
   *   red    — nothing awaits review, but revisions were requested: the
   *            author's move.
   *   purple — nobody is waiting, and NO CODE IS WRITTEN. Pure planning
   *            mode: the project is docs and nothing else, specced out and
   *            ready for someone to build.
   *   green  — nobody is waiting and the code is written and accepted.
   *
   * Yellow is tested FIRST, ahead of the louder red, on purpose. Yellow has
   * one job on this rail — "a reviewer is the blocker here" — and that only
   * holds if its absence is trustworthy too. Letting a single
   * revisions-requested commit paint the whole container red would hide a
   * reviewer's queue behind an author's, which is the one failure this
   * signal cannot afford.
   *
   * "No code written" is the non-plan member count, so a primitive or a
   * fixup counts as code even though a primitive's pip renders hollow
   * (hollow means "no diff to review FROM HERE", not "not code").
   *
   * Per-member verdicts are otherwise NOT folded in: the pips carry those,
   * one dot per commit. */
  export type ProjectStatus = "changes_requested" | "pending" | "ready" | "approved";

  function projectStatus(pips: Pip[], codeMembers: number): ProjectStatus {
    if (pips.some((p) => p.state === "pending")) return "pending";
    if (pips.some((p) => p.state === "changes_requested")) return "changes_requested";
    return codeMembers === 0 ? "ready" : "approved";
  }

  /** The medallion in words, for the compact-rail tooltip. */
  const STATUS_WORDS: Record<ProjectStatus, string> = {
    pending: "awaiting review",
    changes_requested: "revisions requested",
    ready: "planning — no code yet",
    approved: "complete",
  };

  /** The container row's disclosure caret: the same chevron the accordion
   * and dropdown use, pointing right at rest and rotated 90° by CSS when
   * its row opens. */
  function $chevron(): SVGSVGElement {
    const $s = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    $s.appendChild(
      svgEl("path", { d: "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" }),
    );
    return $s;
  }

  /** The row-height lane canvas; children are `.lane` lines/paths. */
  function $lines(...children: SVGElement[]): SVGSVGElement {
    const $s = svgEl("svg", { class: "lines" });
    $s.append(...children);
    return $s;
  }

  /** Lane canvas for a branch-section row; in fleet mode the trunk passes
   * through behind sections that sit below an earlier host's fork. */
  function $branchLines(passThrough: boolean, ...children: SVGElement[]): SVGSVGElement {
    return passThrough ? $lines(lane(MAIN_X, FULL, false), ...children) : $lines(...children);
  }

  type Span = { from: string; to: string };
  const FULL: Span = { from: "0%", to: "100%" };
  const TOP_HALF: Span = { from: "0%", to: "50%" };
  const BOTTOM_HALF: Span = { from: "50%", to: "100%" };
  /** Around a hollow node: leave the center open so the line never crosses
   * an unfilled shape (filled nodes just paint over a FULL line). */
  const ABOVE_NODE: Span = { from: "0%", to: "35%" };
  const BELOW_NODE: Span = { from: "65%", to: "100%" };

  function lane(x: string, span: Span, dotted: boolean): SVGElement {
    return svgEl("line", {
      class: dotted ? "lane dotted" : "lane",
      x1: x,
      x2: x,
      y1: span.from,
      y2: span.to,
    });
  }

  /** The connector from the host badge back into its branch lane: a rounded
   * corner (CSS borders, so the vertical run stretches with the row) —
   * horizontal out of the badge's left edge, sweeping down into the lane. */
  function $badgeLink(): HTMLElement {
    const $l = document.createElement("div");
    $l.className = "badge-link";
    return $l;
  }

  /** The compact stand-in for the host badge: a short label sitting ON the
   * branch lane. Only painted in compact mode, where the badge and the elbow
   * that pointed at it are both gone and the strip would otherwise give no
   * clue whose branch this is. */
  function $hostChip(label: string, warn: boolean): HTMLElement {
    const $c = document.createElement("div");
    $c.className = warn ? "host-chip warn" : "host-chip";
    $c.textContent = label;
    return $c;
  }

  /** SHORTEST fleet-unique host labels for the collapsed strip: `y` where one
   * letter is already unambiguous, `r1`/`r2`/`r3` for rwc-01/02/03 — for
   * `<alpha>-<digits>` ids it is the DIGITS, not the shared `rwc`, that tell
   * siblings apart. Length is not cosmetic here: the chip is centred on the
   * branch lane (x=23) and the mainline runs at x=9, so anything wider than
   * ~18px touches it.
   *
   * Each id climbs its own ladder only while it still collides, so a unique
   * `y` never grows just because some other host needed two characters. */
  export function hostAbbrevs(ids: string[]): Map<string, string> {
    const ladder = (id: string): string[] => {
      const m = /^([a-z]+)[^a-z0-9]*([0-9]+)$/i.exec(id);
      if (m == null) {
        return [id.slice(0, 1), id.slice(0, 2), id.slice(0, 3), id.slice(0, 4)];
      }
      const alpha = m[1];
      const digits = m[2];
      // "05" reads as "5" until some sibling forces the leading zero back.
      const trimmed = digits.replace(/^0+/, "") || digits;
      return [
        alpha.slice(0, 1),
        alpha.slice(0, 1) + trimmed,
        alpha.slice(0, 1) + digits,
        (alpha.slice(0, 2) + digits).slice(0, 4),
        id.slice(0, 4),
      ];
    };

    const ladders = new Map(ids.map((id) => [id, ladder(id)]));
    const rung = new Map(ids.map((id) => [id, 0]));
    const labelOf = (id: string): string => {
      const steps = ladders.get(id) ?? [id];
      return steps[Math.min(rung.get(id) ?? 0, steps.length - 1)];
    };

    // Bounded by the longest ladder; every pass either advances a colliding
    // id or stops.
    for (let pass = 0; pass < 8; pass++) {
      const seen = new Map<string, number>();
      for (const id of ids) {
        const text = labelOf(id);
        seen.set(text, (seen.get(text) ?? 0) + 1);
      }
      let advanced = false;
      for (const id of ids) {
        const steps = ladders.get(id) ?? [];
        const at = rung.get(id) ?? 0;
        if ((seen.get(labelOf(id)) ?? 0) > 1 && at < steps.length - 1) {
          rung.set(id, at + 1);
          advanced = true;
        }
      }
      if (!advanced) break;
    }
    return new Map(ids.map((id) => [id, labelOf(id)]));
  }

  /** A 12×12 node medallion centered on a lane. Shape vocabulary:
   * circle = change, square = fixup/queued, diamond = public,
   * triangle = planning — hollow, pointing up: no diff inside, and the
   * stack grows upwards from the plan — and hexagon = project: a
   * container, not itself reviewable, so it only ever renders hollow. Its
   * COLOR is not a verdict but a [`ProjectStatus`] — where the project sits
   * in the spec → build → done arc. */
  export type NodeShape = "circle" | "square" | "diamond" | "triangle" | "hexagon";

  export function $node(shape: NodeShape, cls: string, main: boolean): SVGSVGElement {
    const $s = svgEl("svg", {
      class: main ? "node-svg main" : "node-svg",
      viewBox: "0 0 12 12",
    });
    if (shape === "circle") {
      $s.appendChild(svgEl("circle", { class: cls, cx: "6", cy: "6", r: "4.4" }));
    } else if (shape === "square") {
      $s.appendChild(svgEl("rect", { class: cls, x: "2", y: "2", width: "8", height: "8", rx: "1.5" }));
    } else if (shape === "hexagon") {
      $s.appendChild(
        svgEl("path", { class: cls, d: "M6 1 L10.6 3.6 L10.6 8.4 L6 11 L1.4 8.4 L1.4 3.6 Z" }),
      );
    } else if (shape === "triangle") {
      $s.appendChild(
        svgEl("path", {
          class: cls,
          d: "M6 1.6 L10.7 10 L1.3 10 Z",
          "stroke-linejoin": "round",
        }),
      );
    } else {
      $s.appendChild(svgEl("path", { class: cls, d: "M6 1.2 L10.8 6 L6 10.8 L1.2 6 Z" }));
    }
    return $s;
  }

  /** The branch lane merging into the mainline (a smooth bezier; both end
   * tangents vertical so it continues the lanes seamlessly). With
   * `passThrough` the mainline is already live above this row (an earlier
   * branch merged in), so it draws through behind the curve. */
  function $forkCurve(passThrough: boolean): SVGSVGElement {
    const $s = svgEl("svg", {
      class: "lines",
      viewBox: "0 0 36 18",
      preserveAspectRatio: "none",
    });
    if (passThrough) {
      $s.appendChild(svgEl("line", { class: "lane", x1: "9", x2: "9", y1: "0", y2: "18" }));
    }
    $s.appendChild(svgEl("path", { class: "lane", d: "M23 0 C23 11, 9 7, 9 18" }));
    return $s;
  }

  export function build(model: StackLog.Model, ctx: Ctx): HTMLElement[] {
    const { stack, queued } = model;
    const rows: HTMLElement[] = [];
    const hasBranch =
      stack.drafts.length > 0 || queued.length > 0 || stack.unstaged.summary.count > 0;

    if (stack.unstaged.summary.count > 0) {
      rows.push($unstaged(stack.unstaged.summary, "", false, false));
    }
    // Queued sets: commits-to-be, dotted region, bottom = next to drain.
    queued.forEach((set) => rows.push($queued(set, "", false, ctx)));
    rows.push(...$drafts(stack, "", false, ctx));
    if (hasBranch) rows.push($fork(false));
    rows.push(
      ...collapsibleRun(stack.public_page.map((c, i) => $public(c, stack, i === 0, "", ctx))),
    );
    if (stack.public_page.length > 0) rows.push($tail());
    return rows;
  }

  /** The per-project aggregate the review inbox renders from — derivation
   * only, no DOM: [`memberSlugs`] groups the drafts exactly as nodes mode
   * does (fixups inherit their target), [`projectRollup`] prices each
   * group, and `oldest` is the group's oldest member commit — the "how
   * long has this been waiting" the inbox sorts by. Exposed through
   * [`StackLog.projectSummaries`]; kept beside the rollup so the inbox and
   * the container rows can never disagree about a project's state. */
  export function projectSummaries(stack: StackLog.Stack): StackLog.ProjectSummary[] {
    const slugs = memberSlugs(stack);
    const members = memberIndex(slugs);
    return [...members.entries()].map(([slug, idxs]) => {
      const drafts = idxs.map((j) => stack.drafts[j]);
      const node = stack.nodes?.find((n) => n.slug === slug);
      const foreign = node?.foreign_members ?? [];
      const rollup = projectRollup(drafts, foreign);
      const mirrorSources = [
        ...new Set(
          drafts.flatMap((d) => (d.mirrored_from != null ? [d.mirrored_from] : [])),
        ),
      ];
      // A project is a reflection only when every member native to this repo
      // is reflected. That keeps a mixed local/borrowed workstream in the
      // actionable sections while still letting either repo speak for a
      // wholly mirrored cross-repo project.
      const mirroredFrom =
        drafts.length > 0 && drafts.every((d) => d.mirrored_from != null)
          ? mirrorSources.length === 1
            ? mirrorSources[0]
            : `${mirrorSources.length} sources`
          : null;
      return {
        slug,
        held: node?.held ?? false,
        pin: node?.pin ?? null,
        owner: node?.owner ?? null,
        status: rollup.status,
        plans: rollup.plans,
        drafts: rollup.drafts,
        // The grouped members themselves, so a consumer that renders them
        // (the inbox's expanded project rows) does not have to re-derive the
        // slug grouping — `memberSlugs`' fixup inheritance is exactly the
        // kind of rule two copies of would drift apart on.
        members: drafts,
        foreign,
        mirroredFrom,
        blocked: rollup.blocked,
        hasPlan:
          drafts.some(isPlanningDraft) || foreign.some((m) => m.kind === "plan"),
        oldest: Math.min(...drafts.map((d) => d.committed_at)),
        ungrouped: false,
      };
    });
  }

  /** Drafts with no `Project:` trailer, one pseudo-summary each, so the
   * inbox can list them without inventing a container that doesn't exist:
   * `slug` is the draft subject, `ungrouped` marks the different key. */
  export function ungroupedSummaries(stack: StackLog.Stack): StackLog.UngroupedSummary[] {
    const slugs = memberSlugs(stack);
    return stack.drafts.flatMap((d, i) =>
      slugs[i] == null
        ? [
            {
              sha: d.sha,
              subject: d.subject,
              state: d.state,
              committed_at: d.committed_at,
              change_id: d.change_id,
              handle: StackLog.handleOf(d),
              mirrored_from: d.mirrored_from ?? null,
            },
          ]
        : [],
    );
  }

  // Long grayed-out public runs collapse to a "⋯ N commits" row that
  // expands in place on click; a couple of rows stay on each side for
  // context. Runs never span a fork point — buildFleet flushes a segment
  // whenever a branch attaches, so attach commits always stay visible.
  const COLLAPSE_KEEP_FIRST = 2;
  const COLLAPSE_KEEP_LAST = 2;
  const COLLAPSE_MIN_HIDDEN = 3;

  /** Collapse-row → the public rows it hides. The component reads this to
   * resolve keys()/deep links and to auto-expand for a hidden selection. */
  export const COLLAPSED = new WeakMap<HTMLElement, HTMLElement[]>();

  function collapsibleRun(run: HTMLElement[]): HTMLElement[] {
    const hiddenCount = run.length - COLLAPSE_KEEP_FIRST - COLLAPSE_KEEP_LAST;
    if (hiddenCount < COLLAPSE_MIN_HIDDEN) return run;
    const hidden = run.slice(COLLAPSE_KEEP_FIRST, run.length - COLLAPSE_KEEP_LAST);
    return [
      ...run.slice(0, COLLAPSE_KEEP_FIRST),
      $collapsed(hidden),
      ...run.slice(run.length - COLLAPSE_KEEP_LAST),
    ];
  }

  function $collapsed(hidden: HTMLElement[]): HTMLElement {
    const $r = $row(null, "collapse");
    const $c = document.createElement("div");
    $c.className = "content";
    const $label = document.createElement("div");
    $label.className = "label";
    $label.textContent = `⋯ ${hidden.length} commits`;
    $c.appendChild($label);
    $r.append($graphCell($lines(lane(MAIN_X, FULL, true))), $c);
    COLLAPSED.set($r, hidden);
    GESTURE_MANAGER.addPointerEvent($r, {
      onClick: () => $r.replaceWith(...hidden),
    });
    return $r;
  }

  /** Fleet mode: trunk-and-branches. The trunk is the most advanced host's
   * public history; each live host renders as a branch section (head row →
   * unstaged/queued/drafts → fork curve) attached at its own origin/master
   * sha, so a host that hasn't fetched visibly forks lower. Hosts whose
   * origin/master predates the loaded public page land in a detached bucket
   * above the tail; failed hosts render as warn head rows at the bottom. */
  export function buildFleet(model: StackLog.FleetModel, ctx: Ctx): HTMLElement[] {
    type Live = { host: string; stack: StackLog.Stack; queued: StackLog.QueuedSet[] };
    const live: Live[] = [];
    const failed: StackLog.FleetBranch[] = [];
    for (const b of model.branches) {
      if (b.stack != null) live.push({ host: b.host, stack: b.stack, queued: b.queued });
      else failed.push(b);
    }

    // One label pass over the WHOLE fleet (live + unreachable): uniqueness is
    // a property of the set, so it cannot be decided per-section.
    const labels = hostAbbrevs(model.branches.map((b) => b.host));
    const labelFor = (host: string): string => labels.get(host) ?? host.slice(0, 3);

    const rows: HTMLElement[] = [];
    if (live.length > 0) {
      const trunk = pickTrunk(live);
      const trunkShas = trunk.stack.public_page.map((p) => p.sha);

      // Group branches by where they attach to the trunk (0 = the tip).
      const groups = new Map<number, Live[]>();
      const detached: Live[] = [];
      for (const l of live) {
        const idx = trunkShas.indexOf(l.stack.remote_master.sha);
        if (idx === -1) {
          detached.push(l);
        } else {
          const group = groups.get(idx);
          if (group) group.push(l);
          else groups.set(idx, [l]);
        }
      }
      for (const group of groups.values()) localFirst(group);
      localFirst(detached);

      // Walk the trunk top → bottom, emitting each branch section just above
      // its fork point. Once the first fork lands, the mainline is live and
      // passes through behind every later branch section. Trunk rows gather
      // into contiguous segments (flushed at every fork point) so long
      // grayed-out stretches collapse without ever hiding an attach commit.
      let trunkLive = false;
      let segment: HTMLElement[] = [];
      const flushSegment = () => {
        rows.push(...collapsibleRun(segment));
        segment = [];
      };
      trunkShas.forEach((_, j) => {
        const group = groups.get(j);
        if (group != null && group.length > 0) {
          flushSegment();
          for (const l of group) {
            rows.push(...branchSection(l, j, trunkLive, labelFor(l.host), ctx));
            trunkLive = true;
          }
        }
        segment.push(
          $public(trunk.stack.public_page[j], trunk.stack, j === 0, `${trunk.host}/`, ctx),
        );
      });
      flushSegment();
      for (const l of detached) {
        // No trunk at all (every public page empty): nothing to be behind.
        rows.push(
          ...branchSection(l, trunkShas.length === 0 ? 0 : -1, trunkLive, labelFor(l.host), ctx),
        );
        trunkLive = true;
      }
      if (trunkShas.length > 0) rows.push($tail());
    }
    for (const b of failed) {
      rows.push(
        $hostHead(
          b.host,
          { text: `⚠ ${b.error ?? "unreachable"}`, warn: true },
          false,
          false,
          labelFor(b.host),
        ),
      );
    }
    return rows;
  }

  /** The branch whose public page contains every other live host's
   * origin/master — the most advanced view of the shared remote. Falls back
   * to freshest fetch, then newest public tip, when containment is ambiguous
   * (divergent histories shouldn't occur — all hosts track one origin). */
  function pickTrunk<L extends { stack: StackLog.Stack }>(live: L[]): L {
    const contained = live.filter((c) => {
      const shas = new Set(c.stack.public_page.map((p) => p.sha));
      return live.every((o) => o === c || shas.has(o.stack.remote_master.sha));
    });
    const pool = contained.length > 0 ? contained : live;
    return pool.reduce((best, c) => {
      if (c.stack.remote_master.fetched_at !== best.stack.remote_master.fetched_at) {
        return c.stack.remote_master.fetched_at > best.stack.remote_master.fetched_at ? c : best;
      }
      const ct = c.stack.public_page[0]?.committed_at ?? 0;
      const bt = best.stack.public_page[0]?.committed_at ?? 0;
      return ct > bt ? c : best;
    });
  }

  /** Within a fork group, the local host reads first; others keep registry
   * order (sort is stable). */
  function localFirst<L extends { host: string }>(group: L[]): void {
    group.sort((a, b) => Number(b.host === "local") - Number(a.host === "local"));
  }

  /** One host's branch: head row → unstaged → queued → drafts → fork curve.
   * `forkIdx` is how many trunk commits sit above the attach point (-1 =
   * detached: origin/master predates the loaded public page). */
  function branchSection(
    l: { host: string; stack: StackLog.Stack; queued: StackLog.QueuedSet[] },
    forkIdx: number,
    passThrough: boolean,
    label: string,
    ctx: Ctx,
  ): HTMLElement[] {
    const { host, stack, queued } = l;
    const prefix = `${host}/`;
    const rows: HTMLElement[] = [];
    rows.push($hostHead(host, hostHeadSub(stack, queued.length), true, passThrough, label));
    if (stack.unstaged.summary.count > 0) {
      rows.push($unstaged(stack.unstaged.summary, prefix, passThrough, true));
    }
    queued.forEach((set) => rows.push($queued(set, prefix, passThrough, ctx)));
    rows.push(...$drafts(stack, prefix, passThrough, ctx));
    // The commit this master is rooted at (the host's own origin/master).
    // Attached branches skip it — their attach commit renders in the trunk
    // right at the fork; a detached branch's root isn't in the loaded trunk,
    // so it renders here at the branch base.
    if (forkIdx === -1 && stack.public_page.length > 0) {
      rows.push($branchRoot(stack.public_page[0], prefix, passThrough, ctx));
    }
    rows.push($fork(passThrough));
    return rows;
  }

  function hostHeadSub(stack: StackLog.Stack, queuedCount: number): { text: string; warn: boolean } {
    const counts: string[] = [];
    if (stack.drafts.length > 0) counts.push(`${stack.drafts.length} drafts`);
    if (queuedCount > 0) counts.push(`${queuedCount} queued`);
    if (stack.unstaged.summary.count > 0) counts.push(`${stack.unstaged.summary.count} unstaged`);
    return { text: counts.length > 0 ? counts.join(" · ") : "empty", warn: false };
  }

  /** The remote-master commit a detached branch is rooted at — grayed like
   * public history, on the branch lane, selectable like any public row. */
  function $branchRoot(
    c: StackLog.PublicCommit,
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
  ): HTMLElement {
    const $r = $row(`${keyPrefix}public:${c.sha}`, "seg-public");
    $r.append(
      $graphCell(
        $branchLines(passThrough, lane(BRANCH_X, FULL, false)),
        $node("diamond", "node", false),
      ),
      $content(c.subject || "(no subject)", ctx.nodes ? [] : ["remote-master"], {
        text: [
          $handleLink(
            c.d_global ?? c.sha.slice(0, 9),
            ctx.hrefOf?.(`${keyPrefix}public:${c.sha}`) ?? null,
          ),
        ],
        warn: false,
      }),
    );
    return $r;
  }

  function $row(key: Option<string>, ...classes: string[]): HTMLElement {
    const $r = document.createElement("div");
    $r.className = ["row", ...classes].join(" ");
    if (key != null) $r.dataset.key = key;
    return $r;
  }

  /** Plain text, as a node — the connective tissue between the links in a
   * sub line. */
  function t(text: string): Node {
    return document.createTextNode(text);
  }

  /** A handle rendered as what it is: an address. `href` is the app's own
   * route for that row, so the browser does the navigating — a plain click
   * lands on it (the URL change re-enters the same resolve a Back button
   * takes), and cmd/middle-click opens it in a tab, which no pointer handler
   * has ever given us. A null href degrades to plain text, which is what a
   * handle whose row is not addressable from here gets.
   *
   * Callers pass the DISPLAY form (`L-142`); the href carries the URL form.
   * The two spellings are one name — see `change-name.ts`. */
  export function $handleLink(
    text: string,
    href: Option<string>,
    /** Size relative to the line the handle sits in, when it should recede
     * from it — the inbox caption is the one case, where the id shares a
     * fragment line with prose. Expressed as a MULTIPLIER, not a token: the
     * typography scale's raw values are em-square sizes that only come out
     * right after the cap-height division, so a token here would land far
     * smaller than intended. Applied inline for the same reason `font` is —
     * see below. */
    scale: Option<number> = null,
  ): HTMLElement {
    if (href == null) {
      const $s = document.createElement("span");
      $s.textContent = text;
      if (scale != null) $s.style.fontSize = `${scale}em`;
      return $s;
    }
    const $a = document.createElement("a");
    $a.className = "handle";
    $a.href = href;
    $a.textContent = text;
    // INLINE, not in the sheet: this element is appended into shadow roots
    // this module does not own, and the shared typography rule retypesets a
    // bare `<a>` as a paragraph (see [`HANDLE_STYLE`]). A root that forgets
    // to register the sheet would then render its ids ~46% oversized and
    // look merely a bit wrong — which is exactly how this shipped twice.
    // Inline, the size is right whatever the root does; the rest of the
    // styling stays in the sheet, where forgetting it produces an obviously
    // unstyled blue link rather than a subtly wrong one.
    $a.style.font = "inherit";
    // After the shorthand, so it wins: `em` resolves against the PARENT's
    // computed size, which is what "a bit smaller than this line" means.
    if (scale != null) $a.style.fontSize = `${scale}em`;
    return $a;
  }

  export const HANDLE_CSS = HANDLE_STYLE;

  function $graphCell(...parts: Element[]): HTMLElement {
    const $g = document.createElement("div");
    $g.className = "graph";
    $g.append(...parts);
    return $g;
  }

  // No per-row state glyph: the state-colored node medallion on the lane is
  // the single state signal.
  /** `sub.text` may be a string or a ready-made run of nodes — the sub line
   * is where a row names commits (its own handle, a blocker, a fixup
   * target), and those are links, so it cannot be textContent alone. */
  function $content(
    subject: string,
    chips: string[],
    sub: Option<{ text: string | Node[]; warn: boolean }>,
  ): HTMLElement {
    const $c = document.createElement("div");
    $c.className = "content";
    const $s = document.createElement("div");
    $s.className = "subject";
    const $t = document.createElement("span");
    $t.className = "text";
    $t.textContent = subject;
    $s.appendChild($t);
    for (const chip of chips) {
      const $chip = document.createElement("span");
      $chip.className = "chip";
      $chip.textContent = chip;
      $s.appendChild($chip);
    }
    $c.appendChild($s);
    if (sub != null) {
      const $sub = document.createElement("div");
      $sub.className = sub.warn ? "sub text warn" : "sub text";
      if (typeof sub.text === "string") $sub.textContent = sub.text;
      else $sub.append(...sub.text);
      $c.appendChild($sub);
    }
    return $c;
  }

  /** `@ unstaged` — the working copy: hollow dashed circle, dotted tail.
   * Solo mode leaves the lane open above it (it is the top of the branch);
   * a fleet branch section connects it up to its host head. */
  function $unstaged(
    summary: { count: number; adds: number; dels: number },
    keyPrefix: string,
    passThrough: boolean,
    connectUp: boolean,
  ): HTMLElement {
    const $r = $row(keyPrefix + StackLog.UNSTAGED_KEY);
    const lanes = connectUp
      ? [lane(BRANCH_X, ABOVE_NODE, true), lane(BRANCH_X, BELOW_NODE, true)]
      : [lane(BRANCH_X, BELOW_NODE, true)];
    $r.append(
      $graphCell(
        $branchLines(passThrough, ...lanes),
        $node("circle", "node hollow dashed", false),
      ),
      $content("unstaged", [], {
        text: `${summary.count} file${summary.count === 1 ? "" : "s"} · +${summary.adds} −${summary.dels}`,
        warn: false,
      }),
    );
    return $r;
  }

  /** A queued `.commits/` set — a commit-to-be: hollow square on the dotted
   * pre-commit connector. */
  function $queued(
    set: StackLog.QueuedSet,
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
  ): HTMLElement {
    const $r = $row(keyPrefix + StackLog.queueKey(set.id));
    const files = set.paths.length;
    // A declared plan set reuses the planning triangle — one glyph for "this
    // is a plan", queued or landed; the dotted connector already says queued.
    const isPlan = set.kind === "plan";
    const chips = ctx.nodes ? [] : isPlan ? ["queued", "plan"] : ["queued"];
    $r.append(
      $graphCell(
        $branchLines(passThrough, lane(BRANCH_X, ABOVE_NODE, true), lane(BRANCH_X, BELOW_NODE, true)),
        $node(isPlan ? "triangle" : "square", `node hollow ${set.review_status}`, false),
      ),
      $content(
        StackLog.messageSubject(set.message),
        chips,
        {
          text: `${set.id} · ${isPlan ? "plan · " : ""}${files} file${files === 1 ? "" : "s"}`,
          warn: false,
        },
      ),
    );
    return $r;
  }

  /** Planning = an empty commit whose message is the plan. Old services
   * omit the kind — an empty non-fixup IS a planning commit by definition,
   * so the client-side derivation is correct for them too. */
  export function isPlanningDraft(d: StackLog.Draft): boolean {
    return d.kind === "planning" || (d.kind === "change" && d.files.length === 0);
  }

  /** The draft region. Flat mode: one row per draft — exactly the
   * pre-nodes renderer. Nodes mode: drafts are grouped by their `Project:`
   * slug — each project renders one container row at its topmost member's
   * position with the members below it in stack order (a rare
   * cross-project interleave pulls later members up under that row; the
   * `⤴` sub glyph is what explains the reorder), and a closed container
   * absorbs its members entirely. A fixup without its own trailer inherits
   * the draft directly below it (autosquash order — that IS its target),
   * so a fixup never strands outside its target's project. */
  function $drafts(
    stack: StackLog.Stack,
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
  ): HTMLElement[] {
    const boundaryIdx = stack.drafts.findIndex((d) => d.sha === stack.approved_boundary);
    const $one = (d: StackLog.Draft, i: number): HTMLElement =>
      $draft(d, stack, i, boundaryIdx, keyPrefix, passThrough, ctx);
    if (!ctx.nodes) return stack.drafts.map($one);

    const slugs = memberSlugs(stack);
    const members = memberIndex(slugs);
    // Master projects (`Member:` trailers on a plan). Decided BEFORE the walk
    // because the container rows need their ordinals as they are built, and
    // empty for every stack that declares none — which is what keeps the
    // grouped rendering a no-op on existing stacks.
    const masters = masterGroups(stack, members);

    // Members keep HONEST STACK ORDER — a project is not gathered under its
    // container, because moving commits would misreport the order they sink
    // and publish in. A container opens at its topmost member and the rest
    // stay where the stack put them, so an interleaved project reads as
    // several runs; the dashed boundary is then drawn per run (below), which
    // is the continuation stitch the design calls for.
    const $member = stack.drafts.map((d, i) => $one(d, i));
    const rows: HTMLElement[] = [];
    const owner: Option<string>[] = [];
    const $foreignFor = new Map<string, HTMLElement[]>();
    const opened = new Set<string>();
    const push = ($row: HTMLElement, slug: Option<string>): void => {
      rows.push($row);
      owner.push(slug);
    };
    stack.drafts.forEach((d, i) => {
      const slug = slugs[i];
      if (slug == null) {
        push($member[i], null);
        return;
      }
      const idxs = members.get(slug) ?? [i];
      if (!opened.has(slug)) {
        opened.add(slug);
        // Cross-repo foreign members ride the same project (server-derived,
        // keyed by slug). Absent on services that don't derive them yet —
        // nothing extra renders then.
        const projectNode = stack.nodes?.find((n) => n.slug === slug);
        const foreign = projectNode?.foreign_members ?? [];
        const $foreign = foreign.map((m) => $foreignRow(m, keyPrefix, passThrough, ctx));
        $foreignFor.set(slug, $foreign);
        push(
          $projectRow(
            slug,
            projectNode?.held ?? false,
            projectNode?.pin ?? null,
            idxs.map((j) => stack.drafts[j]),
            foreign,
            idxs.map((j) => $member[j]),
            $foreign,
            keyPrefix,
            passThrough,
            ctx,
            masters,
          ),
          slug,
        );
      }
      push($member[i], slug);
      // Foreign members have no place in this repo's stack order, so they
      // close out the project's span — after its LAST native member.
      if (idxs[idxs.length - 1] === i) {
        for (const $f of $foreignFor.get(slug) ?? []) push($f, slug);
      }
    });

    // Reading order for master groups, applied to the finished rows.
    const grouped = regroupUnderMasters(rows, owner, masters);

    // Mark each contiguous run of a project's rows. The boundary is painted
    // by row edges rather than a wrapper element so the rail stays one flat
    // list of siblings — keys(), deep links and the lane geometry all index
    // against that.
    for (let i = 0; i < grouped.rows.length; ) {
      const slug = grouped.owner[i];
      if (slug == null) {
        i++;
        continue;
      }
      let end = i;
      while (end + 1 < grouped.rows.length && grouped.owner[end + 1] === slug) end++;
      for (let k = i; k <= end; k++) grouped.rows[k].classList.add("in-block");
      grouped.rows[i].classList.add("block-start");
      grouped.rows[end].classList.add("block-end");
      i = end + 1;
    }
    return grouped.rows;
  }

  /** The master-project relation as THIS stack can render it (master projects:
   * a project whose plan carries ordered `Member: <slug>` trailers, which are
   * the single source of truth for membership and whose order is the reading
   * order).
   *
   * Only masters that have rows here gather anything: a member whose master
   * lives entirely in another repo has nothing to nest under, so it keeps its
   * own top-level row — and no ordinal, which would otherwise number a group
   * the reader cannot see. The ordinal is the member's position in the
   * DECLARED roll, not among the ones present, so the numbering matches the
   * plan even when a member is drafted elsewhere.
   *
   * `present` is the slug → draft-index map the rail already grouped by, so
   * this asks exactly one question of the payload: which slugs did a plan
   * name, in what order. */
  type MasterGroups = {
    /** master slug → the member slugs nested under it here, in declared order. */
    groups: Map<string, string[]>;
    /** member slug → the master it is nested under. */
    nested: Map<string, string>;
    /** member slug → its 1-based position in its master's declared roll. */
    ordinal: Map<string, number>;
  };

  function masterGroups(
    stack: StackLog.Stack,
    present: Map<string, number[]>,
  ): MasterGroups {
    const groups = new Map<string, string[]>();
    const nested = new Map<string, string>();
    const ordinal = new Map<string, number>();
    // Every master with rows here, first — the second pass needs to know
    // whether a member is itself a master before deciding to swallow it.
    const declared = new Map<string, StackLog.MasterMember[]>();
    for (const node of stack.nodes ?? []) {
      const roll = node.members ?? [];
      if (roll.length > 0 && present.has(node.slug)) declared.set(node.slug, roll);
    }
    for (const [master, roll] of declared) {
      const here: string[] = [];
      roll.forEach((m, i) => {
        // `missing` members and members drafted in another repo have no rows
        // to move, and a slug already claimed keeps its first master (the
        // server resolves that too — this is the client-side belt).
        //
        // ONE LEVEL: a member that is itself a master keeps its own top-level
        // row rather than nesting. The rail has one indent, and refusing the
        // second level is also what makes a pair of plans naming each other
        // harmless — a cycle here would strand both groups' rows.
        if (
          m.slug === master ||
          !present.has(m.slug) ||
          nested.has(m.slug) ||
          declared.has(m.slug)
        ) {
          return;
        }
        nested.set(m.slug, master);
        ordinal.set(m.slug, i + 1);
        here.push(m.slug);
      });
      if (here.length > 0) groups.set(master, here);
    }
    return { groups, nested, ordinal };
  }

  /** Reading order for master groups: each master's rows, then its member
   * projects' rows in the master's DECLARED order. This is the one place the
   * rail deliberately abandons stack order, and it is the point of the
   * abstraction — a master plan's roll IS a reading order, so rendering its
   * members chronologically would be rendering something else.
   *
   * Everything outside a group is untouched, positionally: an ungrouped
   * commit, and every project no plan names, stays exactly where the stack
   * put it. With no master groups at all the input arrays come straight back,
   * so a stack with no `Member:` trailer renders the pre-feature rail. */
  function regroupUnderMasters(
    rows: HTMLElement[],
    owner: Option<string>[],
    masters: MasterGroups,
  ): { rows: HTMLElement[]; owner: Option<string>[] } {
    if (masters.groups.size === 0) return { rows, owner };
    const indices = new Map<string, number[]>();
    owner.forEach((slug, i) => {
      if (slug == null) return;
      const list = indices.get(slug);
      if (list) list.push(i);
      else indices.set(slug, [i]);
    });
    const outRows: HTMLElement[] = [];
    const outOwner: Option<string>[] = [];
    const emitted = new Set<string>();
    const emit = (slug: string): void => {
      if (emitted.has(slug)) return;
      emitted.add(slug);
      for (const j of indices.get(slug) ?? []) {
        outRows.push(rows[j]);
        outOwner.push(owner[j]);
      }
    };
    owner.forEach((slug, i) => {
      if (slug == null || (!masters.groups.has(slug) && !masters.nested.has(slug))) {
        outRows.push(rows[i]);
        outOwner.push(slug);
        return;
      }
      // A member rides its master's block; a master gathers its own rows once
      // (at its topmost) and then each member project in declared order.
      if (masters.nested.has(slug) || emitted.has(slug)) return;
      emit(slug);
      for (const member of masters.groups.get(slug) ?? []) emit(member);
    });
    return { rows: outRows, owner: outOwner };
  }

  /** A project's aggregate read, shared by the nodes-mode container row and
   * the projects-mode directory row so the two never drift.
   *
   * Counts aggregate native + foreign: plans = native plans + foreign
   * `kind === "plan"`; the drafts total mirrors the native `count − plans`
   * semantics (every non-plan member, fixups included) and extends it with
   * the non-plan foreign members. They render nowhere in the caption — the
   * pips carry both numbers already (one dot per member, hollow = plan) —
   * but the compact-rail tooltip has no pips, so it still spells them out.
   *
   * Pips list members in the order the rail lists them when a container
   * opens — natives in stack order, then the foreign ones that close out
   * the span — so a pip and its row read the same direction. `blocked` is
   * the one thing the palette cannot say (not a verdict, a reason the
   * project cannot move). `status` is the medallion's own color: `others`
   * is already the non-plan member count — the "is any code written" test —
   * so purple falls out of the same arithmetic. */
  function projectRollup(
    drafts: StackLog.Draft[],
    foreign: StackLog.ForeignMember[],
  ): {
    counts: string[];
    plans: number;
    drafts: number;
    pips: Pip[];
    blocked: boolean;
    status: ProjectStatus;
  } {
    const nativePlans = drafts.filter(isPlanningDraft).length;
    const foreignPlans = foreign.filter((m) => m.kind === "plan").length;
    const plans = nativePlans + foreignPlans;
    const others = drafts.length - nativePlans + (foreign.length - foreignPlans);
    const counts: string[] = [];
    if (plans > 0) counts.push(`${plans} plan${plans === 1 ? "" : "s"}`);
    if (others > 0) counts.push(`${others} draft${others === 1 ? "" : "s"}`);
    const pips: Pip[] = [
      ...drafts.map((d) => ({ state: d.state, hollow: isPlanningDraft(d) })),
      ...foreign.map((m) => ({
        state: reviewState(m.state),
        hollow: m.kind === "plan" || m.kind === "primitive",
      })),
    ];
    const blocked = drafts.some((d) => d.blocked_by.length > 0);
    // Both shapes of the same arithmetic: `counts` for the container row's
    // spelled-out caption, the bare numbers for the inbox's count columns.
    return { counts, plans, drafts: others, pips, blocked, status: projectStatus(pips, others) };
  }

  /** Per-draft project slug, resolved bottom-up so a fixup can inherit
   * from the target below it (autosquash order — that IS its target). */
  function memberSlugs(stack: StackLog.Stack): Option<string>[] {
    const slugs: Option<string>[] = new Array(stack.drafts.length).fill(null);
    for (let i = stack.drafts.length - 1; i >= 0; i--) {
      const d = stack.drafts[i];
      const own = d.project != null && d.project !== "" ? d.project : null;
      slugs[i] = own ?? (d.kind === "fixup" ? (slugs[i + 1] ?? null) : null);
    }
    return slugs;
  }

  /** slug → draft indices, in stack order. */
  function memberIndex(slugs: Option<string>[]): Map<string, number[]> {
    const members = new Map<string, number[]>();
    slugs.forEach((slug, i) => {
      if (slug == null) return;
      const list = members.get(slug);
      if (list) list.push(i);
      else members.set(slug, [i]);
    });
    return members;
  }

  /** A project container row — pure grouping, the only non-commit thing on
   * screen. Same list-cell anatomy as every row: hollow hexagon (the shape
   * reserved for containers — a project is not itself reviewable) colored by
   * its [`ProjectStatus`], caret + slug subject, and the roll-up ([`$pips`] —
   * one dot per member) as the whole of its sub, where a commit row carries
   * its sha and author. The affordance is SPLIT: the caret is the
   * collapse control, and clicking anywhere else selects the project (the row
   * carries a `project:<slug>` key like every other selectable row, so keys(),
   * deep links and setSelected all resolve it). Open state lives in `ctx.open`
   * so it survives rebinds, and PROJECT_OPEN lets the component auto-open for a
   * selection hidden inside. */
  function $projectRow(
    slug: string,
    held: boolean,
    pin: Option<StackLog.ProjectPin>,
    drafts: StackLog.Draft[],
    foreign: StackLog.ForeignMember[],
    $members: HTMLElement[],
    $foreign: HTMLElement[],
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
    masters: MasterGroups,
  ): HTMLElement {
    const $r = $row(keyPrefix + StackLog.projectKey(slug), "project");
    // Master-project decoration, recorded as data rather than classes for the
    // same reason `mirrored` is: it describes what the row IS, and nothing in
    // the stylesheet keys off it yet. A member reads `2. sdk(1)-substrate` —
    // the ordinal is its position in the master plan's roll, which is the
    // order the group is being read in.
    const ordinal = masters.ordinal.get(slug) ?? null;
    const under = masters.nested.get(slug) ?? null;
    if (masters.groups.has(slug)) $r.dataset.master = "1";
    if (under != null) $r.dataset.memberOf = under;
    $r.classList.toggle("held", held);
    $r.classList.toggle("pinned", pin != null);
    $r.dataset.projectRow = slug;
    // Whether this container is a REFLECTION — every native member borrowed
    // from another host — by the same rule `projectSummaries` uses. The data
    // attribute gates the row menu's workflow verbs (borrowed work is not
    // this operator's to park or ask for); the `mirror` class joins the
    // members' own opacity rule, so a wholly borrowed project reads as
    // borrowed at the container, not only row by row inside it.
    const mirrorSources = [
      ...new Set(drafts.flatMap((d) => (d.mirrored_from != null ? [d.mirrored_from] : []))),
    ];
    const mirroredFrom =
      drafts.length > 0 && drafts.every((d) => d.mirrored_from != null)
        ? mirrorSources.length === 1
          ? mirrorSources[0]
          : `${mirrorSources.length} sources`
        : null;
    if (mirroredFrom != null) {
      $r.dataset.mirrored = "1";
      $r.classList.add("mirror");
    }
    // Both member kinds carry the owning slug: expandFor() reads it to open a
    // closed container when a deep link or a kept selection lands on a row
    // absorbed inside it — which now includes the foreign rows.
    for (const $m of $members) $m.dataset.project = slug;
    for (const $f of $foreign) $f.dataset.project = slug;

    const { counts, pips, blocked, status } = projectRollup(drafts, foreign);

    const $c = document.createElement("div");
    $c.className = "content";
    const $s = document.createElement("div");
    $s.className = "subject";
    const $t = document.createElement("span");
    $t.className = "text";
    $t.textContent = ordinal == null ? slug : `${ordinal}. ${slug}`;
    $s.append($t);
    if (held) {
      const $held = document.createElement("span");
      $held.className = "hold-mark";
      $held.textContent = "hold";
      $s.append($held);
    }
    // Both marks can show at once, and that is not a contradiction worth
    // suppressing: an operator parked this, and somebody has since asked for
    // it back. The rail's job is to report both, not to arbitrate.
    if (pin != null) {
      const $pin = document.createElement("span");
      $pin.className = "hold-mark";
      $pin.textContent = "pin";
      if (pin.reason != null && pin.reason !== "") $pin.title = pin.reason;
      $s.append($pin);
    }
    // The caret is the cell's trailing accessory, a sibling of the content —
    // not a child of the subject. No typography class either: it is an svg,
    // so it needs no cap-height trim, and `.subject .text` stays unambiguous
    // for the tooltip's title lookup.
    const $accessory = document.createElement("span");
    $accessory.className = "accessory";
    $accessory.appendChild($chevron());
    const $sub = document.createElement("div");
    $sub.className = "sub text";
    // The caption IS the roll-up. The counts it replaced said the same thing
    // in more words — the strip's length is the member count and its hollow
    // dots are the plans — so keeping both would have been one line of the
    // rail spent restating itself.
    $sub.appendChild($pips(pips, blocked));
    // Whose project this is, in the member rows' own ⇄ register: the dimmed
    // container needs its explanation on the rail no less than a dimmed
    // draft does.
    if (mirroredFrom != null) {
      const $mf = document.createElement("span");
      $mf.textContent = ` · ⇄ ${mirroredFrom}`;
      $sub.appendChild($mf);
    }
    // The compact rail hides the caption entirely and the tooltip carries it
    // as text — where a row of svg dots contributes nothing, and neither
    // does the medallion's colour. Spell both out for that path, status
    // first: it is the headline the hexagon is making.
    $r.dataset.tipSub = [
      STATUS_WORDS[status],
      ...counts,
      ...stateTally(pips),
      ...(blocked ? ["⚠ blocked"] : []),
      ...(held ? ["on hold"] : []),
      ...(pin != null ? [pin.reason != null && pin.reason !== "" ? `pinned — ${pin.reason}` : "pinned"] : []),
      ...(mirroredFrom != null ? [`⇄ ${mirroredFrom}`] : []),
    ].join(" · ");
    $c.append($s, $sub);

    // Hollow medallion ⇒ the lane leaves the center open, like every other
    // hollow shape; medallion and lane stay solid in both states. Hollow is
    // still what says CONTAINER — the colour now says how far along it is.
    $r.append(
      $graphCell(
        $branchLines(
          passThrough,
          lane(BRANCH_X, ABOVE_NODE, false),
          lane(BRANCH_X, BELOW_NODE, false),
        ),
        $node("hexagon", `node hollow ${status}`, false),
      ),
      $c,
      $accessory,
    );

    // `open-block` gates the dashed boundary: it rides every row of the
    // container so the run-edge rules only paint while it is open, and
    // vanishes with the members on close (which is what removes the outline).
    const setOpen = (open: boolean): void => {
      if (open) ctx.open.add(slug);
      else ctx.open.delete(slug);
      // The caret's rotation rides the `opened` class in CSS — nothing to
      // set here, and it transitions instead of snapping between glyphs.
      $r.classList.toggle("opened", open);
      $r.classList.toggle("open-block", open);
      for (const $m of $members) {
        $m.classList.toggle("absorbed", !open);
        $m.classList.toggle("open-block", open);
      }
      for (const $f of $foreign) {
        $f.classList.toggle("absorbed", !open);
        $f.classList.toggle("open-block", open);
      }
    };
    setOpen(ctx.open.has(slug));
    PROJECT_OPEN.set($r, setOpen);
    // No per-row pointer handler: the component's root delegation owns both
    // halves of the split affordance (caret → PROJECT_OPEN, rest → onSelect).
    return $r;
  }

  /** A cross-repo foreign project member — a commit living in ANOTHER repo's
   * draft stack, grouped under this project by the server. Same list-cell
   * anatomy as every row: medallion shape = kind (triangle plan / hollow
   * diamond primitive / circle draft), color = state (the shared state
   * classes). The graph cell rides the DOTTED branch lane (the
   * continuation-stitch register — dotted = elsewhere), and the sub is the
   * `<repo> · <handle>` locator — the repo, because that is the one thing
   * about a foreign member the rail cannot show any other way. Only the `L-`
   * half ever appears: a member is a draft in another repo's stack, and the
   * local name does not travel off the host that drafted it, so a member
   * drafted elsewhere falls back to its sha7.
   *
   * It is a SELECTABLE row like any other: it carries a
   * [`StackLog.foreignKey`] data-key, so keys(), deep links, setSelected and
   * the root click delegation all treat it exactly as a native row — the
   * owner opens it in the pane IN PLACE, leaving the rail on its own repo
   * tab. (This supersedes the earlier "navigation link, no data-key" shape,
   * which forced a whole-stack repo switch just to read one commit.) */
  function $foreignRow(
    m: StackLog.ForeignMember,
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
  ): HTMLElement {
    const $r = $row(keyPrefix + StackLog.foreignKey(m.repo, m.sha), "foreign");
    // Plans and primitives are hollow (no diff to review inside from here);
    // an ordinary draft is a solid circle. Color is the shared state palette.
    const hollow = m.kind === "plan" || m.kind === "primitive";
    const shape: NodeShape =
      m.kind === "plan" ? "triangle" : m.kind === "primitive" ? "diamond" : "circle";
    const nodeCls = hollow ? `node hollow ${m.state}` : `node ${m.state}`;
    const lanes = hollow
      ? [lane(BRANCH_X, ABOVE_NODE, true), lane(BRANCH_X, BELOW_NODE, true)]
      : [lane(BRANCH_X, FULL, true)];
    $r.append(
      $graphCell($branchLines(passThrough, ...lanes), $node(shape, nodeCls, false)),
      $content(m.subject || "(no subject)", [], {
        text: [
          t(`${m.repo} · `),
          $handleLink(
            StackLog.handleOf(m) ?? m.sha.slice(0, 7),
            ctx.hrefOf?.(keyPrefix + StackLog.foreignKey(m.repo, m.sha)) ?? null,
          ),
        ],
        warn: false,
      }),
    );
    return $r;
  }

  function $draft(
    d: StackLog.Draft,
    stack: StackLog.Stack,
    index: number,
    boundaryIdx: number,
    keyPrefix: string,
    passThrough: boolean,
    ctx: Ctx,
  ): HTMLElement {
    const approvedSeg = boundaryIdx !== -1 && index >= boundaryIdx;
    // Two independent row classes, both additive: the approved band is about
    // where this commit sits in the stack, `mirror` is about whose stack it
    // came from. Neither replaces the state medallion.
    const rowClasses: string[] = [];
    if (approvedSeg) rowClasses.push("seg-approved");
    if (d.mirrored_from != null) rowClasses.push("mirror");
    const $r = $row(keyPrefix + StackLog.draftKey(d.sha), ...rowClasses);
    const isFixup = d.kind === "fixup";
    const planning = isPlanningDraft(d);
    // Nodes mode is chip-free by ruling: shape = kind, color = state, and
    // per-commit detail (master/approved/landed) lives in the pane.
    const chips: string[] = [];
    if (!ctx.nodes) {
      if (planning) chips.push("plan");
      if (d.sha === stack.master) chips.push("master");
      if (d.sha === stack.approved_boundary) chips.push("approved");
      // Provenance: this commit's review record (drained queue set or minted
      // .landed/ record) — only worth a chip when the commit is untagged.
      if (d.change_id === "" && d.landed_set != null) chips.push("landed");
    }
    // The rail's identity token is the handle — `L-142`, or `D-1234` once the
    // change lands. The sha stands in only for an untagged commit, which never
    // gets a handle.
    const ident = StackLog.handleOf(d) ?? d.sha.slice(0, 9);
    const hrefOfCid = (cid: string): Option<string> => {
      const target = stack.drafts.find((x) => x.change_id === cid);
      return target == null
        ? null
        : (ctx.hrefOf?.(keyPrefix + StackLog.draftKey(target.sha)) ?? null);
    };
    // A cid this row points AT, drawn as the handle that names it and linked
    // to the row it names — the blocker and the fixup target are the two
    // places the rail talks about a commit other than itself, and they were
    // the two places you could not get to from.
    const $cid = (cid: string): Node =>
      $handleLink(StackLog.handleOfCid(stack, cid), hrefOfCid(cid));
    let warn = false;
    let parts: Node[] = [
      $handleLink(ident, ctx.hrefOf?.(keyPrefix + StackLog.draftKey(d.sha)) ?? null),
    ];
    if (isFixup) {
      parts = [
        t("absorbs ⌄ into "),
        d.absorb_into == null ? t("?") : $cid(d.absorb_into),
      ];
    } else if (d.blocked_by.length > 0) {
      // A plan row is already marked as one by its chip and its node shape;
      // restating that in the sub line said nothing the reader acts on, so
      // planning draws the same identity line as any other draft.
      parts = [t("⚠ blocked by ")];
      d.blocked_by.forEach((cid, i) => {
        if (i > 0) parts.push(t(", "));
        parts.push($cid(cid));
      });
      warn = true;
    }
    // Cross-project dependence (nodes mode): a bare `⤴ <slug>` appended to
    // the sub line — an icon in the fixup-sub register, not a chip. It is
    // what explains a rare out-of-order interleave between projects.
    if (ctx.nodes) {
      const deps = (d.cross_project_deps ?? []).map((dep) => `⤴ ${dep.slug}`);
      if (deps.length > 0) parts.push(t(` · ${deps.join(" · ")}`));
    }
    // Whose draft this is. The dimming says "not yours"; the sub says whose —
    // without it, a greyed row in the middle of the stack has no explanation
    // on the rail at all. Same sub-line register as the `⤴` dep glyph (a mark,
    // not a chip), so it holds in nodes mode's chip-free rows too.
    if (d.mirrored_from != null) {
      parts.push(t(` · ⇄ ${d.mirrored_from}`));
    }
    const sub = { text: parts, warn };
    // Hollow shapes never have the lane drawn through them; the planning
    // triangle sits in a solid-lane gap (it is real history, unlike the
    // dotted pre-commit region).
    const lanes = planning
      ? [lane(BRANCH_X, ABOVE_NODE, false), lane(BRANCH_X, BELOW_NODE, false)]
      : [lane(BRANCH_X, FULL, false)];
    const shape = isFixup ? "square" : planning ? "triangle" : "circle";
    const nodeCls = planning ? `node hollow ${d.state}` : `node ${d.state}`;
    $r.append(
      $graphCell($branchLines(passThrough, ...lanes), $node(shape, nodeCls, false)),
      $content(d.subject || "(no subject)", chips, sub),
    );
    return $r;
  }

  /** The branch lane joins the mainline at origin/master. */
  function $fork(passThrough: boolean): HTMLElement {
    const $r = $row(null, "fork");
    $r.appendChild($graphCell($forkCurve(passThrough)));
    return $r;
  }

  /** Fleet mode: a host's branch section opens with its head row — the host
   * name + status caption as a badge over the start of its branch lane.
   * Failed hosts reuse it laneless as warn rows. */
  function $hostHead(
    host: string,
    sub: { text: string; warn: boolean },
    hasLane: boolean,
    passThrough: boolean,
    label: string,
  ): HTMLElement {
    const $r = $row(null, "host-head");
    const parts: Element[] = [$branchLines(passThrough)];
    if (hasLane) parts.push($badgeLink());
    parts.push($hostChip(label, sub.warn));
    const $c = document.createElement("div");
    $c.className = "content";
    const $badge = document.createElement("div");
    $badge.className = "host-badge";
    const $name = document.createElement("div");
    $name.className = "host-name text";
    $name.textContent = host;
    const $sub = document.createElement("div");
    $sub.className = sub.warn ? "sub text warn" : "sub text";
    $sub.textContent = sub.text;
    $badge.append($name, $sub);
    $c.appendChild($badge);
    $r.append($graphCell(...parts), $c);
    return $r;
  }

  function $public(
    c: StackLog.PublicCommit,
    stack: StackLog.Stack,
    first: boolean,
    keyPrefix: string,
    ctx: Ctx,
  ): HTMLElement {
    const $r = $row(`${keyPrefix}public:${c.sha}`, "seg-public");
    const chips: string[] = [];
    if (first && !ctx.nodes) {
      chips.push("remote-master");
      // Empty accepted prefix: `approved` decorates the fork-point commit
      // together with remote-master — standard multi-ref rendering.
      if (stack.approved_boundary === stack.remote_master.sha) chips.push("approved");
    }
    if (c.planning === true && !ctx.nodes) chips.push("plan");
    if (
      !ctx.nodes &&
      ((c.note != null && c.note !== "") || (c.landed_set != null && c.landed_set.note !== ""))
    ) {
      chips.push("note");
    }
    $r.append(
      $graphCell($lines(lane(MAIN_X, FULL, false)), $node("diamond", "node", true)),
      $content(c.subject || "(no subject)", chips, {
        text: [
          $handleLink(
            c.d_global ?? c.sha.slice(0, 9),
            ctx.hrefOf?.(`${keyPrefix}public:${c.sha}`) ?? null,
          ),
        ],
        warn: false,
      }),
    );
    return $r;
  }

  /** The dotted tail below the public page — older history, not loaded. */
  function $tail(): HTMLElement {
    const $r = $row(null, "tail");
    const $c = document.createElement("div");
    $c.className = "content";
    const $t = document.createElement("span");
    $t.className = "text";
    $t.textContent = "older history";
    $c.appendChild($t);
    $r.append($graphCell($lines(lane(MAIN_X, TOP_HALF, true))), $c);
    return $r;
  }
}

// The viewmodel: mirrors the commit-review service's stack + queue wire
// shapes (structural typing lets pages bind wire objects directly).
export namespace StackLog {
  export type State = "pending" | "approved" | "changes_requested";
  /** Rail render mode: `flat` = one row per commit (the default),
   * `nodes` = drafts grouped under project container rows, chip-free
   * (commit-review-v2). */
  export type Mode = "flat" | "nodes";
  /** `planning` = an empty commit whose message is the plan. Optional on
   * the wire — fleet hosts on older services only emit change/fixup, and
   * the rail re-derives planning from an empty file list. */
  export type DraftKind = "change" | "fixup" | "planning";

  export type FileStat = { path: string; adds: number; dels: number; binary: boolean };

  /** One page of a multi-page plan: `page` is the wire id — the file's path
   * relative to the `<slug>.project.docs/` root with `/` encoded as `__`, so
   * it occupies a single URL segment (`content/design.md` →
   * `content__design.md`). */
  export type PlanPage = { page: string; adds: number; dels: number };

  export type Draft = {
    sha: string;
    change_id: string;
    kind: DraftKind;
    subject: string;
    /** The `Project:` trailer, parsed service-side. Optional here because the
     * committed service predates it — a build older than the field serves
     * drafts without one, and a project-scoped view then matches nothing
     * rather than mis-scoping. */
    project?: Option<string>;
    author: string;
    committed_at: number;
    state: State;
    /** Resolved teaching note (record note, else the commit-message body),
     * PUBLIC prose only — the service lifts the agent section out.
     * Absent on older services — fall back to `landed_set.note`. */
    note?: Option<string>;
    /** The note's ```review-agent section: the agent's own bookkeeping,
     * never required reading. Absent on older services. */
    agent_note?: Option<string>;
    /** This host's local name for the change — `L-142`. Absent for an
     * untagged commit (no cid to key a handle on) and on services that
     * predate the ledger. */
    d_handle?: Option<string>;
    /** The global name once the change has landed — `D-1234`, its
     * first-parent position on `origin/master`. Absent while it is a
     * draft: the number IS the landed position, so it does not exist yet. */
    d_global?: Option<string>;
    /** `Mirrored-From:` trailer — the host this draft was replayed from
     * (`<user>@<host>`), stamped by the mirroring `git am` on the COPY only.
     * Present ⇒ the row is a reflection of another machine's work in
     * progress: the rail dims it and the pane withholds the verdict
     * controls. Absent on every locally authored draft, and on services
     * that predate the trailer. */
    mirrored_from?: Option<string>;
    /** `depends_on` edges whose target cid carries a *different*
     * `Project:` trailer — rendered in nodes mode as a bare `⤴ <slug>`
     * on the sub line (commit-review-v2, architecture.md). Absent on
     * services that don't derive it yet. */
    cross_project_deps?: Option<{ cid: string; slug: string }[]>;
    /** A `Kind: plan` draft's pages — the `<slug>.project.docs/` files its
     * commit touches, with per-page line deltas (commit-review.node
     * `PageMeta`). Empty for every other draft; absent on services that
     * don't derive them. */
    pages?: Option<PlanPage[]>;
    files: FileStat[];
    absorb_into?: Option<string>;
    blocked_by: string[];
    landed_set?: Option<{ id: string; agent: string; note: string; agent_note?: Option<string> }>;
  };

  export type PublicCommit = {
    /** The global name — `D-<n>`, this commit's first-parent position on
     * `origin/master`. Present for every commit on the spine, derived from
     * shared history rather than any host's ledger. */
    d_global?: Option<string>;
    sha: string;
    subject: string;
    author: string;
    committed_at: number;
    /** `Change-Id` trailer; absent on older services. */
    change_id?: Option<string>;
    /** `Project:` trailer, when declared. */
    project?: Option<string>;
    /** An empty commit — a plan that landed. */
    planning?: Option<boolean>;
    /** Resolved teaching note (record, else the commit body) — survives
     * the push. PUBLIC prose only; the agent section is split out.
     * Absent on older services: fall back to `landed_set.note`. */
    note?: Option<string>;
    /** The note's ```review-agent section. Absent on older services. */
    agent_note?: Option<string>;
    /** The `.commit` record still associated with this pushed commit (same
     * sha match as drafts) — carries the teaching note + artifacts. */
    landed_set?: Option<{ id: string; agent: string; note: string; agent_note?: Option<string> }>;
  };

  export type UnstagedFile = { path: string; status: string; adds: number; dels: number };

  /** A note record that failed to associate with any commit — Change-Id is
   * the only live match key, and this is the loud-failure half of that
   * contract. `committed_sha` is the debug attribute (which commit the
   * record thought it described). */
  export type OrphanedRecord = {
    id: string;
    agent: string;
    change_id: string;
    committed_sha: string;
    reason: string;
  };

  /** A cross-repo member of a project — a commit living in ANOTHER repo's
   * draft stack that the server grouped under this project (by shared slug).
   * Reviewable in place: the rail renders it as a selectable row keyed by
   * [`foreignKey`], and the owner binds the pane against `repo`/`sha`
   * without moving its own repo tab. `sha` is a full sha (displayed as sha7);
   * `change_id` MAY be "" (an untagged member is reviewed sha-keyed instead).
   * `kind`/`state` are wire-loose plain strings (the S8 payload shape). Note
   * that no NOTE rides this payload — the teaching note lives in the owning
   * repo's own stack read. */
  export type ForeignMember = {
    /** This host's local name for the member — `L-<n>`. Absent when the
     * member was drafted on another machine; the `L-` half never travels. */
    d_handle?: Option<string>;
    repo: string;
    change_id: string;
    sha: string;
    subject: string;
    /** The foreign commit's teaching note (body minus subject/trailers,
     * agent-fence already split off), so the pane can render a cross-repo
     * commit's message in place. Optional on the wire — absent on services
     * predating the note-carrying scan, which is why the pane guards it. */
    note?: Option<string>;
    /** The note's split-out review-agent fence. Same optionality as `note`. */
    agent_note?: Option<string>;
    kind: string;
    state: string;
  };

  /** A project grouping derived per request from `Project:` trailers
   * (commit-review.node `stack.rs`). `member_cids`/`plan_cids` are the native
   * drafts; `foreign_members` are cross-repo members the server resolved into
   * the same project. All fields past `slug` are optional on the wire — absent
   * on services that don't derive them. The rail groups natively regardless
   * and reads `nodes` only for the foreign members. */
  /** A plan that has already LANDED on `origin/master`. The pane only ever
   * sees drafts, so without this a project whose plan shipped looks
   * plan-less — the violation was created by publishing. */
  export type PublishedPlan = {
    repo: string;
    change_id: string;
    sha: string;
    subject: string;
    note: string;
    agent_note?: Option<string>;
    /** This host's local name, when it drafted the plan. */
    d_handle?: Option<string>;
    /** The plan's global name — `D-<n>`. Always present for a landed plan. */
    d_global?: Option<string>;
  };

  /** A standing request to review a project FIRST — the hold's dual, and the
   * one piece of review state agents author about their own work. Present
   * only while the project is pinned: a pin is a record (who asked, why,
   * when), not a bit, so there is no unpinned one to serve. */
  export type ProjectPin = {
    slug: string;
    /** What reviewing this unblocks, one line. May be absent — a pin placed
     * from the UI, where the operator is already looking at the project. */
    reason?: Option<string>;
    /** The identity that asked. */
    by?: Option<string>;
    /** Epoch seconds the pin was FIRST placed — the pinned queue's order,
     * which a re-pin deliberately does not reset. */
    pinned_at: number;
  };

  export type ActorRef = {
    kind: string;
    id: string;
    provider: string;
    session_ref?: Option<string>;
    label: string;
    host: string;
  };

  export type ProjectOwner = {
    slug: string;
    actor: ActorRef;
    assigned_by: ActorRef;
    claimed_at: number;
    heartbeat_at: number;
    takeover_of?: Option<ActorRef>;
  };

  /** One entry of a MASTER PROJECT's roll — a project named by an ordered
   * `Member: <slug>` trailer on the master's plan. The entry's POSITION is
   * its ordinal: trailer order is reading order, which is the whole point of
   * the abstraction. `missing` marks a slug no stack carries — the declared
   * intent still renders, dimmed, rather than vanishing. */
  export type MasterMember = {
    slug: string;
    /** Absent on services that don't derive it — treat as false. */
    missing?: Option<boolean>;
  };

  export type ProjectNode = {
    slug: string;
    held?: Option<boolean>;
    /** Absent on services predating pins, and on every unpinned project. */
    pin?: Option<ProjectPin>;
    /** Explicit project accountability; absent means unowned. */
    owner?: Option<ProjectOwner>;
    plan_cids?: Option<string[]>;
    member_cids?: Option<string[]>;
    foreign_members?: Option<ForeignMember[]>;
    /** Set when the project's plan is on public history rather than in the
     * draft window. Absent on services that don't resolve it. */
    plan_published?: Option<PublishedPlan>;
    /** This project's MEMBER PROJECTS in declared order — non-empty only for
     * a MASTER PROJECT (its plan carries `Member:` trailers). The server has
     * already resolved conflicting claims, so this list renders as-is.
     * Absent/empty on every ordinary project and on older services, which is
     * what keeps the grouped rendering a no-op for them. */
    members?: Option<MasterMember[]>;
    /** The master project that lists this one, or absent for a top-level
     * project. Derived server-side (first master in stack order wins). */
    master?: Option<string>;
  };

  export type Stack = {
    /** The registry key this stack was read for (`/api/repos`). */
    repo: string;
    remote_master: { sha: string; fetched_at: number };
    approved_boundary: string;
    master: string;
    drafts: Draft[];
    unstaged: { files: UnstagedFile[]; summary: { count: number; adds: number; dels: number } };
    public_page: PublicCommit[];
    /** Absent on older nodes — treat as empty. */
    orphaned_records?: Option<OrphanedRecord[]>;
    /** Project groupings (slug → members) derived from `Project:` trailers;
     * carries the cross-repo `foreign_members`. Absent on older services —
     * the rail derives its own client-side grouping regardless and reads
     * `nodes` only for the foreign members. */
    nodes?: Option<ProjectNode[]>;
    /** Non-fatal derivation complaints, one line each — currently only
     * master-project membership conflicts. Absent on older services. */
    warnings?: Option<string[]>;
  };

  /** One queued `.commits/` set (the queue workflow's commit-to-be),
   * pre-filtered to this stack's repo and ordered top → bottom with the
   * next-to-drain set at the bottom (adjacent to the tip). */
  export type QueuedSet = {
    id: string;
    seq: number;
    agent: string;
    message: string;
    repo: string;
    paths: string[];
    /** The set's declared project (commit.toml `project`), when any. */
    project?: Option<string>;
    /** Change-Id minted at queue time (commit.toml `change_id`), when any —
     * keys the set's prose-comment threads so the review conversation
     * survives the set's retirement (`.reviews/<cid>/doc-comments.json`). */
    change_id?: Option<string>;
    /** `"plan"` = a review/plan-only set (the docs ARE the change): renders
     * with the planning triangle; the drainer writes a `Kind: plan` trailer
     * so the landed commit keeps the marker. Absent ⇒ ordinary change. */
    kind?: Option<string>;
    /** The set note's ```review-agent section, split out by the service.
     * `commit.toml` keeps the note whole, so the drain still writes the
     * fence into the commit message. Absent on older services. */
    agent_note?: Option<string>;
    review_status: State;
  };

  export type Model = { stack: Stack; queued: QueuedSet[] };

  /** Row selection key: `unstaged`, `queue:<id>`, `draft:<sha>`,
   * `public:<sha>`, `project:<slug>` (nodes mode's container row), or
   * `foreign:<repo>:<sha>` (a cross-repo project member). Fleet mode prefixes
   * every one of them with `<host>/` ([`fleetKey`]). Each shape has a
   * distinct, non-overlapping prefix, so every parser can tell them apart by
   * `startsWith` alone. */
  export type Key = string;
  export const UNSTAGED_KEY = "unstaged";

  const FOREIGN_PREFIX = "foreign:";

  /** The one rule for which of a change's two names to show: the global one
   * if it has landed, else this host's local one, else nothing. Written once
   * because every surface has to answer it the same way — a row that reads
   * `D-6120` in the rail and `L-142` in the inbox is two changes to a reader
   * who has only the screen to go on. Null (not a sha) is the miss, so each
   * caller picks its own fallback: the rail and the inbox fall back to a
   * sha9, a cross-reference to a shortened cid. */
  export function handleOf(
    c: { d_global?: Option<string>; d_handle?: Option<string> },
  ): Option<string> {
    return c.d_global ?? c.d_handle ?? null;
  }

  /** The display name for a change named by Change-Id somewhere in `stack` —
   * its handle once the ledger has numbered it, else a shortened cid. Used
   * wherever one commit REFERS to another (blocked-by, fixup targets): a
   * reader can hold `L-148` in their head, and `Idb4fc87906488e5e` is a
   * 16-hex needle they then have to hunt for in the rail. */
  export function handleOfCid(stack: Option<Stack>, cid: string): string {
    const d = stack?.drafts.find((x) => x.change_id === cid);
    return (d == null ? null : handleOf(d)) ?? cid.slice(0, 9);
  }

  export function draftKey(sha: string): Key {
    return `draft:${sha}`;
  }

  export function queueKey(id: string): Key {
    return `queue:${id}`;
  }

  /** A project container row's key. Deliberately NOT commit-shaped: a project
   * is pure grouping, so every key parser must be able to tell it apart from
   * a `draft:`/`public:` sha — selecting one opens the project pane, never a
   * diff. */
  export function projectKey(slug: string): Key {
    return `project:${slug}`;
  }

  /** A cross-repo project member's key. It has to carry its OWN repo, because
   * the whole point is that the pane can open it while the rail stays on a
   * different tab — a bare `draft:<sha>` would be read against the rail's
   * repo and silently resolve to nothing (or, worse, to another repo's
   * commit). The `foreign:` prefix is deliberately distinct from every other
   * key shape, so no parser can mistake one for a native commit row: a
   * `draft:`/`public:` key means "this repo", a `foreign:` key never does.
   * Registry repo keys are `[a-z0-9-]`-shaped (no `:` and no `/`), so the
   * first `:` after the prefix splits repo from sha unambiguously and the
   * fleet `<host>/` prefix still splits on its own first `/`. */
  export function foreignKey(repo: string, sha: string): Key {
    return `${FOREIGN_PREFIX}${repo}:${sha}`;
  }

  /** Inverse of [`foreignKey`] — null for any other key shape. Takes an INNER
   * key (fleet callers strip the host prefix with [`splitFleetKey`] first). */
  export function parseForeignKey(key: Key): Option<{ repo: string; sha: string }> {
    if (!key.startsWith(FOREIGN_PREFIX)) return null;
    const rest = key.slice(FOREIGN_PREFIX.length);
    const idx = rest.indexOf(":");
    if (idx <= 0) return null;
    const sha = rest.slice(idx + 1);
    return sha === "" ? null : { repo: rest.slice(0, idx), sha };
  }

  /** First line of a queue set's message — the reviewable title. Queue
   * messages grew commit-shaped bodies (subject + teaching note) but the
   * record keeps them as one `message` field, so every title surface must
   * split rather than render the wall of text. */
  export function messageSubject(message: string): string {
    const line = message.split("\n", 1)[0].trim();
    return line !== "" ? line : "(no message)";
  }

  /** Everything after the subject line — the teaching-note body, if any. */
  export function messageBody(message: string): string {
    const nl = message.indexOf("\n");
    return nl < 0 ? "" : message.slice(nl + 1).trim();
  }

  // ── fleet mode ────────────────────────────────────────────────────────────

  /** One host's contribution to the fleet tree. `stack == null` marks a
   * failed fetch — rendered as a warn head row carrying `error`. */
  export type FleetBranch = {
    host: string;
    stack: Option<Stack>;
    queued: QueuedSet[];
    error: Option<string>;
  };

  export type FleetModel = { branches: FleetBranch[] };

  /** Fleet rows carry host-prefixed keys so selection can route back to the
   * owning host. `/` is safe: host ids are `[a-z0-9-]` and inner keys never
   * contain it. */
  export function fleetKey(host: string, key: Key): Key {
    return `${host}/${key}`;
  }

  export function splitFleetKey(key: Key): Option<{ host: string; inner: Key }> {
    const idx = key.indexOf("/");
    if (idx === -1) return null;
    return { host: key.slice(0, idx), inner: key.slice(idx + 1) };
  }

  /** The rail's 12×12 node medallion factory, shared with sibling
   * components (the project minitree, the review inbox) so shape
   * vocabulary stays single-sourced: circle = change, square =
   * fixup/queued, diamond = public, triangle = planning. */
  export const $node = Rows.$node;
  export type NodeShape = Rows.NodeShape;

  /** A handle as a link, and the styling it needs — shared with the sibling
   * components for the same reason as the medallion: an id must look and
   * behave the same wherever it is drawn. */
  export const $handleLink = Rows.$handleLink;
  export const HANDLE_CSS = Rows.HANDLE_CSS;

  /** Where a project sits in the spec → build → done arc — the container
   * hexagon's color, and the review inbox's grouping key. */
  export type ProjectStatus = Rows.ProjectStatus;

  /** One project's aggregate, as the review inbox consumes it. `plans` and
   * `drafts` are the member counts as NUMBERS — the inbox is a table, and it
   * spells them out (or doesn't) per column; `oldest` is the oldest member's
   * commit time — the waiting age. */
  export type ProjectSummary = {
    slug: string;
    held: boolean;
    /** The standing review request on this project, or null. */
    pin: Option<ProjectPin>;
    /** The explicit accountable agent, distinct from assignment/presence. */
    owner: Option<ProjectOwner>;
    status: ProjectStatus;
    plans: number;
    drafts: number;
    /** The project's own drafts, in stack order. */
    members: Draft[];
    /** The cross-repo members the server resolved into the same project. */
    foreign: ForeignMember[];
    /** Source host when every native member is a mirrored reflection. */
    mirroredFrom: Option<string>;
    blocked: boolean;
    hasPlan: boolean;
    oldest: number;
    ungrouped: boolean;
  };

  /** A draft with no `Project:` trailer — listed by the inbox as itself
   * rather than absorbed into an invented container. */
  export type UngroupedSummary = {
    sha: string;
    subject: string;
    state: State;
    committed_at: number;
    /** MAY be "" — a draft with no `Change-Id` cannot be looked up in the
     * watcher registry, whose records are cid-keyed. */
    change_id: string;
    /** The draft's handle, by [`handleOf`]; null for an untagged commit,
     * which has no cid to hang one on. */
    handle: Option<string>;
    /** Source host for a mirrored loose commit; null for native work. */
    mirrored_from: Option<string>;
  };

  /** Derivations shared with the rail's own grouping (same slug
   * resolution, same rollup) — the inbox and the container rows cannot
   * disagree about a project's state. */
  export const projectSummaries = Rows.projectSummaries;
  export const ungroupedSummaries = Rows.ungroupedSummaries;

  /** The two member predicates the inbox's expanded child rows need, shared
   * rather than re-derived: `isPlanningDraft` decides triangle-vs-circle for
   * a native member (an old service omits `kind`, so it is a derivation, not
   * a field read), and `reviewState` folds a foreign member's wire-loose
   * state string into the review palette. A second copy of either is a
   * second answer to "what shape is this commit". */
  export const isPlanningDraft = Rows.isPlanningDraft;
  export const reviewState = Rows.reviewState;
}
