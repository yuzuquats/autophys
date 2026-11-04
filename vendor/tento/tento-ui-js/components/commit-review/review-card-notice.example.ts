import { Storybook } from "../../ui/storybook";
import { Exception } from "../exception/exception";
import { $notice } from "./commit-note";

// Every way a `<std-storybook-card>` in a review note fails to become a card.
//
// This is a storybook about COPY as much as about layout. A reviewer opening a
// note is the only person who ever sees these strings, and half of them are
// composed in Rust (`harness.rs::notice_module`) where nothing renders them —
// so before this file the only way to read one was to break a card on purpose.
// Each card below calls the note's own `$notice`, not a reconstruction of it, so
// what is on screen is what ships.
//
// They are also the argument for the change that introduced them. Every one of
// these used to be a grey `<pre>` in a `div.artifact-view`: headline and detail
// concatenated into one muted paragraph, in a document that has the whole design
// system loaded.

const BUN_STDERR = `error: Could not resolve: "@tento-ui/round"
    at /Users/x/mono/tento/tento-ui-js/components/exception/exception.example.ts:3:24

error: script "build" exited with code 1`;

/** A review note's column. These are read at note width and nowhere else, and
 *  the wrapping has to survive it. */
function $inNote($el: HTMLElement): HTMLElement {
  const $host = document.createElement("div");
  $host.style.cssText = "width: 560px; max-width: 100%;";
  $host.appendChild($el);
  return $host;
}

export class ReviewCardNoticeStoryBook implements Storybook {
  title(): string {
    return "Review card notices";
  }

  tags(): string[] {
    return [];
  }

  description(): Option<string> {
    return "What a reviewer sees when a live storybook card cannot be built — the node's conditions and the note's own, on the product's error block.";
  }

  preview(): Storybook.Example {
    return this.examples()[0];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "no bundler on this host",
        render: () =>
          $inNote(
            $notice(
              "no bundler on this host",
              "Storybook cards are compiled with bun. Install it (https://bun.sh), or point $TENTO_BUN at the binary, and reload this page.",
            ),
          ),
      },
      {
        title: "the build failed",
        render: () =>
          $inNote($notice("could not build tento/exception.example.ts", BUN_STDERR)),
      },
      {
        title: "the repo is not configured",
        render: () =>
          $inNote(
            $notice(
              "repo `acme` is not configured on this host",
              "Configured repos: mono, tento. A card's example path is relative to the root of the repo its note belongs to.",
            ),
          ),
      },
      {
        title: "the card is missing an attribute",
        render: () =>
          $inNote(
            $notice(
              "std-storybook-card is missing an attribute",
              'It needs example="<path/to/x.example.ts>" and class="<StoryBook>", both relative to the repo the note belongs to.',
            ),
          ),
      },
      {
        title: "no live source behind this surface",
        render: () =>
          $inNote(
            $notice(
              "storybook example unavailable on this surface",
              "A live card is built from a checkout by the review node. This surface has no source behind it, so there is nothing to build.",
            ),
          ),
      },
      {
        title: "the import threw",
        render: () =>
          $inNote(
            Exception.fromError(
              Object.assign(new TypeError("Failed to fetch dynamically imported module"), {
                stack: `TypeError: Failed to fetch dynamically imported module
    at mountInline (commit-note.ts:352:25)
    at async ReviewStorybookView.apply (commit-note.ts:308:5)`,
              }),
            ),
          ),
      },
    ];
  }
}
