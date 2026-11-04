import { Storybook } from "../../ui/storybook";
import { Exception } from "./exception";

// Storybook for the generic error block: a red BAR stating what went wrong, and
// a code WELL under it holding the technical detail.
//
// This is what a surface reaches for when something failed and there is nowhere
// else for the news to go — a review note where a figure would have been, a
// panel whose data would not load. It owns the "this is an error" presentation;
// `<std-exception-trace>` (its own storybook) owns everything technical.
//
// The two-surface split is the thing these cards are evidence for. Message and
// stack on ONE red rectangle is what this looked like first, and a stack has no
// business being there: code wants a quiet ground and syntax colour, which a
// saturated red cannot give it. Card 2 is the case that settles it — a real bun
// diagnostic, four kinds of token, on a neutral well.
//
// Every card is at a review note's column width, because that is where these are
// actually read and it is the width the wrapping has to survive.

const BUN_STDERR = `error: Could not resolve: "@acme/tokens/color"
    at /Users/x/acme-ui/widgets/badge.example.ts:1:24

error: script "build" exited with code 1`;

const STACK = `TypeError: parameter 1 is not of type 'Node'
    at render (index.root.js:4821:12)
    at async mount (index.root.js:4790:5)`;

function $inNote($el: HTMLElement): HTMLElement {
  const $host = document.createElement("div");
  $host.style.cssText = "width: 560px; max-width: 100%;";
  $host.appendChild($el);
  return $host;
}

export class ExceptionStoryBook implements Storybook {
  title(): string {
    return "Exception (std-exception)";
  }

  tags(): string[] {
    return ["std-exception"];
  }

  description(): Option<string> {
    return "The generic error block — a red bar in the fill Toast.error uses, over a syntax-highlighted well for whatever the failure actually said.";
  }

  preview(): Storybook.Example {
    return this.examples()[0];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "message only",
        render: () =>
          $inNote(
            Exception.makeWith({ message: "storybook example unavailable on this surface" }),
          ),
      },
      {
        title: "a build failure, with the compiler's own words",
        render: () =>
          $inNote(
            Exception.makeWith({
              message: "could not build acme-ui/widgets/badge.example.ts",
              trace: { detail: BUN_STDERR },
            }),
          ),
      },
      {
        title: "a host with no bundler",
        render: () =>
          $inNote(
            Exception.makeWith({
              message: "no bundler on this host",
              trace: {
                detail:
                  "Storybook cards are compiled with bun. Install it (https://bun.sh), or point $TENTO_BUN at the binary, and reload this page.",
              },
            }),
          ),
      },
      {
        title: "a thrown Error, via fromError",
        render: () =>
          $inNote(
            Exception.fromError(
              Object.assign(new TypeError("parameter 1 is not of type 'Node'"), {
                stack: STACK,
              }),
              { filename: "index.root.js", lineno: 4821 },
            ),
          ),
      },
      {
        title: "an unreasonably long message",
        render: () =>
          $inNote(
            Exception.makeWith({
              message:
                "could not build tento-ui-js/components/commit-review/some-extremely-long-example-file-name.example.ts",
            }),
          ),
      },
    ];
  }
}
