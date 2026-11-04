import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { FlowParser } from "../../review-dsl/flow-parser";
import { Typography } from "../../ui/typography";
import { GraphGrid } from "./graph-grid";
import { GraphRenderer } from "./graph-renderer";

// Box-and-arrow flow diagram for review notes, authored as a ```review-flow
// fence (mermaid flowchart subset — see FlowParser). DOM-first: nodes are
// real elements in a CSS grid (typography-sized, no text measurement), the
// connector overlay routes from measured boxes. Drawing goes through the
// GraphRenderer seam (GraphGrid by default — container-adaptive: LR re-lays
// out top-down when the column is too narrow). Semantic node statuses
// (changed/new/removed) tint what this commit touched — the review-specific
// part.

@component({ name: "std-review-flow" })
export class ReviewFlow extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  bind({ graph }: ReviewFlow.Props): void {
    this.$root.replaceChildren(ReviewFlow.$diagram(graph));
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

  /** How this diagram's boxes look. The engine renders into its own shadow
   * root, so these rules travel with the spec instead of sitting in the
   * stylesheet above, where they could no longer reach the nodes. */
  static $diagramStyle = css`
      .node {
        position: relative;
        padding: 7px 12px;
        background: var(--bg-elevated);
        border: 1px solid var(--divider-pri, var(--divider));
        border-radius: 5px;
        max-width: min(220px, 100%);
        text-align: center;
      }

      .node p {
        --font-size: var(--text-8px);
        color: var(--text-pri);
        /* The parser turns a label's br tag into a newline; honor it so a
           multi-line label wraps where the author wrote the break. */
        white-space: pre-line;
      }

      .node.shape-rounded {
        border-radius: 999px;
        padding-inline: 14px;
      }

      .node.shape-decision {
        border: none;
        padding: 9px 26px;
        clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%);
        background: color-mix(in srgb, var(--text-ter) 14%, var(--bg-elevated));
      }

      .node.st-changed {
        color: var(--fg-blue);
      }

      .node.st-new {
        color: var(--fg-green);
      }

      .node.st-removed {
        color: var(--fg-red);
      }

      .node.st-changed,
      .node.st-new,
      .node.st-removed {
        border-color: currentColor;
        background: color-mix(in srgb, currentColor 9%, var(--bg-elevated));
      }

      .node.st-changed.shape-decision,
      .node.st-new.shape-decision,
      .node.st-removed.shape-decision {
        background: color-mix(in srgb, currentColor 16%, var(--bg-elevated));
      }

      .node.st-removed {
        border-style: dashed;
      }

      .node.st-removed p {
        color: var(--text-sec);
      }
    `;

  static $html = html`<div id="root"></div>`;
}

export namespace ReviewFlow {
  export type Props = { graph: FlowParser.Graph };

  export function $diagram(graph: FlowParser.Graph): HTMLElement {
    const nodes = graph.nodes.map((n) => {
      const $el = document.createElement("div");
      $el.className = n.status == null ? "node" : `node st-${n.status}`;
      $el.classList.add(`shape-${n.shape}`);
      $el.appendChild(Typography.p(n.label, "small"));
      return { id: n.id, $el };
    });
    const edges = graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label ?? null,
      cls: e.dashed ? "dashed" : null,
    }));
    const renderer = GraphRenderer.current() ?? GraphGrid.renderer;
    return renderer.$render({
      nodes,
      edges,
      dir: graph.dir,
      theme: ReviewFlow.$diagramStyle,
    });
  }
}
