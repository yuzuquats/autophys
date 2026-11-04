import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { StateParser } from "../../review-dsl/state-parser";
import { Typography } from "../../ui/typography";
import { GraphGrid } from "./graph-grid";
import { GraphRenderer } from "./graph-renderer";

// State-machine diagram for review notes (```review-state, mermaid
// stateDiagram-v2 subset). DOM-first on the shared grid renderer, top-down;
// `[*]` renders as the filled start dot / ringed end dot; `::new` transitions
// get the green treatment and `::removed` ones dashed red — lifecycle changes
// are a classic source of review bugs, so the delta is the point.

@component({ name: "std-review-state" })
export class ReviewState extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  bind({ machine }: ReviewState.Props): void {
    this.$root.replaceChildren(ReviewState.$diagram(machine));
  }

  static $styles = [
    css`
      :host {
        display: block;
        /* Take the column's width instead of hugging the diagram: under a
         * shrink-to-fit parent (the storybook card's centered flex slot) an
         * auto width reports a container as wide as the content, so the
         * layout never learns it has to adapt and the card scrolls instead. */
        width: 100%;
        box-sizing: border-box;
        margin-block: 16px;
        overflow-x: auto;
      }
    `,
  ];

  /** How this diagram's states and transitions look. The engine renders into
   * its own shadow root, so these rules travel with the spec instead of
   * sitting in the stylesheet above, where they could no longer reach. */
  static $diagramStyle = css`
      .state {
        padding: 7px 12px;
        background: var(--bg-elevated);
        border: 1px solid var(--divider-pri, var(--divider));
        border-radius: 7px;
        max-width: min(220px, 100%);
        text-align: center;
        overflow-wrap: anywhere;
      }

      .state p {
        --font-size: var(--text-8px);
        color: var(--text-pri);
        white-space: normal;
      }

      .state.st-changed {
        color: var(--fg-blue);
      }

      .state.st-new {
        color: var(--fg-green);
      }

      .state.st-removed {
        color: var(--fg-red);
      }

      .state.st-changed,
      .state.st-new,
      .state.st-removed {
        border-color: currentColor;
        background: color-mix(in srgb, currentColor 9%, var(--bg-elevated));
      }

      .pseudo {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-sec);
      }

      .pseudo.end {
        background: none;
        border: 1.5px solid var(--text-sec);
        display: grid;
        place-items: center;
        width: 12px;
        height: 12px;
      }

      .pseudo.end::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-sec);
      }

      .wire.tr-new {
        stroke: var(--fg-green);
      }

      .wire.tr-removed {
        stroke: var(--fg-red);
        stroke-dasharray: 4 3;
      }

      .wire.tr-changed {
        stroke: var(--fg-blue);
      }

      .wire-label.tr-new {
        color: var(--fg-green);
      }

      .wire-label.tr-removed {
        color: var(--fg-red);
      }

      .wire-label.tr-changed {
        color: var(--fg-blue);
      }
    `;

  static $html = html`<div id="root"></div>`;
}

export namespace ReviewState {
  export type Props = { machine: StateParser.Machine };

  export function $diagram(machine: StateParser.Machine): HTMLElement {
    const nodes = machine.states.map((s) => {
      if (s.pseudo != null) {
        const $dot = document.createElement("div");
        $dot.className = `pseudo ${s.pseudo}`;
        return { id: s.id, $el: $dot };
      }
      const $el = document.createElement("div");
      $el.className = s.status == null ? "state" : `state st-${s.status}`;
      $el.appendChild(Typography.p(s.label, "small"));
      return { id: s.id, $el };
    });
    const edges = machine.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      label: t.label ?? null,
      cls: t.status == null ? null : `tr-${t.status}`,
    }));
    const renderer = GraphRenderer.current() ?? GraphGrid.renderer;
    return renderer.$render({
      nodes,
      edges,
      dir: "TD",
      theme: ReviewState.$diagramStyle,
    });
  }
}
