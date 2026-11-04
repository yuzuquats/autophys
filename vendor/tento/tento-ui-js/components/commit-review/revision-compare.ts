// Registers std-context-menu-anchor + the menu machinery used by the pickers.
import "../context-menu";
// BARE, not just the named import below. `SectionHead` is only ever used here
// in a TYPE position (the `$head` field), and esbuild elides a named import
// that survives only as a type — so the named import alone does not register
// `std-section-head`, `hydrate("head")` upgrades nothing, and `$head.bind` is
// not a function. It happens to work inside the app bundle, where another
// module pulls section-head in for its own reasons; the storybook builds this
// file alone and had nothing to fall back on. That is what the card is for.
import "../section-head";
import type { SectionHead } from "../section-head";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ContextMenu } from "../context-menu";
import { Position } from "../../anchor-positioning-utils";
import { $inboxPip } from "./inbox-pips";

// The change pane's version selector (commit-review v2 — design.md "Revision
// strip & interdiff"). A SECTION of the pane, like Discussion or project: a
// section head naming it, one pip per captured revision, and the compare
// control that renders the interdiff between two of them.
//
// It used to be std-revision-strip, and it used to live in the header. Two
// things were wrong with that and they are worth separating, because the fix
// for each is different:
//
// 1. It was not a section, so it had nowhere to be. It rode in as an extra
//    element wedged between the header's sub lines and its rule — a 41px
//    block with no name on it, and a `margin-left: auto` that pushed the only
//    interactive part to the far pane edge with 270px of nothing in between.
//    Now it is a region with a std-section-head like every other region in
//    this pane, and the compare control sits in that head's meta slot where
//    right-hand content belongs.
//
// 2. Its dots were their own vocabulary. 14px medallions with number labels
//    absolutely positioned at `top: -17px`, which is what drove them up into
//    the header line above. The sidebar had already settled this: one 7px
//    circle per commit, filled by review state, hollow when there is no diff
//    to review. Same icon here — literally the same function, `$inboxPip`,
//    not a second copy of the geometry — so a reader who has learned the rail
//    can read this without learning anything else.
//
// The pips are CLICKABLE, which the old dots never were. That was the whole
// case against them: every fact they carried was already in the two pickers,
// in a form you could act on. A pip that selects the revision it draws earns
// the space it takes.
//
// The section is purely presentational: it computes the compare selection and
// fires `onInterdiff(from, to)` / `onExit()`. The owning pane loads the
// interdiff artifact and binds it into the SAME std-diff-view (the interdiff
// gets zero special chrome — it is literally the diff component), so this
// component never touches the diff surface itself. It self-hides when there is
// nothing to compare (< 2 revisions).

@component({ name: "std-revision-compare" })
export class RevisionCompare extends LonaWebComponent {
  private $head: SectionHead = this.hydrate("head");
  private $pips: HTMLElement = this.$("pips");
  private $from: HTMLElement = this.$("from");
  private $to: HTMLElement = this.$("to");
  private $interdiff: HTMLElement = this.$("interdiff");
  private $exit: HTMLElement = this.$("exit");
  private $arrow: HTMLElement = this.$("arrow");

  private vm: Option<RevisionCompare.ViewModel>;
  private from = 0;
  private to = 0;
  private active = false;

  /** The reviewer asked for the interdiff between two captured revisions. */
  onInterdiff: Option<(from: number, to: number) => void> = null;
  /** Leave the interdiff view and restore the full change diff. */
  onExit: Option<() => void> = null;

  constructor() {
    super();
    this.bindEvents();
  }

  /** Construct + bind in one call — the house pattern for a component whose
   * every caller does exactly that (cf. `ReviewSeq.Diagram.makeWith`). */
  static makeWith(vm: RevisionCompare.ViewModel): RevisionCompare {
    return RevisionCompare.make().bind(vm);
  }

  bind(vm: RevisionCompare.ViewModel): this {
    this.vm = vm;
    this.active = false;
    // Default compare: "since my last changes_requested" → current. Absent a
    // request-for-changes, fall back to the previous revision. This is the
    // reason `changesRequestedAt` survives at all — it is what makes the
    // one-click default the comparison the reviewer actually wants, and losing
    // it would quietly demote every needs-revision change to "N-1 → N".
    const prev = vm.current > 1 ? vm.current - 1 : vm.current;
    this.from = vm.changesRequestedAt ?? prev;
    this.to = vm.current;
    if (this.from >= this.to) this.from = Math.max(1, this.to - 1);
    this.toggleAttribute("hidden", vm.revisions.length < 2);
    this.$head.bind({ title: "Versions", count: vm.revisions.length });
    this.bindPips();
    this.bindCompare();
    return this;
  }

