import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Typography } from "../ui/typography";

// The identity block of a RECORD: what this thing is (the title), the short
// facts that address it (the sub lines), a warning when something about it is
// wrong, and a rule closing the block off from the body below.
//
// It sits one rung under std-review-page-header (a page hero — kicker, big
// title, status) and one rung over std-section-head (a region's label). The
// altitude it owns is "a single record opened in a detail pane": a commit, a
// queued set, a worktree diff.
//
// It exists because the commit-review surface had invented it TWICE, in two
// four-thousand-line shells, as private `Header.make()` factories over
// near-identical `.meta-line` / `.meta-sub` / `.meta-warn` / `.meta-divider`
// CSS blocks (stack-review.ts and commit-review.ts). Six header variants ran
// through them and neither copy had a storybook, so neither could be looked at
// without booting the whole review app. The copies had already drifted: one
// set the sub line in mono, the other did not.
//
// Three things are deliberately different from what it replaces:
//
// 1. The type is ON THE RAMP. Both copies declared literal font sizes (14px /
//    11.5px / 12px), which win the size and lose the baseline-capheight margin
//    trim `--font-size` applies — the same violation section-head.ts documents
//    at length. Here every size is a `--font-size` on a semantic token, so
//    this header moves when the scale moves. It renders larger than the
//    literals did, because --font-size is a CAP-HEIGHT box: 14px of cap is
//    ~19.4px of font. That is the ramp working, not a bug, and the size is a
//    one-line knob on :host for a caller who wants it quieter.
//
// 2. The sub line gets a REAL mono face. Both copies asked for
//    `var(--mono, monospace)` and `--mono` is defined nowhere in the app, so
//    both shipped the browser's generic monospace — a different, chunkier face
//    than the SF Mono every code span two components over renders. The stack
//    now comes from Typography.MONO_STACK, which is also what codeBlockRule
//    uses. (The other 25 `var(--mono, …)` sites across commit-review and
//    review-notes are still wrong; defining `--mono` at theme level is their
//    fix and is not this component's business.)
//
// 3. Right-hand content arrives through a NAMED SLOT. The v2 shell used to
//    hand its revision control in as an adopted element that landed BELOW the
//    sub lines in its own full-width block — 41px of header for a control that
//    fits on the title line, with the control flung to the far pane edge by a
//    `margin-left: auto` and nothing in the 270px between. A slotted child
//    sits on the title row and stays in the caller's light DOM, under the
//    caller's own stylesheet, instead of being stranded in this shadow root
//    where only inline styles could reach it (the tax project-pane.ts pays).
//
// The default slot keeps the "a block of my own, above the rule" shape for
// content that genuinely is a block — the v1 shell's dependency chips.

@component({ name: "std-record-header" })
export class RecordHeader extends LonaWebComponent {
  private $status: HTMLElement = this.$("status");
  private $title: HTMLElement = this.$("title");
  private $subs: HTMLElement = this.$("subs");
  private $warn: HTMLElement = this.$("warn");

  /** Construct + bind in one call — the house pattern for a component whose
   * every caller does exactly that (cf. SectionHead.makeWith). */
  static makeWith(vm: RecordHeader.ViewModel): RecordHeader {
    return RecordHeader.make().bind(vm);
  }

  bind(vm: RecordHeader.ViewModel): this {
    this.$title.textContent = vm.title;
    this.setStatus(vm.status);
    this.bindSubs(vm.subs);
    this.bindWarn(vm.warn);
    return this;
  }

  /** The status line alone. A record's state is the thing about it most likely
   * to change under an unchanged title — a verdict lands, a draft publishes —
   * and it is also the thing most likely to arrive a beat LATE, on the async
   * read that fetches the verdict. Separate setter so a caller can paint the
   * state it already knows synchronously and reconcile when the read returns,
   * rather than leaving the line blank until then. */
  setStatus(status: Option<RecordHeader.Status>): void {
    this.$status.replaceChildren();
    if (status != null) {
      // The ICON is the state. It carries the whole of it — there is no word
      // beside it saying "needs review", because the marker already says that
      // to anyone who has looked at the sidebar once, and spelling it out cost
      // a line twice as long as the thing it labelled.
      //
      // It is also why the colour lives here and not in the type: a coloured
      // LABEL has to be legible as text in the state colour, and the palette's
      // yellow is 1.4:1 against white (measured). A filled shape has no such
      // constraint, so it can be the exact rail colour.
      if (status.icon != null) {
        const $icon = document.createElement("span");
        $icon.className = "status-icon";
        $icon.appendChild(status.icon);
        this.$status.appendChild($icon);
      }
      // Optional, and genuinely so: a record whose marker says the whole
      // thing renders the marker alone rather than the marker plus an empty
      // span holding a gap open beside it.
      if (status.label != null) {
        const $label = document.createElement("span");
        if (typeof status.label === "string") $label.textContent = status.label;
        else $label.append(...status.label);
        this.$status.appendChild($label);
      }
    }
    this.$status.toggleAttribute("hidden", status == null);
  }

