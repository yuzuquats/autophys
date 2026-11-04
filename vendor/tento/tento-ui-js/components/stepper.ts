import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Typography } from "../ui/typography";

// A numbered stepper: markers chained by a rail, each with a title and an
// optional body. `std-stepper` is the COLUMN — a checklist. `std-stepper-
// horizontal`, at the bottom of this file, is the ROW a wizard's progress
// header wants.
//
// TWO COMPONENTS, ONE VOCABULARY. The row began as `orientation: "horizontal"`
// on this component, and it was wrong in a way worth recording. An axis is not
// a variant: every knob the column exposes is named for the column's geometry,
// so on the row half of them meant something else and the rest meant nothing.
// `--step-spacing` is the gap BELOW a step in a column and between cells in a
// row; `--step-gap` is marker-to-content sideways in one and marker-to-title
// downwards in the other. A caller who moved one got an answer from the wrong
// axis. What the two genuinely share is the step MODEL and the mark's drawing,
// and those are shared here as functions and stylesheets rather than as a flag.
//
// The rail geometry in `STEPPER_GEOMETRY` below stays vertical, and stays
// shared with the accordion's `stepper` variant — a disclosure list that can
// only ever run downwards. The row overrides it from its own sheet at id
// specificity rather than putting a second axis in there for every accordion
// to carry.
//
// Three components had built this independently and no two agreed on a
// number — 16px, 20px and 28px markers; a literal `9px` number, `--text-8px`
// and `--text-12px`; and, in one of them, no rail at all. Only one of the
// three DERIVED its geometry, and that is the one this file is extracted
// from: `accordion.ts`'s `stepper` variant, whose own comment records that
// the derivation replaced "hand-tuned 23px/36px/-12px/44px constants".
//
// The whole geometry is four numbers:
//
//   --step-marker-size   the circle
//   --step-pad-x/-y      the circle's inset from the item box
//   --step-rail-width    the chain between circles
//   --step-gap           marker → content
//
// Everything else — where the rail starts, where it stops, how far the
// content is indented — is computed from them, so a caller retunes the
// stepper by moving ONE of them and nothing drifts out from under the rest.
// That is the property the three hand-rolled copies each lost in a different
// place, and it is why `GEOMETRY` below is exported: the accordion's stepper
// variant is a disclosure list, not this component, but it is the same
// geometry and must not be a second copy of it.
//
// This component is the NON-disclosure flavour: static numbered steps, no
// header button, no collapse. A step list whose items open and close is an
// accordion in `stepper` variant, and giving static instructions a
// `role="button"` and a collapse affordance nobody asked for is the reason
// this is a separate component rather than a preset of that one.

/** The shared geometry: the marker column, the rail that chains it, and the
 * content indent that clears it. Written against `.step-item` / `.step-marker`
 * / `.step-body` so a component with its own markup can opt in by adding
 * those classes — which is exactly what the accordion's stepper variant does.
 *
 * A consumer sets the four `--step-*` inputs and declares nothing else about
 * the column. Anything it DOES re-declare must beat these selectors, so keep
 * consumer overrides at higher specificity (the accordion's are under
 * `#root.stepper`) or the two will fight in a way that only shows up at one
 * particular marker size. */
