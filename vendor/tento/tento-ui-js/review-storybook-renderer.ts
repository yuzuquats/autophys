// How tento renders a storybook card in a review note.
//
// This used to be a Handlebars template compiled into the commit-review binary,
// which meant the binary imported `@tento-ui/*` and could therefore only ever
// serve a tento checkout. It is now an ordinary module in this repo, named by
// `tento/.commit-review/harness.toml`, and the binary knows nothing about it
// beyond the `render(root, subject)` contract.
//
// Being a real file rather than a template, it type-checks: it sits inside this
// tsconfig's `include`, so a rename in `ui/storybook.ts` breaks here at
// `ts check` time instead of inside a bundler subprocess at review time.
//
// It renders through the REAL `std-storybook-card` and its shell rather than a
// hand-rolled title/section reimplementation, so the embedded preview matches
// how the app renders a storybook — Round card, Typography labels, footer, the
// multi-example expand affordance. One card per example keeps every case
// visible inline.
import { initFastdom } from "@tento-ui/fastdom.global";
import { initDomUtils } from "@tento-ui/dom.global";
import { initHtmlElement } from "@tento-ui/init/html-element.global";
import "@tento-ui/ui/storybook";
import { Style } from "@tento-ui/component-styles";
import { Storybook } from "@tento-ui/ui/storybook";
import { Typography } from "@tento-ui/ui/typography";

/** What the generated entry hands over. Structural on purpose — the binary
 *  owns this shape, and duplicating it here keeps the renderer from importing
 *  anything the harness would have to provide. */
type Subject = {
  module: Record<string, unknown>;
  export: string;
  value: unknown;
  source: string;
  repo: string;
  ctx: { src(sibling: string): string; attrs: Record<string, string> };
};

export default {
  async render(root: HTMLElement, subject: Subject): Promise<void> {
    // The three storage-free globals every LonaWebComponent assumes. All are
    // idempotent (a `globalThis` flag + early return), which is what lets the
    // same bundle mount inline in the app document as well as in the sandbox.
    initHtmlElement();
    initFastdom();
    initDomUtils();

    // An example's rows live in the light DOM — slotted, never inside a
    // shadow root — so their paragraphs are typeset by the PAGE, and an app
    // page gets that from theme-base.css. The sandbox page carries only its
    // tokens, so without this a list row's <p> keeps the browser's 1em
    // margins and renders twice as tall as it does in the app.
    if (!document.head.querySelector("style[data-review-typography]")) {
      const $typography = Style.makeWith(Typography.$style);
      $typography.setAttribute("data-review-typography", "");
      document.head.append($typography);
    }

    if (typeof subject.value !== "function") {
      throw new Error(
        `${subject.source} exports no StoryBook class named ${JSON.stringify(subject.export)}`,
      );
    }
    const Book = subject.value as new () => Storybook;
    const book = new Book();

    const title = document.createElement("div");
    title.textContent = book.title();
    title.style.cssText =
      "font: 600 15px/1.4 -apple-system, system-ui, sans-serif; color: var(--text-pri); margin: 4px 2px 14px;";
    root.appendChild(title);

    // One std-storybook-card per example so each case renders with the shell's
    // card chrome. Each card binds a single-example Storybook view.
    for (const ex of book.examples()) {
      const single: Storybook = {
        title: () => ex.title ?? book.title(),
        description: () => book.description?.() ?? null,
        tags: () => book.tags(),
        preview: () => ex,
        examples: () => [ex],
      };
      const card = document.createElement("std-storybook-card");
      // Margin only. The card owns its own frame now — its inset, its shape,
      // whether it is a block at all — and this renderer's job is to place it
      // in the note and stop there. It used to reach in and retune the block
      // padding, which is how a note's card ended up with a different inset
      // from the storybook page's and neither of them right.
      card.style.cssText = "margin: 0 0 10px;";
      root.appendChild(card);
      await (card as Storybook.Card).bind(single);
    }
  },
};
