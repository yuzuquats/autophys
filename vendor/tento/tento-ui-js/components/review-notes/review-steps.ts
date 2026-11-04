import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { Accordion } from "../accordion";
import { StepsParser } from "../../review-dsl/block-parsers";
import { NotesInline } from "./notes-inline";
import { ReviewNav } from "./review-nav";

// Step-through review walkthrough — a reading order for the diff, authored as
//   ```review-steps
//   1. tento-ui-js/review-dsl/dsl.ts — the shared Result shape
//   2. then the fence dispatch wires it in
//   ```
// A leading path-like token becomes the step's file anchor (a chip; wired to
// diff navigation once the page provides it — inert until then).

@component({ name: "std-review-steps" })
export class ReviewSteps extends LonaWebComponent {
  private $list: HTMLElement = this.$("list");

  bind({ steps, nav }: ReviewSteps.Props): void {
    const items = steps.steps.map((step, i): Accordion.Item => ({
      header: ReviewSteps.$title(step.anchor ?? `Step ${i + 1}`),
      marker: String(i + 1),
      content: ReviewSteps.Step.makeWith(step, nav),
    }));
    this.$list.replaceChildren(
      Accordion.makeWith({
        variant: "stepper",
        items,
        expandedIndexes: items.map((_, i) => i),
      }),
    );
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        box-sizing: border-box;
        margin-block: 16px;
        /* Accordion layout knobs inherit through every shadow boundary. Stop
         * an ancestor accordion's density tuning here so this component's
         * stepper can resolve its own internally consistent preset. The initial
         * makes the custom property invalid, which activates var()'s fallback;
         * a caller targeting this host directly can still override it. */
        --accordion-header-padding: initial;
        --accordion-content-padding: initial;
        /* Padding is deliberately NOT set here: the stepper's own preset
         * derives the marker column, the rail, and the content indent from
         * one set of numbers, and overriding half of it from outside is what
         * pulls the rail off the circles. */
      }
    `,
  ];

  static $html = html`<div id="list"></div>`;
}

export namespace ReviewSteps {
  export type Props = { steps: StepsParser.Steps; nav: Option<ReviewNav> };

  /** The step's title, as a typography component. It goes into the
   * Accordion's shadow root, so it has to arrive already sized — hence
   * --font-size set here, on our own element, rather than a rule of ours the
   * Accordion would have to apply for us. */
  export function $title(text: string): HTMLElement {
    const $el = Typography.p(text);
    $el.style.setProperty("--font-size", "var(--text-10px)");
    return $el;
  }

  /** One step's body, as its own component. Accordion item content is moved
   * into the Accordion's shadow root, where ReviewSteps' stylesheet cannot
   * reach it — and the Accordion must not reach down into caller content
   * either (a descendant rule there retunes whole subtrees other callers
   * pass in). An element that brings its own shadow root and its own styles
   * sidesteps the whole question: it looks the same wherever it is put. */
  @component({ name: "std-review-step" })
  export class Step extends LonaWebComponent {
    private $text: HTMLElement = this.$("text");
    private $open: HTMLElement = this.$("open");

    static makeWith(step: StepsParser.Step, nav: Option<ReviewNav>): Step {
      return Step.make().bind(step, nav);
    }

    bind(step: StepsParser.Step, nav: Option<ReviewNav>): this {
      this.$text.replaceChildren(NotesInline.$format(step.body));
      if (step.anchor == null) {
        this.$open.style.display = "none";
        return this;
      }
      this.$open.style.display = "";
      ReviewNav.link(this.$open, step.anchor, nav);
      return this;
    }

    static $styles = [
      Typography.$style,
      css`
        :host {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          min-width: 0;
          color: var(--text-pri);
        }

        #text {
          --font-size: var(--small-size);
          --line-height-ratio: 1.6;
          --margin-top: 0px;
          --margin-bottom: 0px;
          min-height: unset;
        }

        #open {
          font-family: var(--mono, ui-monospace, monospace);
          /* A step lower than its own prose: it is the affordance, not the
           * point. Left at the inherited size it rendered at the UA default
           * — bigger than everything around it. */
          --font-size: var(--text-8px);
          color: var(--text-sec);
          background: var(--bg-surface, rgba(128, 128, 128, 0.12));
          padding: 1px 4px;
          border-radius: 3px;
          overflow-wrap: anywhere;
        }
      `,
    ];

    // `code` is not in the typography selector list — without `.small` it
    // matches no sizing rule at all and falls back to the UA default.
    static $html = html`
      <p id="text"></p>
      <code id="open" class="small">Open in diff</code>
    `;
  }
}
