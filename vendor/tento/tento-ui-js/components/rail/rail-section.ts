import "../list/list-cell-layout";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// A titled group of rows inside a rail.
//
// THE HEAD IS A ROW. It is built on `std-list-cell-layout`, the same primitive
// every row under it is built on, so a rail is one column of cells and not a
// column of cells with something else on top of it. That decides three things
// at once and re-states none of them: the inset (a cell pads its text 8px, so
// the label lands in the rows' text column by construction — this is where
// docs-nav's and acme's `margin-left: -8px` on the list went), the text box,
// and the TYPOGRAPHY, which is the register its rows are set in.
//
// That last one reverses an earlier ruling, at the operator's direction
// (2026-09-13). The register used to be docs-nav's original hand-drawn label —
// --text-8px, uppercase, 0.8px tracking — reviewed once against the sidebar as
// it had shipped and kept. What the reversal is answering is a rail read as a
// whole rather than a label read on its own: a summary title in one register
// over cells in another is two typographies in a 248px column, and the eye
// reads the mismatch before it reads either. The old register is not gone, it
// is just no longer the default — every number is still a `--rail-section-*`
// custom property, so a caller that wants small caps writes the four it wants.
//
// It is a cell that is not a CONTROL: no hover tint, no selected state, not
// focusable. A section label that lit up under the pointer would be promising
// a click it does not have.
//
// It never self-hides. An empty section shows its label over nothing — the
// region exists and is empty, which is a different fact from the region not
// existing, and a hole where a label was is indistinguishable from a failed
// render. A body that wants a group gone removes the section.

@component({ name: "std-rail-section" })
export class RailSection extends LonaWebComponent {
  private $title: HTMLElement = this.$("title");
  private $count: HTMLElement = this.$("count");

  bind(model: RailSection.Model): this {
    this.$title.textContent = model.title;
    this.setCount(model.count);
    return this;
  }

  /** The count alone, for a section that re-counts more often than it
   * re-titles. Zero is suppressed, not drawn: the region's own empty state
   * already says "nothing here", and a lone `0` beside a label reads as a
   * failed fetch. */
  setCount(count: Option<number>): void {
    const shown = count != null && count !== 0;
    this.$count.textContent = shown ? String(count) : "";
    this.$count.toggleAttribute("hidden", !shown);
  }

  onRecycle(): void {
    super.onRecycle();
    this.$title.textContent = "";
    this.setCount(null);
  }

  static makeWith(
    model: RailSection.Model,
    ...$rows: HTMLElement[]
  ): RailSection {
    const $section = RailSection.make();
    $section.bind(model);
    $section.append(...$rows);
    return $section;
  }

  static $styles = [
    css`
      /* Every default lives on :host and nowhere else. A default declared on
         #head would sit BELOW the host in the tree and beat a caller's value on
         the host element — the knob would silently stop working.

         --rail-inset is read with a fallback rather than declared here: it is
         the RAIL's property, inherited down through every section so that the
         label, the rows and the rail's own head all share one edge. Declaring
         it on :host would shadow the rail's value with this default. */
      :host {
        /* Keep the first section's 10px inset and the label-to-row gap.
           Later sections get twice the inset so groups read separately. */
        --rail-section-gap: 10px;
        --rail-section-head-gap: 8px;
        /* The register: a cell's case and the small token, with weight and
           ink carrying the difference instead, so the label still reads as
           furniture the eye skips past. A caller wanting the old small caps
           back writes all four. */
        --rail-section-size: var(--small-size);
        --rail-section-color: var(--text-ter);
        --rail-section-tracking: 0;
        --rail-section-weight: 600;
        /* The rows' case; a caller wanting the old small caps sets it. */
        --rail-section-case: none;
        display: block;
        padding-top: var(--rail-section-gap);
      }

      :host(:not(:first-of-type)) {
        padding-top: calc(2 * var(--rail-section-gap));
      }

      /* The cell's own padding, expressed in the rail's inset so a rail that
         moves its text column moves the label with it. The bottom gap is the
         head's, not the cell's — it separates the label from its rows. */
      #head {
        --list-cell-padding: 0 var(--rail-inset, 8px);
        --list-cell-layout-hover-color: transparent;
        --list-cell-selected-background-color: transparent;
        display: block;
        margin-bottom: var(--rail-section-head-gap);
        cursor: default;
      }

      #head-text {
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      #title,
      #count {
        --font-size: var(--rail-section-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--rail-section-color);
        font-weight: var(--rail-section-weight);
        letter-spacing: var(--rail-section-tracking);
      }

      #title {
        min-width: 0;
        text-transform: var(--rail-section-case);
      }

      #count {
        flex: none;
        /* Tabular figures: a count that re-renders must not shift the row it
           sits in, and the meta slot beyond it must not shuffle. */
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
      }

      #count[hidden] {
        display: none;
      }

      /* In the cell's accessory slot, which already holds it to the trailing
         edge — the margin-left: auto that did that in the hand-drawn head
         goes the same way the negative margin did. */
      #meta {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      /* A default, not a rule: ::slotted loses to any rule in the caller's own
         tree, which is the point of slotting rather than adopting. */
      ::slotted([slot="meta"]) {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      /* The -8px dies here. Rows and label share --rail-inset, so the list
         needs no correction — and a caller that still writes one is fighting
         the section, not fixing it. */
      ::slotted(std-list) {
        margin: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-list-cell-layout id="head">
      <std-row slot="content" id="head-text">
        <p id="title" class="p"></p>
        <p id="count" class="p" hidden></p>
      </std-row>
      <div slot="accessory" id="meta"><slot name="meta"></slot></div>
    </std-list-cell-layout>
    <slot></slot>
  `;
}

export namespace RailSection {
  export type Model = {
    /** The group's identity. Singular — the count carries plurality. */
    title: string;
    /** Drawn beside the title. `null` omits it, and so does `0`. */
    count: Option<number>;
  };
}
