import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";

// The identity line of a region: what this part of the page IS, how many
// things it is holding, and whatever the owner wants at the far edge.
//
// It exists because five components had each invented one and no two agreed —
// four effective sizes across a 1.4px span, two weights, three tracking
// values, three colours, three rule treatments (see the section-head plan's
// README for the table). Two of the five declared a literal `font-size`, which
// wins the size and loses the baseline-capheight margin trim the ramp applies.
//
// The register is a HEADING, on the semantic ramp: --h7-size, the smallest
// heading the scale carries. That is the whole of it — no uppercase, no
// invented letter-spacing, no raw --text-Npx reached past the ramp. Weight is
// the one axis kept, because with case and tracking gone it is what still
// separates a header from the prose under it.
//
// The first revision did the opposite: --text-9px (a pixel token, not a role),
// uppercase, 0.08em, on the argument that a header should match the size of
// the content it heads and get its prominence from case and tracking instead.
// Rejected on review — micro-caps is a label style, and a section header is a
// heading, so it should say so in the type system rather than in an effect.
// Aligning to the ramp also delivers the prominence the caps were standing in
// for: 15.3px against the loudest predecessor's 11px.
//
// Right-hand content arrives through a NAMED SLOT, not element adoption. An
// adopted element lands in this component's shadow root, where the caller's
// stylesheet cannot follow — the tax the accordion's `lead`/`meta` contract
// pays, documented in project-pane.ts, is that every such element degenerates
// into inline styles. A slotted child stays in the caller's light DOM under
// the caller's own sheet; this component contributes baseline alignment and a
// quiet default that the caller overrides normally.
//
// It never self-hides and has no empty state. A region that legitimately
// disappears when empty does so at the REGION, above this header — reserved
// space that renders nothing is not an empty region, it is a hole,
// indistinguishable from a failed render.

@component({ name: "std-section-head" })
export class SectionHead extends LonaWebComponent {
  private $title: HTMLElement = this.$("title");
  private $count: HTMLElement = this.$("count");

  bind(model: SectionHead.Model): void {
    this.$title.textContent = model.title;
    this.setCount(model.count);
  }

  /** The count alone, for a region that re-counts more often than it re-titles. */
  setCount(count: Option<number>): void {
    // Zero is suppressed, not drawn. The region's own null state already says
    // "nothing here", and a lone `0` beside a title reads as a failed fetch.
    const shown = count != null && count !== 0;
    this.$count.textContent = shown ? String(count) : "";
    this.$count.toggleAttribute("hidden", !shown);
  }

  onRecycle(): void {
    super.onRecycle();
    this.$title.textContent = "";
    this.setCount(null);
  }

  static makeWith(model: SectionHead.Model): SectionHead {
    const $head = SectionHead.make();
    $head.bind(model);
    return $head;
  }

  static $styles = [
    css`
      /* Every default lives on :host and nowhere else. A default declared on
         #root would sit BELOW the host in the tree and beat the caller's value
         on the host element — the knob would silently stop working. */
      :host {
        --section-head-size: var(--h7-size);
        --section-head-color: var(--text-pri);
        --section-head-rule: 1px solid var(--divider);
        /* Weight is a knob, not a constant. The default stays 600 — with case
           and tracking gone it is what separates a header from the prose under
           it, which is the argument above. But a caller that repeats this
           header once per group inside a dense table is stacking nine bold
           lines down one column, and there the weight is doing the opposite of
           separating. Overriding it is a layout judgement the caller is in a
           position to make and this component is not. */
        --section-head-weight: 600;
        /* One rhythm value: the inline gaps between title, count and meta, and
           the air between the row and its rule. */
        --section-head-gap: 8px;

        /* A full-width row whose whole job is putting the title at one edge and
           the meta at the other. Shrink-to-fit would collapse that arrangement
           the moment the header is dropped in a centred container. */
        display: block;
        border-bottom: var(--section-head-rule);
      }

      #root {
        display: flex;
        align-items: baseline;
        gap: var(--section-head-gap);
        padding-bottom: var(--section-head-gap);
      }

      #title {
        --font-size: var(--section-head-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-width: 0;
        font-weight: var(--section-head-weight);
        color: var(--section-head-color);
      }

      #count {
        --font-size: var(--small-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: none;
        /* Tabular figures: a count that re-renders must not shift the row it
           sits in, and the meta slot beyond it must not shuffle. */
        font-variant-numeric: tabular-nums;
        color: var(--text-ter);
      }

      #count[hidden] {
        display: none;
      }

      #meta {
        display: flex;
        align-items: baseline;
        gap: var(--section-head-gap);
        min-width: 0;
        margin-left: auto;
      }

      /* A default, not a rule: ::slotted loses to any rule in the caller's own
         tree, which is the point of slotting rather than adopting. */
      ::slotted(*) {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <p id="title"></p>
      <p id="count" hidden></p>
      <div id="meta"><slot name="meta"></slot></div>
    </div>
  `;
}

export namespace SectionHead {
  export type Model = {
    /** The region's identity. SINGULAR — the count carries plurality, so a
     * caller never branches on it to pick a word. */
    title: string;
    /** Drawn beside the title. `null` omits it, and so does `0`. */
    count: Option<number>;
  };
}
