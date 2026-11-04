import { Storybook } from "../../ui/storybook";
import { CompareParser } from "../../review-dsl/block-parsers";
import { ReviewCompare } from "./review-compare";

function $compare(body: string): HTMLElement {
  const r = CompareParser.parse(body);
  if (!r.ok) throw new Error(`fixture failed: ${r.error.message}`);
  const $el = ReviewCompare.make();
  $el.bind({ compare: r.value });
  return $el;
}

const CTX_SHAPES = `== before: Ctx today
{
  artifacts: Promise<Artifact[]>
}
== after: Ctx with navigation
{
  artifacts: Promise<Artifact[]>,
  nav?: {
    files: Promise<string[]>,
    onFileClick(path): void
  }
}`;

const DIVIDER_FORM = `bind(artifact)
---
bind(artifact, { fileSrc })`;

export class ReviewCompareStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewCompare (std-review-compare)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Labeled sections",
        render: () => $compare(CTX_SHAPES),
      },
      {
        title: "--- divider shorthand",
        render: () => $compare(DIVIDER_FORM),
      },
      {
        title: "Narrow paired layout",
        render: () => {
          const $el = $compare(CTX_SHAPES);
          $el.style.maxWidth = "340px";
          return $el;
        },
      },
    ];
  }
}
