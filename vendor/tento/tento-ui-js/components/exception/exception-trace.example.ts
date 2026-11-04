import { Storybook } from "../../ui/storybook";
import { Toast } from "../toast/toast";
import { ExceptionTrace } from "./exception-trace";

// Storybook for the technical half of a failure, on its own.
//
// The property worth checking in these cards is a NEGATIVE one: the trace paints
// no surface. No background, no border, no colour of its own. That is what lets
// the same markup sit inside a `Toast.error` — already a red field with its own
// title — without nesting one error block inside another.
//
// So every card places it on a host that supplies the surface, and the first two
// use opposite palettes deliberately. If the trace ever grows a background, the
// light card is where it will show.
//
// The same constraint drives the highlighting. A component that does not know
// what it is sitting on cannot reach for `--fg-syntax-*` — green-on-red is not a
// colour scheme — so the token classes default to mixes of the HOST's own
// colour, and a host with a neutral surface overrides them. These cards are the
// check on the default half of that: no card here sets `--exc-*`, so what you
// see is the currentColor fallback surviving a red field and a light panel.

const STACK = `TypeError: parameter 1 is not of type 'Node'
    at render (index.root.js:4821:12)
    at async mount (index.root.js:4790:5)`;

const BUN_STDERR = `error: Could not resolve: "@acme/tokens/color"
    at /Users/x/acme-ui/widgets/badge.example.ts:1:24

error: script "build" exited with code 1`;

/** A REAL `Toast.error`, not an imitation of one.
 *
 * These cards exist to prove the trace inherits its host's palette, which an
 * approximation cannot prove: the first version of this file hand-rolled a red
 * `div` with its own title, and it drifted — wrong text colour token, wrong
 * title face, a size the toast never uses — so the card was evidence about a
 * box that does not exist in the product. `Toast.makeWith` builds the element
 * without showing it, so the storybook can put the real one on the page. */
function $onToast(p: ExceptionTrace.Props, title: string): HTMLElement {
  const $host = document.createElement("div");
  $host.style.cssText = "width: 360px; max-width: 100%;";
  $host.appendChild(
    Toast.makeWith({
      title,
      variant: "error",
      options: { description: ExceptionTrace.makeWith(p), showClose: false },
    }),
  );
  return $host;
}

/** A plain light surface — the palette the toast is not. */
function $onPlain(p: ExceptionTrace.Props): HTMLElement {
  const $host = document.createElement("div");
  $host.style.cssText =
    "width: 560px; max-width: 100%; border: 1px solid var(--divider); border-radius: 8px;" +
    "padding: 12px; color: var(--text-sec);";
  $host.appendChild(ExceptionTrace.makeWith(p));
  return $host;
}

export class ExceptionTraceStoryBook implements Storybook {
  title(): string {
    return "ExceptionTrace (std-exception-trace)";
  }

  tags(): string[] {
    return ["std-exception-trace"];
  }

  description(): Option<string> {
    return "The technical half of a failure, with no surface of its own — so it reads on a red toast and on a plain panel without carrying error chrome into either.";
  }

  preview(): Storybook.Example {
    return this.examples()[0];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "a thrown Error, on a toast",
        render: () =>
          $onToast(
            { stack: STACK, filename: "index.root.js", lineno: 4821 },
            "TypeError: parameter 1 is not of type 'Node'",
          ),
      },
      {
        title: "the same trace, on a plain surface",
        render: () => $onPlain({ stack: STACK, filename: "index.root.js", lineno: 4821 }),
      },
      {
        title: "an unhandled rejection — the case that rendered blank",
        render: () => $onToast({ detail: "sync aborted: token expired" }, "Promise Rejection"),
      },
      {
        title: "a compiler diagnostic",
        render: () => $onPlain({ detail: BUN_STDERR }),
      },
      {
        title: "a location with no stack",
        render: () => $onPlain({ filename: "sheets/src/plugins/index.ts", lineno: 39 }),
      },
      {
        title: "nothing at all",
        render: () => $onPlain({}),
      },
    ];
  }
}
