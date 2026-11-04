import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaCardHeader } from "../../ui/card-header-styles";
import { Typography } from "../../ui/typography";

// A generic content card: a header (title / subtitle / score on a
// surface, with an optional positive accent on the header background), a default
// slot for the body (media or arbitrary content), a `chips` slot for a status
// strip, and a `menubar` slot for an action row. Pure chrome — it owns no
// data-loading or page logic; consumers project content + actions and drive the
// `selected` / `accent` states.
//
// The three projected regions stack in the order a reader needs them:
// header (what this is) → chips (what state it is in) → menubar (what you can
// do about it) → body. All three share the header block's 6px gutter, so their
// left edges form one line down the card. A consumer that hand-placed its own
// strip could not hit that line: it saw the card's outer edge, not the header
// block's inset, and market-research's badges sat 8px left of the title as a
// result.
@component({
  name: "std-card",
})
export class Card extends LonaWebComponent {
  private $header: HTMLElement = this.$("header");
  private $title: HTMLElement = this.$("title");
  private $subtitle: HTMLElement = this.$("subtitle");
  private $score: HTMLElement = this.$("score");

  private onHeaderClick: Option<EmptyFunction> = null;

  // Wired ONCE, and dispatched through a field bind() sets. Registering the
  // gesture inside bind() (or only when a callback is present) is how a pooled
  // instance ends up carrying its predecessor's handler — the trap std-button
  // documents on its own recycle path.
  //
  // GESTURE_MANAGER normalises mouse, touch and pen; it has NO keyboard path.
  // A header that is reachable by pointer only is not reachable at all for a
  // keyboard user, so Enter and Space route into the SAME field here rather
  // than into a second copy of the action.
  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$header, {
      onClick: () => this.onHeaderClick?.(),
    });
    this.$header.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this.onHeaderClick == null) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      // Space scrolls the page by default, and Enter would submit an enclosing
      // form; a control that claims role=button owes both.
      e.preventDefault();
      this.onHeaderClick();
    });
  }

  static makeWith(vm: Card.ViewModel): Card {
    return Card.make().bind(vm);
  }

  bind(vm: Card.ViewModel): this {
    this.setText(this.$title, vm.title);
    this.setText(this.$subtitle, vm.subtitle);
    this.setText(this.$score, vm.score);
    this.$header.hidden = vm.title == null && vm.subtitle == null &&
      vm.score == null;
    this.setAccent(vm.accent === "positive");
    this.setSelected(vm.selected ?? false);
    this.setHeaderAction(vm.onHeaderClick);
    return this;
  }

  // The header is the card's identity, so it is also the obvious thing to
  // click to open the card. It becomes a control only when a consumer hands it
  // an action: without one it keeps no role, no tab stop and no pointer
  // cursor, because announcing a button that does nothing is worse than
  // announcing nothing. Written on EVERY bind, so a pooled instance can never
  // keep the previous binding's role or tab stop.
  private setHeaderAction(onClick: Option<EmptyFunction>): void {
    this.onHeaderClick = onClick;
    this.$header.toggleAttribute("interactive", onClick != null);
    if (onClick == null) {
      this.$header.removeAttribute("role");
      this.$header.removeAttribute("tabindex");
    } else {
      this.$header.setAttribute("role", "button");
      this.$header.setAttribute("tabindex", "0");
    }
  }

  setSelected(selected: boolean): void {
    this.toggleAttribute("selected", selected);
  }

  // The header background is the single place a positive accent shows. Callable
  // live (e.g. on a verdict toggle) without a full rebind.
  setAccent(positive: boolean): void {
    if (positive) this.$header.setAttribute("accent", "positive");
    else this.$header.removeAttribute("accent");
  }

  onRecycle(): void {
    super.onRecycle();
    this.removeAttribute("selected");
    this.$header.hidden = true;
    this.$header.removeAttribute("accent");
    this.setHeaderAction(null);
    this.setText(this.$title, null);
    this.setText(this.$subtitle, null);
    this.setText(this.$score, null);
  }

  private setText($el: HTMLElement, value: Option<string>): void {
    $el.textContent = value ?? "";
    $el.hidden = value == null;
  }

  static $styles = [
    Typography.$style,
    Typography.$maxLines,
    LonaCardHeader.$style,
    css`
      :host {
        box-sizing: border-box;
        display: block;
        width: 100%;
        /* Render in the UI font + default cap-height metrics regardless of the
           host page's font theme. The GTM / campaigns surface sets
           font-family: Manrope + .font-metrics-manrope (cap-height 0.163) on the
           document, which would otherwise inherit into this shadow tree and
           resize the header vs market-research (Poppins). Pin to the theme-base
           :root defaults so the card is identical everywhere.

           The family is a KNOB rather than a constant, because "do not inherit
           whatever the page has" and "always be Poppins" are two different
           requirements and only the first one is load-bearing. A consumer that
           has a deliberate family says so; one that says nothing still gets a
           pinned, predictable face instead of the document's. market-research
           sets it to the app's Helvetica stack; campaigns, the surface this pin
           was written for, says nothing and keeps Poppins.

           The cap metrics above are NOT part of the knob and do not move with
           it. --font-height resolves to 0.72, which is the cap-to-em ratio the
           type scale assumes; a family whose real ratio is far from that
           renders every size in this card slightly off. Measured on the
           development host, the stack market-research passes resolves to 0.69
           — a 4% shortfall. That is NOT introduced here: the Poppins stack it
           replaces measured 0.69 too, because neither Poppins nor Helvetica is
           installed there and both fall back to the same grotesque. On a host
           carrying the real faces both numbers move, and this comment does not
           know which way. */
        font-family: var(--card-font-family, Poppins, sans-serif);
        --cap-height: 0.125;
        --baseline: 0.155;
        /* The header type tokens are rem-based, and the GTM/campaigns surface
           runs a responsive root font-size (~17.78px vs 16px), which would scale
           the header up 10/9. rem is root-relative (a :host font-size can't undo
           it), so pin the consumed size token to an absolute px — the default
           16px-root value — to keep the card a fixed UI scale everywhere. */
        --small-size: 9px;
        text-rendering: auto;
        -webkit-font-smoothing: auto;
      }

      #root {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: 100%;
        /* Two knobs, because a card nested INSIDE another surface wants
           neither. The 120px floor and the drop shadow are what make a card
           read as a standalone object on a page; a card that is one region of
           a list row is not standalone, and both make it look like a dialog
           that escaped. Defaults unchanged, so no existing card moves. */
        min-height: var(--card-min-height, 120px);
        overflow: hidden;
        border: 1px solid var(--divider);
        border-radius: 8px;
        background: color-mix(in srgb, var(--bg) 94%, white 6%);
        box-shadow: var(
          --card-shadow,
          0 12px 30px color-mix(in srgb, black 7%, transparent)
        );
      }

      :host([selected]) #root {
        border-color: var(--text-pri);
      }

      #header {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 6px;
        /* 6px gutter on three sides, 4px below: the header, the chips and the
           menubar are one META BLOCK — what this is, what state it is in, what
           you can do about it — and the gaps inside that block are tighter
           than the gap that separates the block from the body. */
        margin: 6px 6px 4px;
        padding: 10px;
        border-radius: 8px;
        background: var(--bg-surface-light);
        color: var(--text-pri);
        overflow: hidden;
      }

      #header[hidden] {
        display: none;
      }

      /* The interactive header. The hover wash is an inset shadow rather than a
         background, so it composes with whatever the header already has —
         --bg-surface-light normally, the green accent when a card is marked
         positive — instead of each state needing its own hover colour. */
      #header[interactive] {
        cursor: pointer;
      }

      #header[interactive]:hover {
        box-shadow: inset 0 0 0 999px
          color-mix(in srgb, var(--text-pri) 5%, transparent);
      }

      /* A keyboard user has to be able to SEE the tab stop this header now
         claims. :focus-visible, not :focus, so a pointer click does not leave
         a ring behind it. */
      #header[interactive]:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      /* The only place a positive accent shows on the card. */
      #header[accent="positive"] {
        background: color-mix(in srgb, var(--green) 16%, var(--bg));
      }

      #header-main {
        box-sizing: border-box;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      /* Header text sizing/colour lives in the shared LonaCardHeader.$style
         (keyed off the h1 / p / .score tags); only layout stays here. The
         subtitle sits full-width below the title/score row (the header's 6px
         gap), so it keeps the breathing room the old callout had; it wraps via
         its max-lines clamp rather than truncating to one line. */
      #title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #score {
        flex: 0 0 auto;
      }

      #title[hidden],
      #subtitle[hidden],
      #score[hidden] {
        display: none;
      }

      /* The status strip and the action row, projected between the header and
         the body. Both take the header block's own 6px gutter so the card
         reads as one column of left edges. A slotted element that hides itself
         when empty (std-chip-row does) contributes no margin, so a card with
         nothing to report closes the gap rather than leaving a dead band.

         The vertical rhythm is 4px WITHIN the meta block and 8px below it.
         Each row carries its gap on the bottom only — no top margins — so the
         spacing between any two rows is one number rather than a sum of two,
         and a hidden row removes its gap with it. The earlier 2px/8px
         pairs summed to 8px and 10px and left the action floating in the
         middle of the card with more air around it than the header had.

         Which row is LAST is not fixed — a card may project chips and a
         menubar, either alone, or neither — so the closing gap cannot be
         pinned to a particular row. The BODY owns it instead: every meta row
         sits 4px from the next, and the body adds one further step of its
         own. That is the only way to land 8px below the block without knowing
         what the block ends with.

         A lookahead was tried first and does not work here, for a reason worth
         recording. The test has to be on the HOST, whose light-DOM children
         are the slotted elements, because :has() walks the REAL DOM tree where
         a slot element has no children whether or not anything is assigned
         (std-record-header documents that from the other side). The host does
         match such a selector — confirmed with Element.matches in the console.
         But Chrome DROPS a :host(:has(...)) rule from a constructable
         stylesheet: it never reaches the shadow root at all, so the rule is
         simply absent rather than outranked, which at a glance reads exactly
         like a specificity problem. */
      slot[name="chips"]::slotted(*) {
        display: block;
        margin: 0 6px 4px;
      }

      slot[name="menubar"]::slotted(*) {
        display: flex;
        align-items: center;
        gap: 4px;
        margin: 0 6px 4px;
      }

      /* The body's own half of its separation from the meta block. */
      slot:not([name])::slotted(*) {
        margin-top: 4px;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <div id="header" class="lona-card-header" hidden>
        <div id="header-main">
          <h1 id="title" class="max-lines-1" hidden></h1>
          <p id="score" class="score" hidden></p>
        </div>
        <p id="subtitle" class="max-lines-3" hidden></p>
      </div>
      <slot name="chips"></slot>
      <slot name="menubar"></slot>
      <slot></slot>
    </div>
  `;
}

export namespace Card {
  export interface ViewModel {
    title: Option<string>;
    subtitle: Option<string>;
    score: Option<string>;
    accent: Option<"positive">;
    selected: Option<boolean>;
    // Makes the header the card's primary action. Null leaves it inert —
    // a card whose header does nothing must not announce itself as a button.
    onHeaderClick: Option<EmptyFunction>;
  }
}
