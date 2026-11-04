import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { CompareParser } from "../../review-dsl/block-parsers";

// Before/after comparison panel — the semantic delta a diff can't show
// (payload shapes, configs, type signatures), authored as
//   ```review-compare
//   == before: LonaApi
//   fetchRows(cb)
//   == after: RowClient
//   await rows.list()
//   ```
//
// Design: two sibling cards rather than one box split by a full-height
// gutter. The gutter's job was to say "these two are a pair going one way",
// but a 34px rule running the height of the block is louder than either
// panel and reads as a wall between them. The pairing is carried instead by
// the signed, tinted headers — red minus for the old shape, green plus for
// the new — which is the same vocabulary the diff pane already uses, so the
// direction is legible without spending any structure on it. Panels are
// equal-width and independently bordered; stacking them in a narrow column
// then costs nothing and loses nothing.

@component({ name: "std-review-compare" })
export class ReviewCompare extends LonaWebComponent {
  private $before: HTMLElement = this.$("before");
  private $after: HTMLElement = this.$("after");

  bind({ compare }: ReviewCompare.Props): void {
    ReviewCompare.bindPanel(this.$before, compare.before);
    ReviewCompare.bindPanel(this.$after, compare.after);
  }

  static $styles = [
    Typography.$style,
    css(`
      :host {
        display: block;
        margin-block: 16px;
        /* inline-size containment makes the host's own content contribute
         * nothing to its width, so under a shrink-to-fit parent — the
         * storybook card's centered flex slot — an auto width resolves to
         * ZERO and the whole panel collapses to a hairline. Give the
         * container query a real width to answer against. */
        width: 100%;
        box-sizing: border-box;
        container-type: inline-size;
      }

      .pair {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        align-items: start;
      }

      .panel {
        min-width: 0;
        border: 1px solid var(--divider);
        border-radius: 8px;
        overflow: hidden;
        background: var(--bg-elevated);
      }

      .head {
        display: flex;
        /* Cap-height boxes mean the text box IS the glyph box, so centring is
         * exact — no baseline fudge needed to line the sign up with the word. */
        align-items: center;
        gap: 7px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--divider);
        /* Tinted by the panel's own colour so the direction is readable at a
         * glance without a separator element carrying it. */
        background: color-mix(in srgb, currentColor 8%, transparent);
      }

      #before {
        color: var(--fg-red);
      }

      #after {
        color: var(--fg-green);
      }

      /* Both are <p>: a div/span matches nothing in the typography selector
       * list, so --font-size on it is inert and the label silently renders at
       * whatever it inherits — which is what made these read so large. */
      .head p {
        --font-size: var(--text-8px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
      }

      .sign {
        font-family: var(--mono, ui-monospace, monospace);
        font-weight: 700;
      }

      .phase {
        font-weight: 700;
        color: currentColor;
      }

      /* The author's own words for each side. Below the code rather than in
       * the header: it is context for what you just read, and in the header
       * it competed with the phase for the same line. */
      .caption {
        --font-size: var(--text-7px);
        color: var(--text-sec);
        padding: 6px 10px;
        border-top: 1px solid var(--divider);
        min-width: 0;
        overflow-wrap: anywhere;
        /* Centred under the block it describes. The cap-height box is exactly
         * the glyph box, so the 6px above and below are the space you see. */
        text-align: center;
      }

      .caption:empty {
        display: none;
      }

      pre {
        margin: 0;
        padding: 9px 10px;
        --font-size: var(--text-8px);
        --line-height-ratio: 1.55;
        ${Typography.codeBlockRule}
        color: var(--text-pri);
        background: var(--bg);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      /* One column is not enough for two panels of code side by side: stack
       * them, and the tinted signed headers still read as one pair. */
      @container (max-width: 460px) {
        .pair {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `),
  ];

  static $html = html`
    <div class="pair">
      <div class="panel" id="before">
        <div class="head"><p class="sign">−</p><p class="phase">Before</p></div>
        <pre></pre>
        <p class="caption"></p>
      </div>
      <div class="panel" id="after">
        <div class="head"><p class="sign">+</p><p class="phase">After</p></div>
        <pre></pre>
        <p class="caption"></p>
      </div>
    </div>
  `;
}

export namespace ReviewCompare {
  export type Props = { compare: CompareParser.Compare };

  export function bindPanel(
    $panel: HTMLElement,
    panel: CompareParser.Panel,
  ): void {
    const $caption = $panel.querySelector(".caption");
    // The parser defaults an unlabelled section to "before"/"after", which the
    // phase already says — leave the caption empty rather than say it twice.
    const generic = panel.label === "before" || panel.label === "after";
    if ($caption != null) $caption.textContent = generic ? "" : panel.label;
    const $pre = $panel.querySelector("pre");
    if ($pre != null) $pre.textContent = panel.text;
  }
}