export const STEPPER_GEOMETRY = css`
  .step-item {
    position: relative;
    padding-bottom: var(--step-spacing, 18px);
  }

  .step-item:last-child {
    padding-bottom: 0px;
  }

  /* The rail runs from the bottom edge of this marker to the top edge of the
     next one — both ends are the marker's own geometry, so it meets the
     circles instead of stopping a few pixels short. Its own width is halved
     out of the centre line.

     The bottom is the negative of the TOP INSET, not of the spacing: the next
     item's marker begins --step-pad-y below ITS box top, and this item's box
     ends where that one begins. Writing the spacing here instead is what
     leaves a gap that grows every time someone changes the item gap. */
  .step-item:not(:last-child)::before {
    content: "";
    position: absolute;
    left: calc(
      var(--step-pad-x, 0px) + var(--step-marker-size, 20px) / 2 -
        var(--step-rail-width, 2px) / 2
    );
    top: calc(var(--step-pad-y, 0px) + var(--step-marker-size, 20px));
    bottom: calc(-1 * var(--step-pad-y, 0px));
    width: var(--step-rail-width, 2px);
    background: var(--step-rail-color, var(--divider));
  }

  /* A discontinuity in the sequence, not a gap in the drawing: the rail below
     this step is dashed rather than solid, which is how a truncated list says
     "and more, off the end" without inventing a row to say it in. */
  .step-item[data-rail="dashed"]::before {
    background: repeating-linear-gradient(
      to bottom,
      var(--step-rail-color, var(--divider)) 0px 2px,
      transparent 2px 5px
    );
  }

  .step-item[data-rail="none"]::before {
    display: none;
  }

  /* The mark's PLACEMENT box, whatever the mark turns out to be. It is the
     column's width and it exists even when the step draws no mark at all — a
     continuation row still has to leave the column open under it, and the rail
     above it still has to stop where a mark would have started. */
  .step-mark {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--step-marker-size, 20px);
    height: var(--step-marker-size, 20px);
  }

  .step-marker {
    /* The number is sized through the ramp, never with a literal: the ramp
       trims its block margins to the cap box, and that trim is what centres
       the digit in the circle. A literal font-size wins the size and loses
       the trim, which is how one of the three copies ended up with its number
       sitting low. */
    --font-size: var(--step-marker-font-size, var(--text-8px));
    --line-height-ratio: 1;
    --margin-top: 0px;
    --margin-bottom: 0px;
    min-height: unset;
    position: relative;
    z-index: 1;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--step-marker-size, 20px);
    height: var(--step-marker-size, 20px);
    margin: 0px;
    box-sizing: border-box;
    border: var(--step-marker-border, 1px solid var(--divider));
    border-radius: 999px;
    background: var(--step-marker-bg, var(--bg));
    color: var(--step-marker-color, var(--text-sec));
    font-weight: var(--step-marker-weight, 400);
    /* Tabular figures: step 9 → 10 must not shift the column it sits in. */
    font-variant-numeric: tabular-nums;
  }

  /* Content hangs under the title, clear of the marker column. */
  .step-body {
    padding-left: calc(
      var(--step-pad-x, 0px) + var(--step-marker-size, 20px) +
        var(--step-gap, 8px)
    );
  }
`;

/** Everything both axes share: the knob defaults, the list reset, the head
 * row, the mark, the selection chrome, and the type on title, meta and body.
 * Neither component owns it, because neither is the other's special case. */
