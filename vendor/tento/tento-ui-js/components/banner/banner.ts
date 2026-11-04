// Side-effect import beside the named one, and it is load-bearing: the
// std-round tag in this template is resolved by the custom-element registry,
// which a class only joins when its module is EVALUATED. This module does
// reference Round as a value below, but that is one refactor away from being
// type-only — and the failure mode is silent (an inert tag, no surface, no
// error). See the actions modal, which was shipped broken by exactly this.
import "../round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Round } from "../round";

/** `std-banner` — a persistent condition on a surface, floated over its
 * content instead of pushing it down.
 *
 * ## Why it floats, and what floating costs
 *
 * The retired version was a flow element between the header and the thread:
 * a bordered strip that DISPLACED the transcript. Two things were wrong with
 * it. It read as a piece of the header — a permanent-looking bar welded under
 * the title, which is how a transient condition ends up looking like part of
 * the furniture. And because it displaced, the surface's whole geometry moved
 * when the engine dropped, so a session going offline reflowed every measured
 * row underneath it.
 *
 * Floating fixes both and introduces exactly one problem, which is the reason
 * this component has a callback at all: a banner over a scroll region
 * OCCLUDES the top of that region. Scroll to the top and the first row sits
 * under the banner. Nothing inside a banner can fix that, because the fix
 * belongs to the scroller — so the contract is that the banner MEASURES
 * itself and reports its height, and whoever mounts it reserves that much
 * safe area at the top of the scroll. `onHeight` is not a convenience; it is
 * the half of this component that lives in the caller.
 *
 * The height is measured rather than declared for the same reason the
 * transcript measures its rows: the text wraps at narrow widths, so any
 * constant a caller hard-codes is right at one viewport and wrong at the
 * next. A `ResizeObserver` means a banner that wraps to two lines widens the
 * safe area on the same frame.
 *
 * ## It captures clicks, deliberately
 *
 * A floating surface that let clicks fall through to the rows behind it would
 * be a thing you can see and cannot hit, and the row underneath would
 * activate from a click the reader aimed at the message. Mainstream
 * notification bars are opaque and hit-testable; so is this. At rest nothing
 * is behind it — that is what the safe area is for — so the cost is only
 * paid while scrolled. */
@component({ name: "std-banner" })
export class Banner extends LonaWebComponent {
  /** The surface, bound once. Every value is a `var()` rather than a literal
   * so the tone attribute can repaint the hairline without rebinding the
   * round — the tone selectors below repaint the dot, and the surface
   * token re-resolves on the next paint.
   *
   * `radius` MUST stay in step with `--banner-radius` in the stylesheet: the
   * round draws the shape, and that CSS radius is what clips the blur to it.
   * Two numbers, one geometry, and no way to assert it — hence this note. */
  static readonly SURFACE: Round.Props = {
    bg: "var(--banner-surface)",
    // No `border`, and that is the design rather than an omission: the
    // separation from the rows underneath comes from the blur and the drop
    // shadow, not from a hairline. An outline on a translucent surface reads
    // as a cut-out sitting ON the text; without it the banner reads as glass
    // ABOVE it, which is what a floating strip should be.
    radius: 20,
    shadow: "0 1px 2px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.16)",
  };

  private $bg: Round = this.hydrate<Round>("bg");
  private dressed: boolean = false;
  private $text: HTMLElement = this.$("text");
  private observer: Option<ResizeObserver>;
  private onHeight: Option<(px: number) => void>;
  private reported: number = -1;
  /** Nothing to say yet. A banner is CONSTRUCTED empty — the caller builds it
   * once and binds it later, sometimes much later — and an empty pill is a
   * worse artifact than no pill: it looks like a rendering bug, because it is
   * one. So the resting state is hidden and only text makes it appear. */
  private bound: boolean = false;

  static makeWith(props: Banner.Props): Banner {
    return (Banner.make() as Banner).bind(props);
  }

