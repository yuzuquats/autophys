import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// A small, non-interactive chip: one short label carrying a tone. The shared
// extraction of the per-item state strips that had been hand-rolled per surface
// (market-research's `.ad-badge` processing states, the stack log's `.chip`).
//
// **The tone is carried by the chip's FILL; the mark only says which state.**
// One silhouette for every chip — the same 3px/8px box on a 7px radius that
// tento-torrent's `.d-dest` uses — and the two families differ by what fills it:
//
//   a FACT about a thing — `webp`, a destination, a category — takes the
//   neutral surface fill and no mark, because there is no state to report.
//
//   a STATE of a thing — a pipeline step, a transfer — takes a fill tinted with
//   that state's hue, plus a bare glyph in the matching foreground colour.
//
// The glyphs are STROKES, not badges: a tick, an arc, three dots, a bang, a
// cross, each drawn in a 24 box at stroke-width 2.2 with round caps, and none
// of them carries a disc. An earlier cut used the shared `icons/status-*.svg`
// set, whose whole grammar is a filled or hollow RING — which put a second
// round, filled shape inside a round, filled chip, two nested capsules deep, so
// the mark competed with the box that contained it instead of labelling it.
// Dropping the ring is what frees the fill to carry the tone.
//
// Distinguishing by SHAPE and not only by hue is why the glyphs are drawn here
// rather than tinted from one shape: tick, arc, dots, bang and cross are told
// apart without colour vision, at a size where a ring could only ever be a hue.
//
// The glyphs are inlined into the template rather than built per instance
// through `LonaIcons.make`: the tone attribute switches which paths paint, so a
// grid carrying a few hundred chips clones one static subtree per chip instead
// of running icon construction per chip.
//
// It is NOT `std-badge` (the absolutely-positioned dot/count that rides an
// avatar's corner), NOT `std-pill-button` (interactive, themable, pink by
// default), and NOT `std-status-mark` — that one is sized for a rail row (a
// 20px box around an 8px glyph) and speaks its own grammar of
// progress/done/error over a painted squircle. A chip is a fact about the
// thing it sits on: it never takes a click.
@component({ name: "std-chip" })
export class Chip extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");

  static makeWith(vm: Chip.ViewModel): Chip {
    return Chip.make().bind(vm);
  }

  bind(vm: Chip.ViewModel): this {
    this.$label.textContent = vm.label;
    this.setAttribute("tone", vm.tone);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.$label.textContent = "";
    this.removeAttribute("tone");
  }

  static $styles = [
    Typography.$style,
    css`
      /* One shared silhouette for every tone, matching Tento Media's live
         neutral pill: 2px 9px padding, 8px radius, and 11px text at normal line
         height. The host and label pin those type metrics, bypassing
         Typography's cap-height .small ramp.

         Because the fill carries the tone, padding and radius never vary by
         tone. A mixed strip keeps one wrapping silhouette; only colours move.

         The 13px state mark plus 4px vertical padding sets the shared 17px
         minimum. Normal text may grow beyond that minimum. */
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--chip-gap, 5px);
        box-sizing: border-box;
        font-size: var(--chip-font-size, 11px);
        line-height: normal;
        min-height: calc(var(--chip-mark-size, 13px) + 4px);
        padding: 2px 9px;
        border-radius: 8px;
        background: var(--chip-bg, var(--bg-surface));
        color: var(--chip-color, var(--text-sec));
        white-space: nowrap;
      }

      /* Muted drops the fill: a chip that is present but asserting nothing
         recedes to plain text. It keeps the padding so a strip of mixed facts
         stays evenly spaced. */
      :host([tone="muted"]) {
        --chip-bg: transparent;
        --chip-color: var(--text-ter);
      }

      /* The glyph box. 13px against an 8px cap height: the strokes are drawn
         inside y 6.5–17.5 of the 24 box, so the mark's optical height is ~6px
         and it sits under the cap line rather than towering over it. */
      #mark {
        display: none;
        flex: 0 0 auto;
        width: var(--chip-mark-size, 13px);
        height: var(--chip-mark-size, 13px);
        color: var(--chip-mark);
      }

      :host([tone="done"]) #mark,
      :host([tone="running"]) #mark,
      :host([tone="pending"]) #mark,
      :host([tone="attention"]) #mark,
      :host([tone="failed"]) #mark {
        display: block;
      }

      /* Geometry shared by all five glyphs, so a tone only switches which parts
         paint. Stroke-width 2.2 in a 24 box at 13px resolves to ~1.19px, which
         is the stem weight of the 11.1px label beside it — mark and text then
         read as one line rather than as an icon with a caption. */
      #stroke {
        display: none;
        fill: none;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      /* The bang's dot and pending's three dots are the only FILLED shapes, so
         they sit outside #stroke — which sets fill:none for the four stroked
         glyphs and would have erased them. An earlier cut put the dot inside
         it and shipped an exclamation mark with no point. */
      #dots,
      #bangdot {
        display: none;
        fill: currentColor;
      }

      #tick,
      #arc,
      #bang,
      #cross {
        display: none;
      }

      /* THE TONE COLOURS. Four hues, one construction each, both measured
         against the real page rather than reasoned about.

         The FILL is the hue at an alpha over whatever is behind — never a mix
         into a named surface. That is the same construction --bg-surface
         itself uses (12% black in light, 12% white in dark), and it is what
         makes one declaration correct in both colour schemes and on both
         grounds a chip actually sits on: the page, and the lighter card. A mix
         into --bg would have been opaque, and would have cut a page-coloured
         rectangle out of every card it landed on.

         The alphas are per-hue and per-scheme because they are calibrated to
         one thing: each state fill carries the SAME TINT WEIGHT as the neutral
         chip beside it, so a state never reads as fainter or heavier than a
         fact. Matching that by eye fails badly, because the pastels differ in
         luminance far more than they look like they do — orange needs 52% in
         light where green needs 31% to land on the same 1.32:1 against white.
         Each number below is the sweep's best fit against the neutral chip
         (light target 1.315:1, dark 1.453:1), not a round number chosen first.

         The MARK is the hue mixed 50/50 with --text-pri. That is the --fg-*
         family's construction (which is 72/28) pushed one step further toward
         the text colour, for a stated reason: --fg-* is tuned to be read on
         the PAGE, and these glyphs are read on a tint of their own hue, which
         is a much closer ground. At 72/28 attention measured 2.46:1 — under
         the 3:1 non-text bar and fainter than the grey of "not started", which
         inverts the priority the scale exists to express. At 50/50 the four
         land at 4.69 / 4.56 / 3.56 / 4.44 in light and 7.01 / 7.23 / 8.53 /
         7.14 in dark. Light is the binding case; dark has room to spare.

         Writing it as one formula over --chip-hue is deliberate: a tone below
         states its hue and its two alphas and nothing else, so the relations
         that must hold across tones cannot drift apart tone by tone. */
      :host([tone="done"]),
      :host([tone="running"]),
      :host([tone="attention"]),
      :host([tone="failed"]) {
        --chip-mark: color-mix(in srgb, var(--chip-hue) 50%, var(--text-pri));
        --chip-bg: light-dark(
          color-mix(in srgb, var(--chip-hue) var(--chip-tint), transparent),
          color-mix(in srgb, var(--chip-hue) var(--chip-tint-dark), transparent)
        );
      }

      :host([tone="done"]) {
        --chip-hue: var(--green);
        --chip-tint: 31%;
        --chip-tint-dark: 21%;
      }

      :host([tone="running"]) {
        --chip-hue: var(--blue);
        --chip-tint: 33%;
        --chip-tint-dark: 20%;
      }

      :host([tone="attention"]) {
        --chip-hue: var(--orange);
        --chip-tint: 52%;
        --chip-tint-dark: 16%;
      }

      :host([tone="failed"]) {
        --chip-hue: var(--red);
        --chip-tint: 33%;
        --chip-tint-dark: 21%;
      }

      /* pending is the one state that keeps the NEUTRAL fill. Nothing has
         happened yet, so nothing about it is coloured — giving it a hue would
         spend the tinted-fill signal on the only state with nothing to report.
         Its dots are --text-ter pushed 20% toward --text-pri: on the page
         --text-ter clears 3:1, but the neutral fill lifts the ground under it
         and plain --text-ter measured 2.70:1 there. 80/20 restores it to
         3.57:1 light / 5.46:1 dark without making "not started" as loud as
         the label it sits beside. */
      :host([tone="pending"]) {
        --chip-mark: color-mix(in srgb, var(--text-ter) 80%, var(--text-pri));
      }

      :host([tone="done"]) #stroke,
      :host([tone="done"]) #tick,
      :host([tone="running"]) #stroke,
      :host([tone="running"]) #arc,
      :host([tone="attention"]) #stroke,
      :host([tone="attention"]) #bang,
      :host([tone="attention"]) #bangdot,
      :host([tone="failed"]) #stroke,
      :host([tone="failed"]) #cross,
      :host([tone="pending"]) #dots {
        display: block;
      }

      /* Inherit the host's exact 11px text size and normal line-height.
         font: inherit bypasses Typography's cap-height .small derivation.
         The GTM/campaigns surface can scale its root; this text stays physical. */
      #label {
        margin: 0;
        font: inherit;
      }
    `,
  ];

  // Every glyph is drawn inside the same optical square (y 6.5 to 17.5 of 24),
  // so switching tones never shifts the label or changes the mark's weight.
  static $html: Option<HTMLTemplateElement> = html`
    <svg id="mark" viewBox="0 0 24 24" aria-hidden="true">
      <g id="stroke">
        <path id="tick" d="M5.5 12.4L10 16.9L18.5 7.1"></path>
        <path id="arc" d="M12 5.5A6.5 6.5 0 1 1 6.9 8"></path>
        <path id="bang" d="M12 6.4V12.9"></path>
        <path id="cross" d="M7.4 7.4L16.6 16.6M16.6 7.4L7.4 16.6"></path>
      </g>
      <circle id="bangdot" cx="12" cy="16.9" r="1.35"></circle>
      <g id="dots">
        <circle cx="5.6" cy="12" r="1.9"></circle>
        <circle cx="12" cy="12" r="1.9"></circle>
        <circle cx="18.4" cy="12" r="1.9"></circle>
      </g>
    </svg>
    <span id="label" class="small"></span>
  `;
}

export namespace Chip {
  // Two families, and the family decides what fills the box.
  //
  // Facts describe the thing: they take the neutral surface, and adding one to
  // a strip should not make the strip look more urgent.
  //
  // States say where the thing stands. They are the five tento-torrent already
  // draws, under the names this library uses them by — `attention` is torrent's
  // `paused` slot, for something that ran but against an input that has since
  // moved.
  export type Tone =
    | "neutral"
    | "muted"
    | "done"
    | "running"
    | "pending"
    | "attention"
    | "failed";

  export interface ViewModel {
    label: string;
    tone: Tone;
  }
}