const STEPPER_BASE = css`
  /* Every default lives on :host and nowhere else. A default declared on
     #root would sit BELOW the host in the tree and beat the caller's value
     on the host element — the knob would silently stop working. */
  :host {
    --step-marker-size: 20px;
    --step-marker-font-size: var(--text-8px);
    --step-marker-color: var(--text-sec);
    --step-marker-bg: var(--bg);
    --step-marker-border: 1px solid var(--divider);
    --step-rail-width: 2px;
    --step-rail-color: var(--divider);
    --step-gap: 8px;
    --step-spacing: 18px;
    --step-body-gap: 4px;
    --step-mark-align: flex-start;
    /* No inset of its own: a bare list starts at its container's edge, and
       the accordion — which DOES inset, for its header's hit area — sets
       this to its own padding. */
    --step-pad-x: 0px;
    --step-pad-y: 0px;
    --step-pad-right: var(--step-pad-x);

    display: block;
  }

  /* A numbered step list IS an ordered list, so it is one — the marketing
     page this replaces had real ol/li semantics and must not lose them.
     The cost is that the typography ramp matches a bare OL (it is in the
     ramp's selector list, and the ramp is injected into EVERY shadow
     root), which would hand the container a negative trim margin computed
     for prose and shift the whole column up. The three resets below are
     what turn that off; without them the stepper hangs a few pixels above
     wherever it was put, and the amount changes with the theme's font. */
  #root {
    --margin-top: 0px;
    --margin-bottom: 0px;
    min-height: unset;
    list-style: none;
    margin: 0px;
    padding: 0px;
    display: flex;
  }

  /* The marker stays at the top so a title long enough to wrap keeps the
     number beside its FIRST line rather than floating to the middle; the
     title centres on the marker instead. Nothing here touches the title's
     type — a typography component already trims its margin box to its cap
     box, so centring it lands it dead centre with no measuring at all. */
  .step-head {
    display: flex;
    align-items: flex-start;
    gap: var(--step-gap, 8px);
    min-height: var(--step-row-height, auto);
    border-radius: var(--step-row-radius, 5px);
    /* The RIGHT inset is its own knob. The left one is geometry — the rail
       is derived from it — while the right one is only breathing room, and
       a selectable row needs it: without it the trailing meta sits flat
       against the edge of its own hover background. */
    padding: var(--step-pad-y, 0px)
      var(--step-pad-right, var(--step-pad-x, 0px)) var(--step-pad-y, 0px)
      var(--step-pad-x, 0px);
  }

  /* The mark holds the top of the row so a wrapping title keeps its mark
     beside the FIRST line; a single-line row centres instead, which is
     what a dense list of one-line rows wants. */
  .step-mark {
    align-self: var(--step-mark-align, flex-start);
  }

  /* Selection chrome, and it is opt-in: a step with no key is inert and
     must not offer a pointer or light up under one. */
  .step-item[data-key] > .step-head {
    cursor: pointer;
  }

  .step-item[data-key]:hover > .step-head {
    background: var(--step-row-hover-bg, var(--bg-hover-light));
  }

  .step-item.current > .step-head {
    background: var(--step-row-current-bg, var(--bg-hover));
  }

  .step-item.current .step-title {
    font-weight: 600;
  }

  /* A step that is history rather than ahead of the reader. In a COLUMN only
     the title quiets: the list is long, and the mark carries meaning the title
     does not repeat, so dimming it would quiet the part still saying
     something. The row register overrides this and dims the mark too, for the
     opposite reason — see the note beside that rule. */
  .step-item.muted .step-title {
    color: var(--step-title-muted-color, var(--text-ter));
  }

  .step-meta {
    --font-size: var(--step-meta-size, var(--small-size));
    --line-height-ratio: 1.1;
    --margin-top: 0px;
    --margin-bottom: 0px;
    min-height: unset;
    flex: none;
    margin-left: auto;
    /* Centred with the TITLE, not with the mark. The mark holds the top of
       the row so a wrapping title keeps its number beside the first line;
       the meta is part of the title's line and follows it. Left on the
       mark's alignment it sat a couple of pixels high, because a 9.7px cap
       box top-aligned in a 12px row is not where the eye puts it. */
    align-self: var(--step-meta-align, center);
    color: var(--step-meta-color, var(--text-ter));
  }

  .step-title {
    --font-size: var(--step-title-size, var(--p-size));
    --line-height-ratio: var(--step-title-leading, 1.3);
    --margin-top: 0px;
    --margin-bottom: 0px;
    min-height: unset;
    min-width: 0px;
    flex: 1;
    align-self: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: var(--step-title-wrap, normal);
    color: var(--step-title-color, var(--text-pri));
  }

  .step-head:focus-visible { outline: 2px solid var(--accent, #007aff); outline-offset: 2px; }

  .step-body {
    padding-top: var(--step-body-gap, 4px);
  }

  .step-body-text {
    --font-size: var(--step-body-size, var(--small-size));
    /* The title next to it has had a leading knob all along; this one was a
       literal, so a consumer that wanted a tighter evidence line had to reach
       into the shadow tree, which it cannot. Same default. */
    --line-height-ratio: var(--step-body-leading, 1.5);
    --margin-top: 0px;
    --margin-bottom: 0px;
    min-height: unset;
    /* A measure, not a width: prose past ~55 characters stops being
       scannable, and the marketing register is the one that gets wide
       enough to need saying so. */
    max-width: var(--step-body-measure, none);
    color: var(--step-body-color, var(--text-sec));
  }
`;

