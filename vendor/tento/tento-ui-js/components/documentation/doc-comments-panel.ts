import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";

// A VALUE import, not `import type`: it is what registers `std-section-head`,
// and a type-only import would leave `makeWith` handing back an inert element.
import { SectionHead } from "../section-head";
import { CommentCard } from "./comment-card";
import { DocComments } from "./doc-comments";

// ── Panel ────────────────────────────────────────────────────────────────────

/** Vertical gap kept between two collision-resolved cards (px). */
const CARD_GAP = 14;
/** Gap between the last positioned card and the tail block (px). */
const TAIL_GAP = 20;
/** Fraction of the window width above which the panel is judged "stacked under
 *  the doc" — the grid has collapsed the gutter to a full-width column. */
const COLLAPSE_RATIO = 0.7;
/** A real side gutter is a narrow fixed rail (320px in both known layouts).
 *  Wider than this the panel cannot be y-aligning cards beside a doc column —
 *  it is a stacked strip, whatever its window ratio (an iframe-framed host can
 *  put a 545px strip in a 900px logical viewport, under the ratio test). */
const MAX_GUTTER_WIDTH = 420;

@component({ name: "std-doc-comments-panel" })
export class DocCommentsPanel extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  /** External relayout hook. The controller sets this so a gutter size change
   *  (the doc reflowed and moved its blocks) recomputes the anchor ys — only
   *  the controller can read those off the live PM view — and re-binds. Wired
   *  before the panel connects, so the base ResizeObserver arms `onSizeChange`
   *  on connect. */
  onRelayout: Option<EmptyFunction> = null;

  /** Set by the owner: the panel went empty / non-empty. The panel only knows
   *  the count; where the "how to comment" affordance lives is the owner's
   *  call, because that instruction describes a gesture performed on the DOC,
   *  not on the panel. Fires on every bind, which is when the panel already
   *  re-renders whole — no new invalidation path. */
  onEmptyChange: Option<(empty: boolean) => void> = null;

  private lastSize: Option<Size> = null;

  /** The gutter's height tracks the doc (grid `align-self: stretch`), so a doc
   *  reflow surfaces here as a size change. Ignore sub-pixel ResizeObserver
   *  noise, else ask the controller to recompute the ys and re-bind. */
  onSizeChange: Option<(s: Size) => void> = (s: Size) => {
    const prev = this.lastSize;
    if (
      prev &&
      Math.abs(prev.width - s.width) < 1 &&
      Math.abs(prev.height - s.height) < 1
    ) {
      return;
    }
    this.lastSize = s;
    this.onRelayout?.();
  };

  bind(vm: DocCommentsPanel.ViewModel): void {
    this.render(vm);
  }

  onRecycle(): void {
    super.onRecycle();
    this.onRelayout = null;
    this.onEmptyChange = null;
    this.lastSize = null;
  }

  /** Full panel redraw. The panel holds a handful of cards and every mutation
   *  re-binds, so a clear-and-rebuild keeps the render trivially correct — no
   *  per-node diffing. Two modes: side-by-side (each open card absolutely
   *  positioned, y-aligned with its anchor via {@link renderAnchored}) and
   *  collapsed (a flat stacked list — {@link renderStacked}). Offline / empty
   *  states always flow. Below the cards: two quiet collapsible tails
   *  (unanchored / resolved), each hidden at N=0. */
  private render(vm: DocCommentsPanel.ViewModel): void {
    const $root = this.$root;
    while ($root.firstChild) $root.removeChild($root.firstChild);

    // A commit-wide thread is about the whole change, so it has no anchor and
    // therefore no position — and position is the only thing this panel can
    // express. It belongs to the discussion region. Dropped here, before the
    // count and before sectioning, so it can reach neither a card nor a tail
    // nor the header's count.
    const items = vm.items.filter((i) => i.anchored.comment.commitWide !== true);

    // The header renders in EVERY branch, before any of them can return. This
    // panel occupies RESERVED space — the note grid gives it its column whether
    // or not there is anything to put in it — and reserved space that renders
    // nothing is not an empty region, it is a hole, indistinguishable from a
    // failed render. (A region in FLOW, like std-discussion, may self-hide:
    // empty flow is vertical noise rather than information. The two are not
    // inconsistent; they sit in different kinds of space.)
    $root.appendChild(this.$head(items.length));

    if (vm.offline) {
      $root.className = "stacked";
      $root.appendChild(
        this.$note(
          "Comments API offline — select-and-copy still works; new comments are disabled.",
        ),
      );
      return;
    }

    // The owner still decides where the how-to-comment INSTRUCTION lives, and
    // that part has not changed: it describes a gesture performed on the prose,
    // so it belongs at the prose. What this hook must never again mean is that
    // the panel renders nothing — the instruction and the column's identity are
    // two different things, and the first revision of this deleted both.
    this.onEmptyChange?.(items.length === 0);

    if (items.length === 0) {
      $root.className = "stacked";
      // A statement of fact about the column, not a second copy of the
      // instruction: "nothing is contested in this note" is exactly the
      // information an empty reserved region owes its reader.
      $root.appendChild(this.$note("No comments on this note yet."));
      return;
    }

    // Sectioning by derived thread state (thread-rail design). Open = an
    // unresolved thread the owner still owes / the reviewer is watching;
    // Addressed = a resolution request is in (`addressedIn`) but not yet
    // resolved; Resolved sorts last, faded. A structured (diff-line / passage)
    // anchor is intentionally anchor-less — it belongs in Open, NOT the "no
    // longer anchors" (⚠) tail, which is for prose comments whose range was
    // genuinely lost.
    const stateOf = (i: DocCommentsPanel.Item) =>
      DocComments.threadState(i.anchored.comment);
    const anchorless = (i: DocCommentsPanel.Item) =>
      i.anchored.comment.anchor != null;
    const open = items.filter(
      (i) => stateOf(i) === "open" && (i.anchored.range != null || anchorless(i)),
    );
    const unanchored = items.filter(
      (i) => stateOf(i) === "open" && i.anchored.range == null && !anchorless(i),
    );
    const addressed = items.filter((i) => stateOf(i) === "addressed");
    const resolved = items.filter((i) => stateOf(i) === "resolved");

    // One `now` per render measures every relative time (root + replies).
    const now = Date.now();

    // Anchored mode is meaningless without a live controller. It positions the
    // open cards absolutely and leans on the controller's `onRelayout` — fired
    // by the connect-time ResizeObserver once a real width is known — to read
    // the anchor ys off the live PM view and re-bind. With no `onRelayout`
    // wired (a storybook card, or any render with no live view) that relayout
    // never comes: `offsetWidth` is 0 at bind so the width test picks anchored,
    // and the absolute cards then collapse to zero height inside the
    // `height:100%` root. Force the in-flow stacked column, which sizes to its
    // content and renders correctly on its own. When a controller IS wired this
    // reduces to the plain `isCollapsed()` width test — the live path is
    // unchanged.
    if (this.onRelayout == null || this.isCollapsed()) {
      this.renderStacked(open, unanchored, addressed, resolved, vm, now);
    } else {
      this.renderAnchored(open, unanchored, addressed, resolved, vm, now);
    }
  }

  /** Collapsed = the page grid stacked the gutter under the doc (narrow
   *  viewport): the panel then spans most of the window. Cheap width-ratio read
   *  — in the desktop grid the gutter is a fixed 320px (<40% of a ≥1024px
   *  window); once stacked it fills the column (~100%). A 0 width (not yet laid
   *  out) reads as not-collapsed; the connect-time ResizeObserver re-renders
   *  with the real width. */
  private isCollapsed(): boolean {
    const w = this.offsetWidth;
    return (
      w > 0 && (w >= window.innerWidth * COLLAPSE_RATIO || w > MAX_GUTTER_WIDTH)
    );
  }

  /** Side-by-side mode: each open card is absolutely positioned, its top
   *  y-aligned with its anchor, overlaps resolved by {@link layoutCards}. The
   *  tail flows below the last card. The in-doc highlight beside a card carries
   *  its context, so anchored cards omit the quote row. */
  private renderAnchored(
    open: DocCommentsPanel.Item[],
    unanchored: DocCommentsPanel.Item[],
    addressed: DocCommentsPanel.Item[],
    resolved: DocCommentsPanel.Item[],
    vm: DocCommentsPanel.ViewModel,
    now: number,
  ): void {
    const $root = this.$root;
    $root.className = "anchored";
    const placed: Array<{ $card: HTMLElement; y: number }> = [];
    for (const item of open) {
      // A missing y (no live view yet) degrades to y=0 — the collision pass
      // then simply stacks such cards from the top.
      const y = item.y ?? 0;
      const $card = this.$card(item.anchored, vm, now, {
        showQuote: false,
        faded: false,
      });
      $card.classList.add("positioned");
      // Seed the pre-collision top at the requested anchor y so cards paint
      // near their block for the frame before the measure/write pass lands.
      $card.style.top = `${y}px`;
      // Stash the requested anchor y so a later relayout (e.g. a reply composer
      // opening/closing) can reconstruct the placed set straight from the DOM.
      $card.dataset.anchorY = `${y}`;
      $root.appendChild($card);
      placed.push({ $card, y });
    }
    const $tail = this.$tail(unanchored, addressed, resolved, vm, now);
    if ($tail) {
      $tail.classList.add("tail-abs");
      $root.appendChild($tail);
    }
    this.layoutCards(placed, $tail);
  }

  /** Collapsed mode: the open cards flow in a stacked list (the doc sits above,
   *  so the in-doc highlight is out of view — the cards keep their quote row for
   *  context). The tail flows after them. */
  private renderStacked(
    open: DocCommentsPanel.Item[],
    unanchored: DocCommentsPanel.Item[],
    addressed: DocCommentsPanel.Item[],
    resolved: DocCommentsPanel.Item[],
    vm: DocCommentsPanel.ViewModel,
    now: number,
  ): void {
    const $root = this.$root;
    $root.className = "stacked";
    if (open.length > 0) {
      const $list = document.createElement("div");
      $list.className = "stacked-list";
      for (const item of open) {
        $list.appendChild(
          this.$card(item.anchored, vm, now, {
            showQuote: true,
            faded: false,
          }),
        );
      }
      $root.appendChild($list);
    }
    const $tail = this.$tail(unanchored, addressed, resolved, vm, now);
    if ($tail) $root.appendChild($tail);
  }

  /** Two-pass collision layout for the absolutely-positioned open cards, so
   *  y-aligned cards never overlap: sort by requested anchor y, then place each
   *  at `max(anchorY, prevBottom + CARD_GAP)`. One fastdom READ pass measures
   *  every card's height; one WRITE pass assigns every `top` (and the tail's) —
   *  no per-card read↔write thrash. */
  private layoutCards(
    placed: Array<{ $card: HTMLElement; y: number }>,
    $tail: Option<HTMLElement>,
  ): void {
    if (placed.length === 0) {
      if ($tail) {
        const $t = $tail;
        $$.measure(() => {
          const headBottom = this.headHeight();
          $$.mutate(() => {
            $t.style.top = `${headBottom}px`;
          });
        });
      }
      return;
    }
    const ordered = [...placed].sort((a, b) => a.y - b.y);
    $$.measure(() => {
      const headBottom = this.headHeight();
      const heights = ordered.map((c) => c.$card.offsetHeight);
      const tops: number[] = [];
      // Seeded so the first iteration's floor is exactly the header's bottom: a
      // card whose anchor resolves above it clamps there instead of painting
      // under the header, which is out of flow at the panel top. Later
      // iterations are unchanged — they were already dominated by the previous
      // card's bottom.
      let bottom = headBottom - CARD_GAP;
      for (let i = 0; i < ordered.length; i++) {
        const top = Math.max(ordered[i].y, bottom + CARD_GAP);
        tops.push(top);
        bottom = top + heights[i];
      }
      const tailTop = bottom + TAIL_GAP;
      $$.mutate(() => {
        for (let i = 0; i < ordered.length; i++) {
          ordered[i].$card.style.top = `${tops[i]}px`;
        }
        if ($tail) $tail.style.top = `${tailTop}px`;
      });
    });
  }

  /** The floor every absolutely-positioned card sits above, in anchored mode:
   *  the header's height, because the header is out of flow at `top: 0`.
   *
   *  Measured rather than declared as a constant. A card's `y` arrives from the
   *  controller as `anchorTop − panel.getBoundingClientRect().top` — measured
   *  against the PANEL, not against whatever the panel contains — so a header in
   *  normal flow would not push the cards down, it would paint underneath the
   *  first one. Out of flow plus this floor is what actually moves them. A
   *  hard-coded height would drift the moment the title wraps or the count pill
   *  grows, and the failure is silent: every comment simply attaches to the
   *  paragraph after the one it is about.
   *
   *  That is not hypothetical here. Adopting the shared header moved this floor
   *  from 22px to 18px — the louder register is the SHORTER box, because the
   *  typography ramp trims leading that the old literal `font-size: 11px` kept —
   *  so every card rose 4px. Measuring is what absorbed that silently.
   *
   *  Must be called inside a fastdom READ pass — it touches `offsetHeight`. */
  private headHeight(): number {
    return this.$root.querySelector<HTMLElement>("std-section-head")?.offsetHeight ?? 0;
  }

  /** Re-run the collision layout against the live DOM. Reconstructs the placed
   *  set from the currently-positioned cards (each carries its requested anchor
   *  y in `data-anchor-y`), so a card that just changed height — an inline reply
   *  composer opening or closing — pushes its siblings down / lets them snap
   *  back. Absolute children don't resize the panel, so the ResizeObserver never
   *  fires here; the composer open/close paths call this directly. Reuses
   *  {@link layoutCards} (which reads each card's live `offsetHeight`); a no-op
   *  in stacked mode, where there are no positioned cards. */
  private relayout(): void {
    const $cards = Array.from(
      this.$root.querySelectorAll<HTMLElement>(".thread-card.positioned"),
    );
    const placed = $cards.map(($card) => {
      const raw = $card.dataset.anchorY;
      return { $card, y: raw !== undefined ? Number(raw) : 0 };
    });
    const $tail = this.$root.querySelector<HTMLElement>(".tail-abs");
    this.layoutCards(placed, $tail);
  }

  /** The column's identity line — what this region is, and how many threads it
   *  is holding. In anchored mode it is absolutely positioned at the panel top
   *  (see {@link layoutCards}); in stacked mode it simply flows above the list.
   *
   *  The zero count is still omitted rather than rendered as `0` — a lone `0`
   *  reads as a failed fetch — but the rule now lives in the shared header
   *  rather than here, so every region that grows a count inherits it. */
  private $head(count: number): HTMLElement {
    return SectionHead.makeWith({ title: "Comments", count });
  }

  /** A quiet full-width note (offline / empty states). */
  private $note(text: string): HTMLElement {
    const $note = Typography.text(text);
    $note.className = "note";
    return $note;
  }

  /** One comment card, assembled for the shared {@link CommentCard} factory:
   *  the panel's job shrinks to mapping its viewmodel + per-card gates onto
   *  the card's Option callbacks (null = affordance absent). Layout stays
   *  here — the card reports height changes via `onLayoutChange` and the
   *  panel relayouts its absolutely-positioned siblings. */
  private $card(
    anchored: DocComments.Anchored,
    vm: DocCommentsPanel.ViewModel,
    now: number,
    opts: { showQuote: boolean; faded: boolean },
  ): HTMLElement {
    const { comment } = anchored;
    // Resolve is operator-only (architecture.md → Threads); a viewer with no
    // `isOperator` flag defaults to operator — the only current caller is the
    // operator's own tool.
    const isOperator = vm.isOperator ?? true;
    const onViewFix = vm.onViewFix;
    return CommentCard.make({
      comment,
      now,
      showQuote: opts.showQuote,
      faded: opts.faded,
      // Clickable where there is somewhere to go: a structured anchor pin, or
      // a quote whose comment re-anchors to the live doc.
      onScrollTo:
        comment.anchor != null || anchored.range != null
          ? () => vm.onScrollTo(comment.id)
          : null,
      onReply: (body) => vm.onReply(comment.id, body),
      onResolve: isOperator ? () => vm.onResolve(comment.id) : null,
      onViewFix: onViewFix != null ? () => onViewFix(comment.id) : null,
      onRemove: () => vm.onRemove(comment.id),
      onLayoutChange: () => this.relayout(),
    });
  }

  /** The tail beneath the cards: the quiet collapsible unanchored + resolved
   *  sections (each hidden at N=0). `null` when both are empty. */
  private $tail(
    unanchored: DocCommentsPanel.Item[],
    addressed: DocCommentsPanel.Item[],
    resolved: DocCommentsPanel.Item[],
    vm: DocCommentsPanel.ViewModel,
    now: number,
  ): Option<HTMLElement> {
    if (
      unanchored.length === 0 &&
      addressed.length === 0 &&
      resolved.length === 0
    ) {
      return null;
    }
    const $tail = document.createElement("div");
    $tail.className = "tail";
    if (unanchored.length > 0) {
      const n = unanchored.length;
      const label =
        n === 1
          ? "⚠ 1 comment no longer anchors"
          : `⚠ ${n} comments no longer anchor`;
      $tail.appendChild(this.$section(label, unanchored, vm, now, false));
    }
    // Addressed joins the sectioning between open and resolved (thread-rail):
    // resolution requests awaiting the operator's resolve — not faded.
    if (addressed.length > 0) {
      $tail.appendChild(
        this.$section(`Addressed · ${addressed.length}`, addressed, vm, now, false),
      );
    }
    if (resolved.length > 0) {
      $tail.appendChild(
        this.$section(`Resolved · ${resolved.length}`, resolved, vm, now, true),
      );
    }
    return $tail;
  }

  /** A quiet collapsible section (unanchored / resolved), frameless: a summary
   *  line with a rotating disclosure marker over the card anatomy. Its cards
   *  keep the quote row (no live in-doc highlight to lean on). */
  private $section(
    label: string,
    items: DocCommentsPanel.Item[],
    vm: DocCommentsPanel.ViewModel,
    now: number,
    faded: boolean,
  ): HTMLElement {
    const $section = document.createElement("details");
    $section.className = "section";

    const $summary = document.createElement("summary");
    // A ramp element, not a bare span: --font-size is dead on anything the
    // typography selectors don't match, which is what made a literal
    // font-size look necessary here in the first place.
    const $marker = Typography.text("▸");
    $marker.className = "section-marker";
    const $label = Typography.text(label);
    $label.className = "section-label";
    $summary.append($marker, $label);
    $section.appendChild($summary);

    for (const item of items) {
      $section.appendChild(
        this.$card(item.anchored, vm, now, { showQuote: true, faded }),
      );
    }
    return $section;
  }

  static $styles = [
    CommentCard.$styles,
    css`
      :host {
        display: block;
        height: 100%;
      }

      #root {
        position: relative;
        box-sizing: border-box;
      }

      #root.anchored {
        height: 100%;
        padding: 0px;
      }

      /* No HORIZONTAL padding, deliberately. The header and its rule are what
         declare this region's column, so they have to sit on the same left and
         right edges as the prose above them — an inset here put the whole
         region 4px inside a column every sibling shares. It was invisible
         while the header was a quiet uppercase label and obvious the moment it
         became a heading with a rule, which is the tell that the inset was
         always wrong: chrome can drift, a column edge cannot. Vertical
         breathing room stays. */
      #root.stacked {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 4px 0px;
      }

      /* Out of flow in anchored mode: the cards are absolutely positioned
         against the panel box, so a header in flow would paint under the first
         one instead of pushing it down. layoutCards floors the topmost card at
         this element's measured height.

         Positioning the header is the PANEL's job, not the header's, so the
         rule targets the host from out here. Outer-tree rules matching a host
         beat the component's own :host rules regardless of specificity, so
         this wins without anything having to be marked important. */
      #root.anchored std-section-head {
        position: absolute;
        top: 0px;
        left: 0px;
        right: 0px;
      }

      .stacked-list {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      /* Flush left and right with the header above it — this is the region's
         body text, so it shares the column the header declares. */
      .note {
        --font-size: var(--small-size);
        --line-height-ratio: 1.5;
        --margin-top: 0px;
        --margin-bottom: 0px;
        padding: 4px 0px;
        color: var(--text-ter);
      }

      /* Panel-owned layout rule: absolute cards span the gutter's width.
         The card's own anatomy lives in CommentCard.$styles. */
      .thread-card.positioned {
        position: absolute;
        left: 0px;
        right: 0px;
      }

      .tail-abs {
        position: absolute;
        left: 0px;
        right: 0px;
      }

      .section {
        border-top: 1px solid var(--divider);
        padding-top: 8px;
      }

      .section + .section {
        margin-top: 8px;
      }

      .section > summary {
        display: flex;
        align-items: center;
        gap: 6px;
        list-style: none;
        cursor: pointer;
      }

      .section > summary::-webkit-details-marker {
        display: none;
      }

      /* A glyph is still text: it sizes off --font-size like everything else.
         The old rule handed a CAP-HEIGHT token to the literal font-size
         property, so the marker rendered at 8px instead of the 12.5px that
         token means on the ramp — the two units silently disagreeing inside
         one scale. */
      .section-marker {
        --font-size: var(--small-size);
        --line-height-ratio: 1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
        transition: transform 0.15s ease;
      }

      .section[open] > summary .section-marker {
        transform: rotate(90deg);
      }

      .section-label {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="root"></div>`;
}

export namespace DocCommentsPanel {
  /** One panel row: an anchored comment plus its computed y-offset within the
   *  panel (px, panel-relative; `null` = unanchored, or not yet measurable). */
  export interface Item {
    anchored: DocComments.Anchored;
    y: Option<number>;
  }

  export interface ViewModel {
    items: Item[];
    offline: boolean;
    onResolve: (id: string) => void;
    onRemove: (id: string) => void;
    onScrollTo: (id: string) => void;
    onReply: (id: string, body: string) => void;
    /** Whether the viewer is the operator: gates the operator-only resolve
     *  verb (architecture.md → Threads). Absent defaults to `true` — the
     *  current caller (tento.localhost) is the operator's own tool. */
    isOperator?: Option<boolean>;
    /** Open the interdiff that addressed a thread ("View fix · interdiff").
     *  Absent = no fix link (the verb is omitted). */
    onViewFix?: Option<(id: string) => void>;
  }
}