  bind(props: Banner.Props): this {
    this.$text.textContent = props.text;
    this.setAttribute("tone", props.tone);
    this.onHeight = props.onHeight ?? null;
    this.bound = true;
    this.observe();
    this.syncHidden();
    return this;
  }

  /** One observer per element, created lazily and RE-created after a
   * disconnect. The re-creation is the load-bearing half: these views are
   * cached and re-revealed rather than rebuilt, so a banner that stopped
   * observing when its pane was hidden would never report a height again —
   * and the safe area would silently freeze at whatever it was last time. */
  private observe(): void {
    if (this.observer != null) return;
    this.observer = new ResizeObserver(() => this.report());
    this.observer.observe(this);
  }

  /** Hidden unless it has been bound, is not suppressed by the caller, and
   * actually has something to say. */
  private syncHidden(): void {
    this.hidden = !this.bound || this.suppressed ||
      (this.$text.textContent ?? "") === "";
    this.report();
  }

  /** The height a caller must keep clear. Reported through the callback so
   * the caller owns the decision, and de-duplicated so a resize that changes
   * nothing does not churn the scroller's padding. */
  private report(): void {
    if (this.onHeight == null) return;
    const height = this.hidden ? 0 : this.offsetHeight;
    if (height === this.reported) return;
    this.reported = height;
    this.onHeight(height);
  }

  /** Hiding is a height change, and the caller has no other way to learn it:
   * a hidden banner reserves nothing. The caller's choice is recorded rather
   * than written straight to `hidden`, because it is only one of the three
   * reasons this element can be invisible — see `syncHidden`. */
  setHidden(hidden: boolean): this {
    this.suppressed = hidden;
    this.syncHidden();
    return this;
  }

  private suppressed: boolean = false;

  connectedCallback(): void {
    super.connectedCallback();
    // Once per element: the round keeps its attributes across recycling, and
    // rebinding it on every reveal would queue a re-render for no change.
    if (!this.dressed) {
      this.$bg.bind(Banner.SURFACE);
      this.dressed = true;
    }
    // Re-revealed rather than rebuilt: pick the observation back up, and
    // re-report, because the height while detached was meaningless.
    this.observe();
    this.reported = -1;
    // `syncHidden`, not `report`: the resting state has to be applied HERE
    // and not only in `bind`, because the element that reaches the screen
    // unbound is precisely the one that never called `bind`. Measured — a
    // fresh `document.createElement("std-banner")` mounted as a visible 40×22
    // empty capsule, which is what "the banner shows up as empty" is.
    this.syncHidden();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
    this.observer = null;
  }

  onRecycle(): void {
    super.onRecycle();
    this.observer?.disconnect();
    this.observer = null;
    this.onHeight = null;
    this.reported = -1;
    this.bound = false;
    this.suppressed = false;
    // A pooled element handed to the next caller must not carry the last
    // one's message: without this, a recycled banner can flash a stale
    // sentence on a surface it never described.
    this.$text.textContent = "";
    this.hidden = true;
  }

