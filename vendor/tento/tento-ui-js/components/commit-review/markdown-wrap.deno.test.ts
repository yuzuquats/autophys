import { assertEquals } from "jsr:@std/assert";

import { rewrapMarkdown } from "./markdown-wrap.ts";

// The contract under test, in one line: split long prose lines at the
// width, NEVER join — so already-wrapped text passes byte-identical and
// structure (fences, headings, tables) is untouched even when long.

Deno.test("wrap: a long paragraph breaks at the width, words intact", () => {
  const out = rewrapMarkdown("alpha beta gamma delta epsilon zeta", 20);
  assertEquals(out, "alpha beta gamma\ndelta epsilon zeta");
  for (const line of out.split("\n")) assertEquals(line.length <= 20, true);
});

Deno.test("never join: short and already-wrapped lines pass byte-identical", () => {
  const wrapped = "one short line\nanother short line\n\nthird paragraph";
  assertEquals(rewrapMarkdown(wrapped, 72), wrapped);
  // Idempotent: wrapping wrapped output changes nothing more.
  const once = rewrapMarkdown("alpha beta gamma delta epsilon zeta", 20);
  assertEquals(rewrapMarkdown(once, 20), once);
});

Deno.test("fences: long code lines pass through untouched", () => {
  const md = [
    "```ts",
    "const veryLongLine = fetchTheThing(withArguments, thatMakeIt, muchTooLong);",
    "```",
  ].join("\n");
  assertEquals(rewrapMarkdown(md, 30), md);
});

Deno.test("fences: a ``` line inside a ~~~ fence does not close it", () => {
  const md = [
    "~~~",
    "``` this long line sits inside a tilde fence and must stay exactly as is",
    "still inside the tilde fence, also much longer than the wrap width here",
    "~~~",
  ].join("\n");
  assertEquals(rewrapMarkdown(md, 30), md);
});

Deno.test("unwrappable: headings, tables, html, reference definitions stay", () => {
  const md = [
    "## a heading long enough that a naive wrapper would happily break it",
    "| column one | column two | column three | column four | column five |",
    "<div class=\"raw-html-block\" data-note=\"long attributes must not wrap\">",
    "[ref]: https://example.com/a/very/long/path/that/exceeds/any/width/limit",
  ].join("\n");
  assertEquals(rewrapMarkdown(md, 30), md);
});

Deno.test("indented code: 4-space indent without a marker passes through", () => {
  const md = "    const x = compute(somethingLong, somethingElse, andMore);";
  assertEquals(rewrapMarkdown(md, 30), md);
});

Deno.test("list items: continuation hangs under the item's text", () => {
  assertEquals(
    rewrapMarkdown("- alpha beta gamma delta", 12),
    "- alpha beta\n  gamma\n  delta",
  );
  assertEquals(
    rewrapMarkdown("1. alpha beta gamma", 10),
    "1. alpha\n   beta\n   gamma",
  );
});

Deno.test("blockquotes: continuation repeats the quote marker", () => {
  assertEquals(
    rewrapMarkdown("> alpha beta gamma delta", 12),
    "> alpha beta\n> gamma\n> delta",
  );
});

Deno.test("nesting: quote-then-list keeps the quote, blanks the marker", () => {
  assertEquals(
    rewrapMarkdown("> - alpha beta gamma delta", 14),
    "> - alpha beta\n>   gamma\n>   delta",
  );
});

Deno.test("overlong word: lands on its own line, never split or dropped", () => {
  assertEquals(
    rewrapMarkdown("supercalifragilistic word", 10),
    "supercalifragilistic\nword",
  );
});
