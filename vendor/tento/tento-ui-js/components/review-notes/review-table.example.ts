import { Storybook } from "../../ui/storybook";
import { TableParser } from "../../review-dsl/block-parsers";
import { ReviewTable } from "./review-table";

function $table(body: string): HTMLElement {
  const r = TableParser.parse(body);
  if (!r.ok) throw new Error(`fixture failed: ${r.error.message}`);
  const $el = ReviewTable.make();
  $el.bind({ table: r.value });
  return $el;
}

const AUTHORING_DECISION = `| option | bundle cost | failure mode | verdict |
|---|---|---|---|
| allowlisted tags | 0 | crashes the note render | inner content lossy |
| sandboxed component artifact | per-note JS | iframe boundary | too heavy for diagrams |
| * fenced code blocks | 0 | degrades to plain code | lossless, LLM-native |`;

export class ReviewTableStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewTable (std-review-table)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Decision table with chosen row",
        render: () => $table(AUTHORING_DECISION),
      },
    ];
  }
}
