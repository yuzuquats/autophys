import { Tracing } from "@tento-core/tracing";

import { Storybook } from "../../ui/storybook";
import { StepsParser } from "../../review-dsl/block-parsers";
import { ReviewSteps } from "./review-steps";
import { ReviewNav } from "./review-nav";

function $steps(body: string, nav: Option<ReviewNav>): HTMLElement {
  const r = StepsParser.parse(body);
  if (!r.ok) throw new Error(`fixture failed: ${r.error.message}`);
  const $el = ReviewSteps.make();
  $el.bind({ steps: r.value, nav });
  return $el;
}

const READING_ORDER = `1. tento-ui-js/review-dsl/dsl.ts — shared \`Result\` shape + line splitter; everything builds on it
2. tento-ui-js/review-dsl/graph-layout.ts — the sugiyama-lite; read \`assignRanks\` first
3. tento-ui-js/components/review-notes/review-fence.ts — the **only** integration point with ProseMirror
4. then skim the components — they're all parse → bind → SVG/DOM
5. tento-ui-js/components/commit-review/commit-note.ts:53 — the one-line dispatch hook`;

const MOCK_NAV: ReviewNav = {
  files: Promise.resolve([
    "tento-ui-js/review-dsl/dsl.ts",
    "tento-ui-js/review-dsl/graph-layout.ts",
    "tento-ui-js/components/review-notes/review-fence.ts",
    "tento-ui-js/components/commit-review/commit-note.ts",
  ]),
  onFileClick: (path) => {
    Tracing.dev("review-steps-story navigate", { path });
  },
};

export class ReviewStepsStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewSteps (std-review-steps)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With diff navigation",
        render: () => $steps(READING_ORDER, MOCK_NAV),
      },
      {
        title: "Without navigation (inert anchors)",
        render: () => $steps(READING_ORDER, null),
      },
    ];
  }
}
