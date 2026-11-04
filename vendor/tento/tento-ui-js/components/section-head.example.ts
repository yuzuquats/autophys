import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { SectionHead } from "./section-head";

// Every card is the component itself, at a width, with nothing around it.
//
// The width is not decoration: the header is a full-width row whose whole job
// is putting the title at one edge and the meta at the other, so what it does
// at a given width IS its behaviour. 320px is the real number — the comment
// gutter is a fixed 320px in both known layouts (doc-comments-panel.ts:24), and
// it is the narrowest place this header ships. The wrapping cards below exist
// to answer the plan's one open question: whether the heading register
// survives a title plus a count plus a hint at that width.

/** The component at the gutter's real width. */
function $head(title: string, count: Option<number>): SectionHead {
  const $h = SectionHead.makeWith({ title, count });
  $h.style.width = "320px";
  return $h;
}

/** A slotted meta child. It stays in the LIGHT DOM under the caller's own
 * stylesheet — the whole reason this is a slot and not an adopted element —
 * so it is built with the ordinary Typography factory and carries no inline
 * styling of its own. */
function $meta(text: string): HTMLElement {
  const $m = Typography.small(text);
  $m.slot = "meta";
  return $m;
}

export class SectionHeadStoryBook extends Storybook.Default {
  title(): string {
    return "SectionHead (std-section-head)";
  }

  tags(): string[] {
    return ["std-section-head"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Title alone — a region holding nothing countable",
        render: () => $head("Comments", null),
      },
      {
        title: "Title and count",
        render: () => $head("Comments", 12),
      },
      {
        title: "A count wide enough to test the figures",
        render: () => $head("Members", 128),
      },
      {
        title: "Meta in the slot, pushed to the far edge",
        render: () => {
          const $h = $head("Members", 7);
          $h.appendChild($meta("3 approved"));
          return $h;
        },
      },
      {
        title: "A title long enough to wrap at 320px",
        render: () => $head("Unanchored comments", null),
      },
      {
        title: "Long title, count, and meta together — the worst case",
        render: () => {
          const $h = $head("Unanchored comments", 24);
          $h.appendChild($meta("oldest first"));
          return $h;
        },
      },
      {
        title: "Weight 600 — the default, one header over one region",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The register's own argument, rendered: with case and tracking " +
        // "gone, weight is the only thing left separating a header from the " +
        // "prose under it. This is what a caller gets without asking, and " +
        // "the shape the ux-test console's group header actually uses — no " +
        // "count, the tally in the meta slot.",
        render: () => {
          const $h = $head("calendar", null);
          $h.appendChild($meta("4 of 9 never run"));
          return $h;
        },
      },
      {
        title: "Weight 400 — the same header, nine deep in a dense table",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The card above with ONE declaration changed: " +
        // "`--section-head-weight: 400`, the value the ux-test console sets " +
        // "on every group header (ux-tests.node). Nine of these stack down " +
        // "one column of a table, where bold has stopped separating a header " +
        // "from its rows and started competing with the test names it heads. " +
        // "That is a judgement only the caller can make — which is why this " +
        // "is a knob and not a constant.",
        render: () => {
          const $h = $head("calendar", null);
          $h.style.setProperty("--section-head-weight", "400");
          $h.appendChild($meta("4 of 9 never run"));
          return $h;
        },
      },
      {
        title: "Ruleless and quieted — a header inside a framed card",
        render: () => {
          const $h = $head("scheduling-link", 4);
          $h.style.setProperty("--section-head-rule", "none");
          $h.style.setProperty("--section-head-color", "var(--text-sec)");
          return $h;
        },
      },
    ];
  }
}
