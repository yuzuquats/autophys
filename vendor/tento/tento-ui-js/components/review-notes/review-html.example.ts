import { Storybook } from "../../ui/storybook";
import { ReviewHtml } from "./review-html";

// Storybook fragments are served from blob URLs — same-origin-opaque under
// the sandbox, exactly like a real artifact URL would be.
const FRAGMENT = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 13px/1.5 -apple-system, sans-serif; padding: 16px; }
  .swatch { display: inline-block; width: 48px; height: 24px; border-radius: 4px;
            margin-right: 8px; vertical-align: middle; }
</style>
<div>
  <span class="swatch" style="background:#3b82f6"></span>changed
  <span class="swatch" style="background:#22c55e"></span>new
  <span class="swatch" style="background:#ef4444"></span>removed
</div>`;

function fragmentArtifacts(name: string): ReviewHtml.Props {
  const src = URL.createObjectURL(new Blob([FRAGMENT], { type: "text/html" }));
  return {
    artifacts: Promise.resolve([
      { name, kind: "html", src, url: null, caption: null, text: null },
    ]),
  };
}

function $reviewHtml(attrs: Record<string, string>, props: ReviewHtml.Props): ReviewHtml {
  const $el = ReviewHtml.make();
  for (const [key, value] of Object.entries(attrs)) $el.setAttribute(key, value);
  $el.bind(props);
  return $el;
}

export class ReviewHtmlStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewHtml (std-review-html)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Framed figure",
        render: () =>
          $reviewHtml(
            { src: "palette.html", title: "the status palette", height: "160" },
            fragmentArtifacts("palette.html"),
          ),
      },
      {
        title: "Unknown src fails loud",
        render: () =>
          $reviewHtml({ src: "missing.html" }, fragmentArtifacts("palette.html")),
      },
    ];
  }
}