  /** Select one historical revision from another surface (Discussion). The
   *  Versions region remains the owner of comparison state; callers only name
   *  the Diff the reader chose. */
  selectRevision(n: number): void {
    const revisions = this.vm?.revisions ?? [];
    if (!revisions.some((revision) => revision.n === n)) return;
    const previous = [...revisions].reverse().find((revision) => revision.n < n)?.n ?? n;
    this.from = previous;
    this.to = n;
    this.active = false;
    this.bindCompare();
  }

  private bindEvents(): void {
    GESTURE_MANAGER.addPointerEvent(this.$from, {
      onClick: () => this.openPicker(this.$from, "from"),
    });
    GESTURE_MANAGER.addPointerEvent(this.$to, {
      onClick: () => this.openPicker(this.$to, "to"),
    });
    GESTURE_MANAGER.addPointerEvent(this.$interdiff, {
      onClick: () => this.runInterdiff(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$exit, {
      onClick: () => this.exit(),
    });
  }

  /** One pip per revision, in the rail's vocabulary. Selection is drawn on the
   * WRAPPER, not the circle: the circle is the shared icon and must stay
   * identical to the one the sidebar draws. */
  private bindPips(): void {
    const vm = this.vm;
    if (vm == null) return;
    this.$pips.replaceChildren();
    for (const rev of vm.revisions) {
      const $slot = document.createElement("span");
      $slot.className = "pip";
      // A revision the reviewer asked for changes on is the one fact about
      // this history that changes what they do next, so it keeps the rail's
      // red. Everything else is unreviewed-by-itself — a revision never
      // carries its own verdict, the CHANGE does — so it takes the rail's
      // pending colour rather than inventing a fourth state. Hollow means the
      // same thing it means in the rail: nothing to review here, which for a
      // revision is a note-only capture.
      const state =
        vm.changesRequestedAt != null && rev.n === vm.changesRequestedAt
          ? "changes_requested"
          : "pending";
      $slot.appendChild($inboxPip({ state, hollow: rev.trigger === "note-only" }));
      $slot.title = `diff ${rev.n} · ${rev.trigger}`;
      $slot.setAttribute("role", "button");
      $slot.setAttribute("aria-label", `compare up to diff ${rev.n} (${rev.trigger})`);
      $slot.dataset.n = String(rev.n);
      // A click moves the NEARER end of the range to it, the way any range
      // selector behaves: clicking left of the pair extends the start back,
      // clicking right of it extends the end forward, and the other end stays
      // where the reader put it. Always writing `to` instead looked right
      // until you clicked an early pip — pick()'s inversion swap then silently
      // discarded the end you had chosen (21→22, click 6, and you got 6→21).
      GESTURE_MANAGER.addPointerEvent($slot, {
        onClick: () => this.pick(this.nearerEnd(rev.n), rev.n),
      });
      this.$pips.appendChild($slot);
    }
    this.markSelection();
  }

  /** Which end of the range a click on `n` should move. Outside the pair it is
   * the end on that side; inside it is whichever end is closer, and a tie goes
   * to `to` so a click in the middle shrinks the range from the newer side
   * rather than sitting there doing nothing. */
  private nearerEnd(n: number): "from" | "to" {
    if (n <= this.from) return "from";
    if (n >= this.to) return "to";
    return n - this.from < this.to - n ? "from" : "to";
  }

  /** Which pips the comparison spans, and which of those are its ends. Re-run
   * on every selection change; never rebuilds the pips themselves.
   *
   * The count goes out as `--range-span` because the capsule is a single box
   * on the start pip and CSS cannot count siblings into a length. It is the
   * number of pips, not `to - from`: revision numbers are the labels, and a
   * history with a gap in it would size the capsule to the gap rather than to
   * what is drawn. */
  private markSelection(): void {
    let span = 0;
    for (const $slot of this.$pips.children) {
      const n = Number(($slot as HTMLElement).dataset.n);
      const inRange = n >= this.from && n <= this.to;
      if (inRange) span += 1;
      $slot.classList.toggle("in-range", inRange);
      $slot.classList.toggle("range-start", n === this.from);
      $slot.classList.toggle("range-end", n === this.to);
    }
    this.$pips.style.setProperty("--range-span", String(span));
  }

  private bindCompare(): void {
    this.$from.textContent = `diff ${this.from}`;
    this.$to.textContent = `diff ${this.to}`;
    this.toggleAttribute("active", this.active);
    this.$exit.toggleAttribute("hidden", !this.active);
    this.$interdiff.textContent = this.active ? "interdiff ✓" : "interdiff";
    this.$arrow.textContent = "→";
    this.markSelection();
  }

  private openPicker($anchor: HTMLElement, which: "from" | "to"): void {
    const vm = this.vm;
    if (vm == null) return;
    const builder = ContextMenu.builder(160);
    for (const rev of vm.revisions) {
      const current = which === "from" ? this.from : this.to;
      // `· absorb` / `· revise` is what the dots' hover tooltip used to say.
      // In a menu it does not need hovering, and it is the only thing that
      // distinguishes two adjacent revisions from each other.
      const label = `diff ${rev.n} · ${rev.trigger}`;
      builder.cellRow(
        rev.n === current ? `${label} ✓` : label,
        null,
        () => this.pick(which, rev.n),
      );
    }
    // ContextMenu.show applies the position as `position: fixed`, so it needs
    // a viewport-coordinate POINT. The anchored Position.* constants
    // (BOTTOM_CENTER et al.) are `top: calc(100% + …)` / `translateX(-50%)`
    // shaped for the floating-element system; under `position: fixed` the
    // `100%` resolves against the VIEWPORT, so the menu lands in the
    // bottom-left corner instead of under the button (same trap breadcrumb.ts
    // documents). Anchor a fixed point just below the picker instead.
    const rect = $anchor.getBoundingClientRect();
    builder.buildAndReveal($anchor, {
      position: Position.fromPoint({ x: rect.left, y: rect.bottom + 4 }),
    });
  }

  private pick(which: "from" | "to", n: number): void {
    if (which === "from") this.from = n;
    else this.to = n;
    // Keep the pair ordered (older → newer); swap on inversion.
    if (this.from > this.to) {
      const t = this.from;
      this.from = this.to;
      this.to = t;
    }
    this.bindCompare();
  }

  private runInterdiff(): void {
    if (this.from === this.to) return;
    this.active = true;
    this.bindCompare();
    this.onInterdiff?.(this.from, this.to);
  }

  private exit(): void {
    if (!this.active) return;
    this.active = false;
    this.bindCompare();
    this.onExit?.();
  }

  static $styles = [
    css`
      :host {
        display: block;
        /* Explicit, like std-record-header's and for the same reason: this
           section puts a name at one edge and a control at the other, and as
           a flex/grid ITEM block takes its width from its CONTENT — the
           control then lands beside the title instead of across the pane, and
           the auto margin holding it there has nothing to push against. */
        width: 100%;
        padding-top: 18px;
      }

      :host([hidden]) {
        display: none;
      }

      #head {
        --section-head-size: var(--h7-size);
      }

      #pips {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px 0;
        padding-top: 10px;
      }

      /* The click target, sized for a pointer rather than to the 7px icon it
         holds. Its width ABSORBS the inter-pip spacing (23px pitch = the old
         18px slot + 5px gap), which is what lets the capsule below be one box
         n pips wide with no gaps to account for. Change this width and that
         calc changes with it. Nothing here touches the circle — that is the
         shared rail icon and any styling of it here would be a second copy of
         the vocabulary. */
      .pip {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 23px;
        height: 18px;
        border-radius: 999px;
        cursor: pointer;
        user-select: none;
      }

      /* The capsule is ONE BOX, drawn by the start pip and stretched across
         the range, not a fill shared by N spans.

         The per-span version is what forces a hard edge. Blur and spread bleed
         sideways, and since the pips are separate elements painted in DOM
         order, each one's shadow lands on its right-hand neighbour: the band
         picks up a seam every 23px, exactly at the pitch that makes it read as
         a row of chips rather than a range. Zero-blur block hairlines were the
         only per-span effect that abuts cleanly — which is a constraint on the
         geometry, not a design decision, so the geometry is what changed.

         One element also means the shape is stated once. The interior pips no
         longer square their corners to fake continuity, and a one-pip range is
         the same rounded box at its minimum width rather than a special case.

         --range-span is the pip count, written by markSelection(); 23px is the
         pip pitch this file already sets above. Negative z-index puts it under
         the icons: the pips are inline-level and paint in a later layer, so
         every pip in the range sits ON the capsule regardless of source order,
         including the start pip that owns it. */
      .pip.in-range.range-start::before {
        content: "";
        position: absolute;
        z-index: -1;
        top: 0;
        bottom: 0;
        left: 0;
        width: calc(var(--range-span, 1) * 23px);
        border-radius: 999px;
        box-shadow: 0 1px 2px 1px var(--bg-selected);
      }


      /* Hover DARKENS what is under it rather than replacing it: the ramp is
         translucent, so a bare pip and a pip sitting on the capsule's halo
         both shift by the same amount and neither reads as a hole punched in
         the band. An opaque background would have to pick one colour and
         would then be wrong over the other.

         Hover weight, not selected weight. --bg-selected is 12% and this pip
         is 18px of it directly under the cursor, which lands closer to
         "pressed" than to "you could click this" — the capsule already
         carries the selection, so the pointer only has to say where it is.
         --bg-hover is 6% in BOTH modes; the -light variant drops to 3% in
         dark and would nearly vanish there. */
      .pip:hover {
        box-shadow: inset 0 0 0 999px var(--bg-hover);
      }

      #compare {
        display: flex;
        gap: 6px;
        align-items: center;
        color: var(--text-sec);
      }

      /* On the ramp: a literal font-size wins the size and loses the
         cap-height trim. .text is what puts a span inside the ramp's closed
         selector list — without it --font-size is silently inert. */
      #compare,
      .rbtn,
      #exit {
        --font-size: var(--caption-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      .rbtn {
        padding: 3px 9px;
        border-radius: 6px;
        border: 1px solid var(--divider);
        background: var(--bg-elevated, var(--bg));
        color: var(--text-pri);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }

      .rbtn.pick::after {
        content: " ▾";
        color: var(--text-ter);
      }

      .rbtn.primary {
        background: var(--text-pri);
        border-color: var(--text-pri);
        color: var(--bg);
      }

      #arrow {
        color: var(--text-ter);
      }

      #exit {
        color: var(--fg-blue, #3b82f6);
        cursor: pointer;
        user-select: none;
      }

      #exit[hidden] {
        display: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-section-head id="head">
      <div id="compare" slot="meta">
        <span class="text">compare</span>
        <span id="from" class="rbtn pick text"></span>
        <span id="arrow" class="text">→</span>
        <span id="to" class="rbtn pick text"></span>
        <span id="interdiff" class="rbtn primary text">interdiff</span>
        <span id="exit" class="text" hidden>exit</span>
      </div>
    </std-section-head>
    <div id="pips"></div>
  `;
}

export namespace RevisionCompare {
  export type Trigger = "initial" | "revise" | "absorb" | "note-only";

  export interface ActorRef {
    kind: string;
    id: string;
    provider: string;
    session_ref?: Option<string>;
    label: string;
    host: string;
  }

  export interface Scope {
    patch?: Option<{ files_changed: number; additions: number; deletions: number }>;
    note?: Option<{ additions: number; deletions: number }>;
  }

  /** One captured revision — a `.reviews/<cid>/revisions/vN` snapshot. The
   *  section needs `n` + `trigger`; `captured_at` (unix SECONDS, as the wire
   *  carries it) is here because the discussion log renders the same captures
   *  as time-ordered events, and both views read this one payload. */
  export interface Revision {
    n: number;
    trigger: Trigger;
    captured_at: number;
    actor?: Option<ActorRef>;
    occurred_at?: Option<number>;
    scope?: Option<Scope>;
  }

  export interface ViewModel {
    /** Captured revisions, ascending by `n`. */
    revisions: Revision[];
    /** The latest revision number. */
    current: number;
    /** The revision a live `changes_requested` verdict was written against
     * (`Review.revision`), or null when the change isn't in needs-revision.
     * Draws the one red pip, and seeds the default comparison. */
    changesRequestedAt: Option<number>;
  }
}