/** The column's one line. Everything else about running downwards is
 * `STEPPER_GEOMETRY`, which the accordion shares. */
const STEPPER_VERTICAL = css`
  #root {
    flex-direction: column;
  }
`;

@component({ name: "std-stepper" })
export class Stepper extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  /** Set by the owner: a step carrying a key was clicked. Steps without a key
   * are inert — they render, they just do not answer. */
  private selectionCallback: Option<(key: string) => void> = null;
  get onSelect(): Option<(key: string) => void> { return this.selectionCallback; }
  set onSelect(callback: Option<(key: string) => void>) {
    this.selectionCallback = callback;
    updateSelectable(this.$root, callback != null);
  }

  onRecycle(): void {
    this.onSelect = null;
    this.$root.replaceChildren();
    super.onRecycle();
  }

  constructor() {
    super();
    wireSelect(this.$root, this);
  }

  bind(model: Stepper.Model): void {
    // Element marks and element metas are SLOTTED, not adopted, so they stay
    // in the caller's light DOM under the caller's own stylesheet. This is the
    // section-head lesson, and it is not cosmetic here: the commit-review
    // medallions get their fill and stroke from a rule in THEIR component, and
    // the handle links get their hover from another — adopt them into this
    // shadow root and both arrive unstyled, silently.
    //
    // The caller does not have to know: it hands over an element, and the
    // slot name is bookkeeping done here.
    renderSteps(this, this.$root, model);
    updateSelectable(this.$root, this.onSelect != null);
  }

  static makeWith(model: Stepper.Model): Stepper {
    const $s = Stepper.make();
    $s.bind(model);
    return $s;
  }

  static $styles = [STEPPER_BASE, STEPPER_VERTICAL, STEPPER_GEOMETRY];

  // `role="list"` is not redundant: `list-style: none` drops the implicit list
  // role in Safari, which is the one browser where the semantics this markup
  // exists for would silently disappear.
  static $html: Option<HTMLTemplateElement> = html`
    <ol id="root" role="list"></ol>
  `;
}

/* ---------------------------------------------------------------------------
   The row.

   Everything below overrides STEPPER_GEOMETRY, which is written for a column
   and is shared with the accordion. The overrides sit at id specificity
   (`#root ...`) so they win regardless of which stylesheet the browser lands
   last — the constraint that made this a set of `#root[data-orientation]`
   rules when the two axes were one component, and the reason it survives the
   split unchanged.
   --------------------------------------------------------------------------- */
