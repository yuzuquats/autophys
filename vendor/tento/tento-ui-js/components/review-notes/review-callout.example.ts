import { Storybook } from "../../ui/storybook";
import { CalloutParser } from "../../review-dsl/block-parsers";
import { ReviewCallout } from "./review-callout";

function $callout(info: string, body: string): HTMLElement {
  const r = CalloutParser.parse(info, body);
  if (!r.ok) throw new Error(`fixture failed: ${r.error.message}`);
  const $el = ReviewCallout.make();
  $el.bind({ callout: r.value });
  return $el;
}

export class ReviewCalloutStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewCallout (std-review-callout)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "note",
        render: () =>
          $callout("note", "The serde is a module-level `Lazy` — nothing per-note may enter `buildSchema`."),
      },
      {
        title: "warning",
        render: () =>
          $callout(
            "warning behavior change",
            "Unknown fence languages now hit `ReviewFence.dispatch` before `CodeBlockView` — order matters.",
          ),
      },
      {
        title: "risk",
        render: () =>
          $callout(
            "risk recycling",
            "The fence view's `dom` is a pooled `std-col`; **never** hand it to the pool while ProseMirror still references it.",
          ),
      },
      {
        title: "decision",
        render: () =>
          $callout(
            "decision fences over tags",
            "Tag inner content is plain-text-only and dropped by the serializer — fences round-trip losslessly and degrade to code.",
          ),
      },
    ];
  }
}