  /** The sub lines alone, for a record whose facts change under an unchanged
   * title (a verdict landing, a blocker clearing). */
  bindSubs(subs: readonly RecordHeader.Sub[]): void {
    this.$subs.replaceChildren();
    for (const sub of subs) {
      const $s = document.createElement("div");
      $s.className = "caption sub";
      // A sub line is plain text or a ready-made run of nodes — a record's
      // address is a link, and the header must not have to know how to build
      // one to be allowed to show it.
      if (typeof sub === "string") $s.textContent = sub;
      else $s.append(...sub);
      this.$subs.appendChild($s);
    }
    this.$subs.toggleAttribute("hidden", subs.length === 0);
  }

  /** The warn line alone. A string is a sentence; an element is a sentence the
   * caller has already threaded links through. `null` removes it. */
  bindWarn(warn: Option<string | HTMLElement>): void {
    this.$warn.replaceChildren();
    if (typeof warn === "string") this.$warn.textContent = warn;
    else if (warn != null) this.$warn.appendChild(warn);
    this.$warn.toggleAttribute("hidden", warn == null);
  }

  onRecycle(): void {
    super.onRecycle();
    this.$title.textContent = "";
    this.setStatus(null);
    this.bindSubs([]);
    this.bindWarn(null);
  }

  // The call form, not the tagged form: `css` stringifies a
  // TemplateStringsArray and DROPS every interpolation, so MONO_STACK would
  // vanish and the sub line would silently inherit whatever face is around it
  // — which is the exact failure this component exists to fix.
  static $styles = [
    css(/* css */ `
      /* Every default lives on :host and nowhere else. A default declared on
         #root would sit BELOW the host in the tree and beat the caller's value
         set on the host element — the knob would silently stop working. */
      :host {
        /* --h7-size, not --h3-size. --font-size is a CAP-HEIGHT box, so the
           rendered face is the token divided by ~0.72: h3's 14px of cap comes
           out at 19.4px, which is 39% more ink than the literal font-size:
           14px this replaced and read as a page hero sitting on top of a
           commit. h7 lands at 15.3px — a shade above what was there before,
           on the ramp, and still the loudest thing in the pane. */
        --record-header-title-size: var(--h7-size);
        --record-header-title-color: var(--text-pri);
        /* --text-8px, below --caption-size, which is the semantic ramp's
           floor. A PIXEL token rather than a role is normally the thing to
           avoid here, but this line has no role above caption to reach for and
           the address genuinely sits under one: the marker beside it is the
           loud part, and the handle is a quiet identifier hanging off it. */
        --record-header-status-size: var(--text-8px);
        --record-header-status-color: var(--text-ter);
        --record-header-sub-size: var(--caption-size);
        --record-header-sub-color: var(--text-ter);
        --record-header-sub-font: ${Typography.MONO_STACK};
        --record-header-warn-size: var(--p-size);
        --record-header-warn-color: var(--orange);
        --record-header-rule: 1px solid var(--divider);
        /* One rhythm value: the gap between stacked lines, and the air above
           the rule. With the ramp's cap-height boxes these are true
           cap-to-baseline distances, so they read tighter than the same
           number would between untrimmed line boxes. */
        --record-header-gap: 7px;
        /* Below the TITLE specifically, which is not the same rhythm. The
           status line above it and the sub lines below it are both captions
           attached to the title, so they sit tight to it; but the title is
           where the block's weight is, and everything under it — the address,
           the warning, the rule closing the block — needs to read as coming
           after it rather than crowding it. One value, so the space under the
           title is the same whether the next thing is a sub line or the rule.
           Cap-height boxes, so this is true ink-to-ink distance. */
        --record-header-title-gap: 14px;
        /* How far the rule escapes its container on each side, to reach the
           pane edges. Zero — no bleed — is the honest default for a primitive
           that does not know what it is inside; the review panes publish
           --pane-pad on their scroller and get the full-bleed hairline for
           free. */
        --record-header-bleed: var(--pane-pad, 0px);

        display: block;
        /* Explicit, not implied by display: block. This header's whole job is
           putting the title at one edge and a control at the other, and as a
           flex/grid ITEM — which is what it becomes the moment it is dropped in
           a centred container, a storybook card being the first one to try —
           block resolves its width from its CONTENT. The row then collapses
           to a column of single words and the arrangement it exists for is
           gone. Caught by the card, not by the app, which is what the card is
           for. */
        width: 100%;
        /* The title row asks about ITS OWN width, not the viewport's: the
           fleet shell frames this miniapp at a small logical viewport, so a
           media query would answer a question nobody asked. */
        container-type: inline-size;
        container-name: record-header;
      }

      /* The top line: the state marker, and the record's ADDRESS beside it.
         Exactly the shape of a row in the sidebar — pip, then handle — which
         is the point: the reader arrives here by clicking one of those rows,
         and the top of the pane repeats it back rather than introducing a
         second way of naming the same record.
         It reads as a sub line, not as a label: same mono, same quiet colour.
         The earlier upper-case tracked-out treatment was for a WORD ("NEEDS
         REVIEW"); a handle is an identifier and micro-caps mangles one. */
      #status {
        --font-size: var(--record-header-status-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: var(--record-header-gap);
        font-family: var(--record-header-sub-font);
        color: var(--record-header-status-color);
      }

      #status[hidden] {
        display: none;
      }

      /* A box for whatever the caller drew, not a box that draws. The marker
         is the surface's own vocabulary — for the review shells, literally the
         same pip the sidebar renders — and styling it here would make this a
         second copy of a vocabulary this component does not own. */
      .status-icon {
        display: inline-flex;
        align-items: center;
        flex: none;
      }

      #titlerow {
        display: flex;
        align-items: baseline;
        gap: var(--record-header-gap);
        /* On the ROW, not on each thing that might follow it: subs, warn and
           rule are all optional, so hanging the space off whichever happens to
           be first means three rules that have to agree. */
        margin-bottom: var(--record-header-title-gap);
      }

      #title {
        --font-size: var(--record-header-title-size);
        --line-height-ratio: 1.2;
        /* Pinned, not inherited: these two propagate, so an ancestor's list or
           prose styling leaks a second invisible gap into the stack. */
        --margin-top: 0px;
        --margin-bottom: 0px;
        /* Without this a long subject refuses to wrap and shoves the trailing
           control off the pane. */
        min-width: 0;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--record-header-title-color);
      }

      #subs {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      #subs[hidden] {
        display: none;
      }

      /* Id-scoped so it beats the ramp's own .caption rule outright rather
         than on source order — both are one class otherwise, and which sheet
         is adopted first is not a thing this component should depend on. */
      #subs .sub {
        --font-size: var(--record-header-sub-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: var(--record-header-sub-font);
        color: var(--record-header-sub-color);
        /* An address can be long — a path, a mirrored-from locator. Wrap it
           rather than let it push the pane wider. */
        overflow-wrap: anywhere;
      }

      /* A link in the identity block is a HANDLE — a name you can go to, not
         a web link. It reads as plain text until the pointer is on it, and
         only then admits that it goes somewhere; underlining every id would
         stripe the block.

         These rules have to live on THIS side of the shadow boundary. The sub
         and warn nodes are built by the caller and adopted into this root,
         where the caller's own stylesheet cannot follow — the tax
         project-pane.ts documents. Same three declarations as stack-log's
         HANDLE_STYLE, which every shadow root drawing a handle duplicates for
         exactly this reason; not imported from there because a top-level
         primitive must not depend on a commit-review component.

         Nothing here may set a font property. A handle is a word inside
         somebody else's line, and that line already chose a family and a size
         that agree — StackLog.$handleLink inlines font: inherit on the
         element to guarantee it. */
      #status a,
      #subs a,
      #warn a {
        color: inherit;
        text-decoration: none;
        cursor: pointer;
      }

      #status a:hover,
      #subs a:hover,
      #warn a:hover {
        color: var(--record-header-title-color);
        text-decoration: underline;
      }

      /* The warn line is the one part of this block that is PROSE, so an
         unmarked handle in the middle of the sentence would not read as a
         place to go. This one underlines at rest. */
      #warn a {
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      #warn {
        --font-size: var(--record-header-warn-size);
        --line-height-ratio: 1.2;
        --margin-top: 0px;
        --margin-bottom: 0px;
        margin-top: var(--record-header-gap);
        color: var(--record-header-warn-color);
        overflow-wrap: anywhere;
      }

      #warn[hidden] {
        display: none;
      }

      #rule {
        border-top: var(--record-header-rule);
        /* The negative margin mirrors the bleed on both sides, so the hairline
           reaches the pane edges and can never drift from the padding. */
        /* The same value that opens the space under the title, so the block
           is closed with as much air as it was opened with. The 7px rhythm
           left the hairline 4px of ink under the address — the address read
           as attached to the rule rather than to the record. */
        margin: var(--record-header-title-gap) calc(-1 * var(--record-header-bleed)) 0;
      }

      /* A default, not a rule: ::slotted loses to any rule in the caller's own
         tree, which is the point of slotting rather than adopting. */
      ::slotted(*) {
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      /* The trailing control is a DIRECT flex item of the title row — there is
         deliberately no wrapper div around the slot.

         A wrapper cannot tell whether anything is in it: :not(:has(*)) is
         always false, because the <slot> ELEMENT is its child whether or not
         anything is assigned, and :has() walks the DOM tree rather than the
         flat tree where slotted content lives. So a header with no control —
         or with one that has self-hidden, which is what the revision compare
         does below two revisions — would still reserve the wrapper's row-gap
         when the row wraps. A bare <slot> is display: contents, so the
         control itself becomes the flex item: absent, there is no item, and
         display: none on the control removes it from flex layout outright.
         Nothing is left to leave a phantom row behind. */
      ::slotted([slot="trailing"]) {
        flex: none;
        margin-left: auto;
      }

      /* Narrow pane: the control cannot share the title's row without
         squeezing the subject into a column of single words, so it takes a row
         of its own under the title. Spacing is the row's gap, not a margin on
         the control, so it exists only when there are two rows. */
      @container record-header (max-width: 480px) {
        #titlerow {
          flex-wrap: wrap;
          row-gap: var(--record-header-gap);
        }

        ::slotted([slot="trailing"]) {
          margin-left: 0;
          flex: 1 0 100%;
        }
      }
    `),
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <div id="status" class="label" hidden></div>
      <div id="titlerow">
        <h3 id="title"></h3>
        <slot name="trailing"></slot>
      </div>
      <div id="subs" hidden></div>
      <div id="warn" class="p" hidden></div>
      <slot></slot>
      <div id="rule"></div>
    </div>
  `;
}

export namespace RecordHeader {
  /** A sub line is plain text or a ready-made run of nodes — a record's
   * address is a link, and so is a reference to another record. */
  export type Sub = string | Node[];

  export interface Status {
    /** The state marker, drawn before the label. A NODE the caller supplies,
     * not a tone this component maps to a colour of its own: the review shells
     * hand in the very pip the sidebar draws — at a larger size, but the same
     * icon — so a record says the same thing at the top of the pane that its
     * row says in the rail. `null` for a state with no marker in the surface's
     * vocabulary (nothing committed yet has a verdict to draw). */
    icon: Option<Node>;
    /** What the marker is ABOUT, usually the record's address: `L-191`,
     * `D-6127`. Takes nodes as well as text because an address is a link.
     * `null` when the marker stands alone — a project's marker is a roll-up
     * of its members, and there is no second name for that. */
    label: Option<Sub>;
  }

  export interface ViewModel {
    /** What state the record is in, above the title. `null` draws no line —
     * a record with nothing to say about its state must not reserve the row.
     */
    status: Option<Status>;
    /** What this record IS — a commit subject, a set's message, "unstaged". */
    title: string;
    /** The short facts that address it, one per line, in reading order. */
    subs: readonly Sub[];
    /** Something is wrong WITH the record itself (blocked, orphaned). Not an
     * error loading it — a pane reports that where the body would be. */
    warn: Option<string | HTMLElement>;
  }
}