const STEPPER_HORIZONTAL = css`
  /* ---------------------------------------------------------------
     Horizontal: the same steps turned onto the other axis.

     Scoped under the root id so it beats the shared geometry's class
     selectors regardless of which stylesheet lands last. Nothing below is a
     new number — the row is built from the same four inputs as the column.
     --------------------------------------------------------------- */
  #root {
    flex-direction: row;
  }

  /* Equal cells, so the marks sit on a regular pitch and every rail segment
     between them is one length. The zero min-width lets a long label
     ellipsis rather than forcing the row wider than its container. */
  #root > .step-item {
    flex: 1 1 0px;
    min-width: 0px;
    padding-bottom: 0px;
  }

  /* Mark above title, both centred on the cell. */
  /* Mark above title. The drop between them is the row's own knob and its own
     number: 4px was inherited from the column, where --step-gap is a SIDEWAYS
     distance from a circle to the text beside it and 4px is generous. Stacked,
     the same 4px puts a title's cap box almost against the circle's bottom
     edge, and the pair reads as one smudged glyph rather than as a mark with a
     label under it. */
  #root .step-head {
    flex-direction: column;
    align-items: center;
    gap: var(--step-gap-horizontal, 8px);
  }

  #root .step-mark {
    align-self: center;
  }

  #root .step-title {
    flex: none;
    text-align: center;
    max-width: 100%;
  }

  #root .step-meta {
    margin-left: 0px;
    align-self: center;
  }

  /* The body loses the marker-column indent: there is no column to clear
     when the mark sits above the title rather than beside it. */
  #root .step-body {
    padding-left: 0px;
    text-align: center;
  }

  /* The rail turns with the layout — it leaves this mark's right edge and
     stops at the next mark's left edge, so both ends are still the marker's
     own geometry. The -50% works because the cells are equal width: the
     next mark's centre is exactly half a cell past this box's right edge. */
  #root > .step-item:not(:last-child)::before {
    left: calc(50% + var(--step-marker-size, 20px) / 2);
    right: calc(-50% + var(--step-marker-size, 20px) / 2);
    top: calc(
      var(--step-pad-y, 0px) + var(--step-marker-size, 20px) / 2 -
        var(--step-rail-width, 2px) / 2
    );
    bottom: auto;
    width: auto;
    height: var(--step-rail-width, 2px);
  }

  /* The current step, as a header says it rather than as a list says it.

     The column fills the whole row behind the step being read, which is what a
     selectable list wants and is exactly wrong here: a grey rectangle behind
     one cell of four reads as a stuck hover, not as "you are here". A header
     has one mark per cell and the mark is the thing to say it on, so the fill
     is cancelled and the circle takes the emphasis instead. The title's weight
     comes from the shared sheet and is left alone — it is the half of the
     column's treatment that does translate. */
  #root > .step-item.current > .step-head {
    background: none;
  }

  #root > .step-item.current .step-marker {
    border: var(--step-marker-border-current, 2px solid var(--blue));
    color: var(--step-marker-color-current, var(--blue));
    font-weight: 600;
    /* Off by default. A lift on the current mark is one of the two registers a
       header can use to say "here" — the other is the ring above — and which
       one suits depends on whether the row sits on its own ground or on a card
       that is already lifted. Left to the caller rather than picked here. */
    box-shadow: var(--step-marker-shadow-current, none);
  }

  /* A muted step in a header dims its MARK as well as its title.

     The column deliberately does not: there, muted is a long list of history
     and the mark carries meaning the title does not repeat, so dimming it
     would quiet the one part still saying something. A header is four cells
     wide and every mark is a bare digit or a tick — the mark repeats what the
     title says rather than adding to it, so leaving it bright is the whole row
     shouting while the labels whisper. Opacity rather than a colour, so a
     toned mark keeps its hue as it quiets and a green tick stays a green tick.

     This applies to the mark BOX, so it reaches an element mark the caller
     brought as readily as the stepper's own circle. */
  #root > .step-item.muted .step-mark {
    opacity: var(--step-mark-muted-opacity, 0.4);
  }

  #root > .step-item[data-rail="dashed"]::before {
    background: repeating-linear-gradient(
      to right,
      var(--step-rail-color, var(--divider)) 0px 2px,
      transparent 2px 5px
    );
  }
`;

/** The stepper's row register: a wizard's progress header, where the question
 * is "how far along am I" rather than "what is on the list".
 *
 * Same `Stepper.Model`, same per-step vocabulary — `marker` and `tone` mark
 * what is done, `current` marks what is being read, `railAfter: "dashed"` is
 * still a discontinuity. What it does NOT share is the column's knob meanings:
 * cells are equal width and the mark sits above its title, so `--step-gap` is
 * the drop from mark to title here rather than the sideways gap to a body, and
 * the body loses the marker-column indent because there is no column to clear.
 *
 * A step's `body` still renders, centred under its title. It is rarely what a
 * header wants — four cells of prose is a paragraph laid out in columns — but
 * refusing to draw it would be this component deciding how much a wizard is
 * allowed to say. */