  static $styles = [
    css`
      /* Positioning lives here rather than in the caller's stylesheet: a
         banner that does not float is a different component, and leaving the
         inset to the page is how two surfaces end up disagreeing about where
         "the top" is. The mount point supplies the containing block by being
         position:relative; everything else is ours. */
      :host {
        position: absolute;
        top: var(--banner-inset-top, 8px);
        left: 0;
        right: 0;
        z-index: 3;
        /* Centred, sized to the text, and never wider than the surface it
           floats over.
           The knob is OURS (--banner-max-width) and the fallback is a plain
           length. An earlier version chained through the spool's
           --session-column, which cost a measured bug: that app sets it to
           none, so min(calc(100% - 24px), none) is an invalid value, the
           whole declaration is dropped, and a fit-content banner is then free
           to overflow its container at any narrow width. A var() fallback only
           applies when the token is UNDEFINED — a token defined to something
           nonsensical for your context is not a fallback, it is the value.
           A component reaching into an app's layout vocabulary is also the
           dependency backwards; if a caller wants its column, it sets the
           knob. */
        width: fit-content;
        max-width: min(calc(100% - 24px), var(--banner-max-width, 640px));
        /* Load-bearing, and measured: left:0 + right:0 on a box with a
           WIDTH does not centre it — the over-constrained case resolves by
           ignoring the right offset, so the banner sits flush left.
           margin-inline:auto is what distributes the leftover space. */
        margin-inline: auto;
        box-sizing: border-box;
      }
      :host([hidden]) {
        display: none;
      }

      /* The surface is std-round, not a border-radius of our own. The shape
         primitive owns the fill, the hairline and the drop shadow, so the
         banner inherits the app's continuous-corner geometry instead of
         approximating it — the same reason the actions modal reaches for it.

         What stays here is the BLUR, and it stays for a reason worth writing
         down: backdrop-filter applies to this element's own box, so it needs a
         border-radius to be clipped by, or the frosting paints as a rectangle
         behind a rounded pill. The radius below is therefore not decoration —
         it is the clip path for the blur, and it must track the radius handed
         to std-round. */
      #root {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 16px;
        border-radius: var(--banner-radius, 20px);
        /* The blur is the separation now that the hairline is gone, so it has
           to be strong enough to actually flatten the text behind it — at
           10px over an 82%-opaque fill there was nothing left to see blurring.
           Paired with the lighter fill below: the more the surface lets
           through, the more work the blur has to do. */
        backdrop-filter: blur(20px) saturate(1.4);
        -webkit-backdrop-filter: blur(20px) saturate(1.4);
      }

      /* Translucency lives in a token rather than in the JS that binds the
         round, because color-mix belongs in CSS where it is unambiguously
         supported — std-round hands its bg straight to an SVG fill, and a
         var() reference resolves there while a raw color-mix is a gamble. */
      :host {
        --banner-surface: color-mix(
          in srgb,
          var(--bg-elevated, var(--bg, #fff)) 62%,
          transparent
        );
      }

      /* A dot, drawn here rather than reached for: the status primitives in
         this repo all carry a shape vocabulary (running, done, failed) that a
         banner has no use for, and importing one to render a single circle
         would put a registration dependency in the way of six lines of CSS. */
      #dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--banner-tone, var(--text-ter, #8b93a7));
      }

      /* The ramp, not a pixel size. A banner is a fact ABOUT the surface —
         the same register as a count or an exit code — which is the job
         --caption-size names. */
      #text {
        --margin-top: 0px;
        --margin-bottom: 0px;
        /* Not monospace. Mono is for things whose CHARACTERS are the datum —
           a path, a command, an exit code. This is a sentence, and setting a
           sentence in mono makes it read as output rather than as a notice. */
        --font-size: var(--small-size);
        min-width: 0;
        color: var(--text-sec, #5c6370);
        overflow-wrap: anywhere;
      }

      /* Tone colours the DOT and nothing else. Not the text — a message you
         have to read is worst rendered in the one colour reserved for the
         thing you must not miss — and no longer the edge, because there is no
         longer an edge. */
      :host([tone="warn"]) {
        --banner-tone: var(--yellow, #d4a72c);
      }
      :host([tone="danger"]) {
        --banner-tone: var(--red, #e5484d);
      }
      :host([tone="info"]) {
        --banner-tone: var(--blue, #3b82f6);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-round id="bg" floating></std-round>
      <span id="dot"></span>
      <p class="small" id="text"></p>
    </div>
  `;
}

export namespace Banner {
  /** What the condition IS, never how loud to be about it. */
  export type Tone = "info" | "warn" | "danger";

  export type Props = {
    text: string;
    tone: Tone;
    /** Called with the height the caller must keep clear at the top of its
     * scroll region, in px, and again whenever that changes (wrap, hide).
     * See the class doc: this is the half of the banner the caller owns. */
    onHeight?: (px: number) => void;
  };
}
