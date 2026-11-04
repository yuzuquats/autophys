import { Storybook } from "../../ui/storybook";
import { FlowParser } from "../../review-dsl/flow-parser";
import { ReviewFlow } from "./review-flow";

// Fixtures are authored exactly as an agent would write them in a
// ```review-flow fence — the storybook renders what the note renders.

function $flow(src: string): HTMLElement {
  const r = FlowParser.parse(src);
  if (!r.ok) throw new Error(`fixture failed: line ${r.error.line}: ${r.error.message}`);
  const $el = ReviewFlow.make();
  $el.bind({ graph: r.value });
  return $el;
}

const PIPELINE = `flowchart LR
  note[note markdown] --> pm[ProseMirror parse]
  pm --> cb{code_block?}
  cb -->|review-*| fence[ReviewFence.dispatch]
  cb -->|other| code[std-code]
  fence -->|parse ok| grid[DOM-grid diagram]
  fence -.->|parse error| code
  class fence,grid new`;

const STATUSES = `flowchart LR
  page[review page] --> old[LonaApi shim]
  page --> client[RowClient]
  client --> net[network.ts]
  old -.-> net
  class client changed
  class net new
  class old removed`;

const FANOUT = `flowchart TD
  note[review note] --> flow[review-flow]
  note --> seq[review-seq]
  note --> state[review-state]
  note --> callout[review-callout]
  note --> compare[review-compare]
  flow --> doc[rendered note]
  seq --> doc
  state --> doc
  callout --> doc
  compare --> doc`;

const TOPDOWN = `flowchart TD
  queued[set queued] --> staged{stage clean?}
  staged -->|yes| drained[drained to master]
  staged -->|no| conflict[conflict report]
  conflict --> queued`;

export class ReviewFlowStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewFlow (std-review-flow)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Note-render pipeline (LR, statuses)",
        render: () => $flow(PIPELINE),
      },
      {
        title: "Changed / new / removed statuses",
        render: () => $flow(STATUSES),
      },
      {
        title: "Top-down with decision + cycle",
        render: () => $flow(TOPDOWN),
      },
      {
        title: "Narrow column adapts (LR flips top-down)",
        render: () => $narrow($flow(PIPELINE)),
      },
      {
        title: "Narrow column adapts (wide rank tiles down)",
        render: () => $narrow($flow(FANOUT)),
      },
    ];
  }
}

/** Pin the component to a note-column width, outline it so the container it
 * is adapting to is visible, and make that frame DRAG-RESIZABLE so the
 * adaptation can be watched happening rather than inferred from a still.
 * `resize` needs a non-visible overflow, which the component already sets.
 * Every style lands on the component element itself — the story carries no
 * wrapper. */
function $narrow($el: HTMLElement): HTMLElement {
  $el.style.width = "260px";
  $el.style.minWidth = "120px";
  $el.style.maxWidth = "100%";
  $el.style.resize = "horizontal";
  $el.style.outline = "1px dashed var(--divider-pri, var(--divider))";
  $el.style.outlineOffset = "4px";
  return $el;
}