@component({ name: "std-stepper-horizontal" })
export class StepperHorizontal extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  /** Set by the owner: a step carrying a key was clicked. Steps without a key
   * are inert — they render, they just do not answer. */
  private selectionCallback: Option<(key: string) => void> = null;
  get onSelect(): Option<(key: string) => void> { return this.selectionCallback; }
  set onSelect(callback: Option<(key: string) => void>) {
    this.selectionCallback = callback;
    updateSelectable(this.$root, callback != null);
  }

  onRecycle(): void {
    this.onSelect = null;
    this.$root.replaceChildren();
    super.onRecycle();
  }

  constructor() {
    super();
    wireSelect(this.$root, this);
  }

  bind(model: Stepper.Model): void {
    renderSteps(this, this.$root, model);
    updateSelectable(this.$root, this.onSelect != null);
  }

  static makeWith(model: Stepper.Model): StepperHorizontal {
    const $s = StepperHorizontal.make();
    $s.bind(model);
    return $s;
  }

  static $styles = [STEPPER_BASE, STEPPER_HORIZONTAL, STEPPER_GEOMETRY];

  // `role="list"` is not redundant: `list-style: none` drops the implicit list
  // role in Safari, which is the one browser where the semantics this markup
  // exists for would silently disappear.
  static $html: Option<HTMLTemplateElement> = html`
    <ol id="root" role="list"></ol>
  `;
}

/* ------------------------------------------------------------------------
   Shared between the column and the row.

   Both components draw the same step from the same model — the mark, the
   title, the trailing meta, the body — and differ only in the sheet that
   arranges them. These live at module scope rather than as statics on either
   class so neither is the other's base: the row is not a kind of column, and
   inheriting one from the other would put the column's knobs back in the row's
   API through the back door.
   ------------------------------------------------------------------------ */

/** Delegation on the list, not a handler per row: the list is rebuilt on every
 * bind, and per-row handlers would have to be rebuilt with it. */
function wireSelect(
  $root: HTMLElement,
  owner: { onSelect: Option<(key: string) => void> },
): void {
  $root.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    if (target.closest('a[href], input, button, select, textarea') != null) return;
    const action = target.closest<HTMLElement>('.step-head[role=button]');
    const key = action?.closest<HTMLElement>('.step-item[data-key]')?.dataset.key;
    if (key == null || action?.getAttribute("aria-disabled") === "true" || owner.onSelect == null) return;
    event.preventDefault(); event.stopPropagation(); owner.onSelect(key);
  });
  GESTURE_MANAGER.addPointerEvent($root, {
    onClick: (_captured, _offset, event) => {
      const $target = event.target as HTMLElement;
      // Trailing content may be a link of its own; let its href do the
      // navigating rather than reporting the row underneath it.
      if ($target.closest<HTMLElement>("a[href], [aria-disabled=true], [data-disabled]") != null) return;
      const key = $target.closest<HTMLElement>(".step-item[data-key]")?.dataset
        .key;
      if (key != null) owner.onSelect?.(key);
    },
  });
}

function updateSelectable(root: HTMLElement, interactive: boolean): void {
  for (const item of root.querySelectorAll<HTMLElement>('.step-item')) {
    const head = item.querySelector<HTMLElement>('.step-head');
    if (head == null) continue;
    const enabled = interactive && item.dataset.key != null && !item.hasAttribute('data-disabled');
    head.tabIndex = enabled ? 0 : -1;
    if (interactive && item.dataset.key != null) {
      head.setAttribute('role', 'button');
      head.setAttribute('aria-disabled', String(!enabled));
    } else { head.removeAttribute('role'); head.removeAttribute('aria-disabled'); }
  }
}

