import { Storybook } from "../../ui/storybook";
import { css } from "../../component-styles";
import { Div } from "../../component-builtin";
import { Typography } from "../../ui/typography";
import { GraphGrid } from "./graph-grid";

// Storybook for the grid engine — each example is exactly one
// std-graph-grid, nothing else.
//
// The engine draws wires and labels; the boxes are the caller's, so the
// caller says how they look. That is the same theme sheet ReviewFlow and
// ReviewState pass, reduced to a plain box so the story shows the ENGINE
// rather than a flavour of it.
const NODE_THEME = css`
  .gnode {
    padding: 7px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--divider-pri, var(--divider));
    border-radius: 5px;
    /* Never wider than the container: the column budget counts boxes, so a
     * box that ignored the container could still overflow it alone. */
    max-width: min(220px, 100%);
    text-align: center;
  }

  .gnode p {
    --font-size: var(--text-8px);
    color: var(--text-pri);
  }
`;

function $node(id: string, label: string): GraphGrid.NodeSpec {
  const $el = Div.make();
  $el.className = "gnode";
  // A bare div matches nothing in the typography selector list, so its text
  // would render at whatever it inherits — the label has to BE a p.
  $el.appendChild(Typography.p(label, "small"));
  return { id, $el };
}

function edge(
  from: string,
  to: string,
  label: Option<string> = null,
  cls: Option<string> = null,
): GraphGrid.EdgeSpec {
  return { from, to, label, cls };
}

function pipeline(): {
  nodes: GraphGrid.NodeSpec[];
  edges: GraphGrid.EdgeSpec[];
  dir: "LR" | "TD";
} {
  return {
    nodes: [
      $node("src", "note markdown"),
      $node("parse", "parser"),
      $node("layout", "GraphLayout cells"),
      $node("grid", "CSS-grid boxes"),
      $node("wires", "measured wire overlay"),
    ],
    edges: [
      edge("src", "parse"),
      edge("parse", "layout", "ids + edges"),
      edge("layout", "grid", "col,row"),
      edge("grid", "wires", "getBoundingClientRect"),
      edge("parse", "wires", "labels", "dashed"),
    ],
    dir: "LR",
  };
}

function $grid(spec: {
  nodes: GraphGrid.NodeSpec[];
  edges: GraphGrid.EdgeSpec[];
  dir: "LR" | "TD";
}): HTMLElement {
  const $el = GraphGrid.make().bind({ ...spec, theme: NODE_THEME });
  // Edge labels are haloed in the colour behind them, which here is the
  // storybook card's wash rather than the page background.
  $el.style.setProperty("--graph-surface", "var(--bg-hover-opaque)");
  return $el;
}

export class GraphGridStoryBook extends Storybook.Default {
  title(): string {
    return "GraphGrid (std-graph-grid)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Layered pipeline (LR) with a long edge",
        render: () => $grid(pipeline()),
      },
      {
        title: "Backward edge detours",
        render: () =>
          $grid({
            nodes: [
              $node("q", "queued"),
              $node("s", "staged"),
              $node("d", "drained"),
            ],
            edges: [edge("q", "s"), edge("s", "d"), edge("d", "q", "conflict")],
            dir: "LR",
          }),
      },
      {
        title: "Top-down transpose",
        render: () =>
          $grid({
            nodes: [
              $node("a", "commit"),
              $node("b", "sha match?"),
              $node("c", "record attaches"),
              $node("d", "no record"),
            ],
            edges: [
              edge("a", "b"),
              edge("b", "c", "unique"),
              edge("b", "d", "ambiguous"),
            ],
            dir: "TD",
          }),
      },
      {
        title: "Narrow container flips LR to TD",
        render: () => $narrow($grid(pipeline()), 240),
      },
      {
        title: "Wide rank tiles into the container's column budget",
        render: () =>
          $narrow(
            $grid({
              nodes: [
                $node("s", "review note"),
                $node("a", "flow"),
                $node("b", "seq"),
                $node("c", "state"),
                $node("d", "callout"),
                $node("e", "compare"),
                $node("t", "rendered"),
              ],
              edges: [
                edge("s", "a"),
                edge("s", "b"),
                edge("s", "c"),
                edge("s", "d"),
                edge("s", "e"),
                edge("a", "t"),
                edge("b", "t"),
                edge("c", "t"),
                edge("d", "t"),
                edge("e", "t"),
              ],
              dir: "TD",
            }),
            260,
          ),
      },
      {
        title: "Edge labels avoid differently sized boxes",
        render: () =>
          $grid({
            nodes: [
              $node("short", "short"),
              $node("wide", "a much wider destination box with wrapping text"),
              $node("next", "next"),
            ],
            edges: [
              edge("short", "wide", "long relationship label beside the wire"),
              edge("wide", "next", "safe channel"),
              edge("next", "short", "retry", "dashed"),
            ],
            dir: "LR",
          }),
      },
    ];
  }
}

/** Pin the component to a narrow column and outline it, so the container the
 * layout is adapting TO is visible — an adaptive diagram shown at full width
 * demonstrates nothing, and the frame is drag-resizable so the re-layout can
 * be watched happening. All of it lands on the component element itself; the
 * story carries no wrapper. */
function $narrow($el: HTMLElement, width: number): HTMLElement {
  $el.style.width = `${width}px`;
  $el.style.minWidth = "120px";
  $el.style.maxWidth = "100%";
  // Drag-resizable, so the re-layout can be watched live instead of inferred.
  $el.style.resize = "horizontal";
  $el.style.outline = "1px dashed var(--divider-pri, var(--divider))";
  $el.style.outlineOffset = "4px";
  return $el;
}