/** Build the steps into `$root`, parking any element marks and metas in
 * `$host`'s light DOM. Element content is SLOTTED rather than adopted so it
 * stays under the caller's own stylesheet — see the note on `slotFor`. */
function renderSteps(
  $host: HTMLElement,
  $root: HTMLElement,
  model: Stepper.Model,
): void {
  const slotted: Element[] = [];
  const $items = model.steps.map((step, i) => $stepItem(step, i, slotted));
  $host.replaceChildren(...slotted);
  $root.replaceChildren(...$items);
}

/** One step: the marker, its title on the marker's line, whatever trails at
 * the row's end, and the body indented under all of it. Pure — no `this`, so
 * what a step LOOKS like is readable without the component around it. */
function $stepItem(
  step: Stepper.Step,
  index: number,
  slotted: Element[],
): HTMLElement {
  const $item = document.createElement("li");
  $item.className = "step-item";
  if (step.current) { $item.classList.add("current"); $item.setAttribute("aria-current", "step"); }
  if (step.disabled) $item.setAttribute("data-disabled", "");
  if (step.muted) $item.classList.add("muted");
  if (step.railAfter !== "solid") $item.dataset.rail = step.railAfter;
  if (step.key != null) $item.dataset.key = step.key;

  const $head = document.createElement("div");
  $head.className = "step-head";
  $head.append(
    $markOf(step, index, slotted),
    $titleOf(step.title),
  );
  if (step.meta != null) {
    $head.appendChild($metaOf(step.meta, index, slotted));
  }
  $item.appendChild($head);

  if (step.body != null) {
    const $body = document.createElement("div");
    $body.className = "step-body";
    $body.appendChild($bodyOf(step.body));
    $item.appendChild($body);
  }
  return $item;
}

/** The marker splits the same way the title does, and it matters more here.
 *
 * A STRING is the stepper's own numbered circle — the ordinary case, and the
 * one the geometry's `.step-marker` styles end to end.
 *
 * An ELEMENT is the caller's own mark, and it gets a placement box and
 * nothing else: no circle, no border, no fill. A commit graph's medallion
 * already encodes its kind in its silhouette and its state in its colour, and
 * drawing a stepper circle around it would be a second, contradictory shape.
 * `null` renders no mark at all — the rail above still stops where the mark
 * would have been, which is what a continuation row wants. */
function $markOf(
  step: Stepper.Step,
  index: number,
  slotted: Element[],
): HTMLElement {
  const $box = document.createElement("div");
  $box.className = "step-mark";
  if (step.marker == null) return $box;
  if (typeof step.marker !== "string") {
    $box.appendChild(slotFor(step.marker, `mark-${index}`, slotted));
    return $box;
  }
  const $marker = Typography.p(step.marker === "" ? String(index + 1) : step.marker);
  $marker.className = "step-marker";
  if (step.tone != null) {
    // The tone fills the circle, so the number has to leave the outlined
    // register with it — a tertiary digit on a filled ground is the one
    // combination that reads as broken rather than as a variant.
    $marker.style.setProperty("--step-marker-bg", step.tone);
    $marker.style.setProperty("--step-marker-border", "none");
    $marker.style.setProperty("--step-marker-color", "var(--bg)");
  }
  $box.appendChild($marker);
  return $box;
}

function $metaOf(
  meta: Stepper.Content,
  index: number,
  slotted: Element[],
): HTMLElement {
  if (typeof meta !== "string") {
    const $slot = slotFor(meta, `meta-${index}`, slotted);
    $slot.className = "step-meta";
    return $slot;
  }
  const $m = Typography.p(meta);
  $m.className = "step-meta";
  return $m;
}

/** A title handed over as an ELEMENT is the caller's own typography
 * component: it arrives sized and trimmed, and this only gives it its place
 * on the marker's line. Restyling it from here is not this component's
 * business, and could not reach it reliably anyway — it lands in this shadow
 * root while its stylesheet stays behind in the caller's. (The accordion
 * documents the same contract for the same reason.) */
function $titleOf(title: Stepper.Content): HTMLElement {
  if (typeof title !== "string") {
    title.classList.add("step-title");
    return title;
  }
  const $t = Typography.p(title);
  $t.className = "step-title";
  return $t;
}

function $bodyOf(body: Stepper.Content): HTMLElement {
  if (typeof body !== "string") {
    body.classList.add("step-body-text");
    return body;
  }
  const $b = Typography.p(body);
  $b.className = "step-body-text";
  return $b;
}

/** Park `$el` in the host's light DOM under `name`, and hand back the slot
 * that pulls it into place. Two objects, one call, because forgetting either
 * half renders nothing at all. */
function slotFor($el: Element, name: string, slotted: Element[]): HTMLElement {
  $el.slot = name;
  slotted.push($el);
  const $slot = document.createElement("slot");
  $slot.name = name;
  // A <slot> is display:contents by default, so it contributes no box of its
  // own — the flex line would lay out the slotted child directly, and the
  // meta's `margin-left: auto` would have nothing to apply to. Giving the slot
  // a box is what keeps the row's arrangement the row's business.
  $slot.style.display = "inline-flex";
  $slot.style.alignItems = "center";
  return $slot as unknown as HTMLElement;
}

export namespace Stepper {
  /** A string gets the stepper's own typography; an element is the caller's
   * own typography component, placed as-is. Same split the accordion makes,
   * and for the same reason. */
  export type Content = string | HTMLElement;

  /** A mark is broader than Content on purpose: the commit-review medallions
   * are `SVGSVGElement`, and a marker is placed rather than typeset, so it has
   * no reason to be restricted to HTML. */
  export type Mark = string | Element;

  /** The rail BELOW a step. `dashed` is a discontinuity — the sequence
   * continues somewhere this list is not showing. `none` breaks it outright. */
  export type Rail = "solid" | "dashed" | "none";

  export type Step = {
    disabled?: Option<boolean>;
    /** The step's line, beside its marker. */
    title: Content;
    /** Detail under the title, indented clear of the marker column. */
    body: Option<Content>;
    /** A STRING is the stepper's own numbered circle — empty means "use the
     * 1-based index", anything else replaces it. An ELEMENT is the caller's own
     * mark, placed in the column with no circle drawn around it. `null` draws
     * no mark and keeps the column open. */
    marker: Option<Mark>;
    /** Trailing content at the row's far end — a handle, a timestamp, a count. */
    meta: Option<Content>;
    /** Fills this step's circle (a colour or any background value). Null leaves
     * it on the outlined default. Ignored for an element marker, which brings
     * its own colour. */
    tone: Option<string>;
    /** The step the reader is on. */
    current: boolean;
    /** History rather than ahead of the reader — the title quiets, the mark
     * does not. */
    muted: boolean;
    /** The rail below this step. */
    railAfter: Rail;
    /** Selectable; the id handed back through `onSelect`. Null is inert. */
    key: Option<string>;
  };

  /** The row register, reached as `Stepper.Horizontal` because that is how a
   * caller thinks of it — the same stepper, turned. It is a sibling component
   * rather than a subclass; see the note at the top of this file for why an
   * axis is not a variant. */
  export const Horizontal = StepperHorizontal;
  export type Horizontal = StepperHorizontal;

  /** Read by both components. The steps are the whole model — which way they
   * run is which component you reached for, not a field. */
  export type Model = {
    steps: Step[];
  };

  /** A step that is only its line — the ordinary case, so the ordinary case
   * does not have to spell out seven nulls. */
  export function plain(title: Content, body: Option<Content>): Step {
    return {
      title,
      body,
      marker: "",
      meta: null,
      tone: null,
      current: false,
      muted: false,
      railAfter: "solid",
      key: null,
    };
  }
}
