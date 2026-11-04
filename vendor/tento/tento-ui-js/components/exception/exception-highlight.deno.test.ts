import { assertEquals } from "jsr:@std/assert";

import { ExceptionHighlight } from "./exception-highlight.ts";

// Two kinds of assertion here, and the first is the load-bearing one.
//
// TOTALITY: the runs concatenate back to the input, for every line. A
// highlighter is a lossy renderer the moment a regex consumes something it does
// not emit, and the failure mode is a compiler diagnostic that quietly loses
// the path it was pointing at — which is the one thing a reader needed.
//
// SHAPE: the four constructs get the classes the stylesheet colours. These are
// spot checks; the grammar is not meant to be complete, and lines it does not
// recognise are supposed to come back as one plain run.

const tokenize = ExceptionHighlight.tokenize;
const joined = (line: string) =>
  tokenize(line)
    .map((t) => t.text)
    .join("");
const kinds = (line: string) => tokenize(line).map((t) => `${t.kind}:${t.text}`);

const CORPUS = [
  "    at render (index.root.js:4821:12)",
  "    at async mount (index.root.js:4790:5)",
  "    at /Users/x/acme-ui/widgets/badge.example.ts:1:24",
  "TypeError: parameter 1 is not of type 'Node'",
  `error: Could not resolve: "@acme/tokens/color"`,
  `error: script "build" exited with code 1`,
  "warning: unused import",
  "sheets/src/plugins/index.ts:39",
  "sync aborted: token expired",
  "Storybook cards are compiled with bun. Install it (https://bun.sh), or point",
  "",
  "   ",
  "at",
  "::::",
  "a.b.c.d.e",
  "\tat foo (bar.ts:1:1)",
  "panicked at 'index out of bounds', src/main.rs:12:9",
];

Deno.test("every line comes back byte for byte", () => {
  for (const line of CORPUS) assertEquals(joined(line), line, `lost text in: ${line}`);
});

Deno.test("a stack frame is keyword, callee, path, position", () => {
  assertEquals(kinds("    at render (index.root.js:4821:12)"), [
    "text:    ",
    "keyword:at ",
    "callee:render",
    "text: (",
    "path:index.root.js",
    "position::4821:12",
    "text:)",
  ]);
});

Deno.test("`at async` is one keyword, not a callee named async", () => {
  const ks = kinds("    at async mount (index.root.js:4790:5)");
  assertEquals(ks[1], "keyword:at async ");
  assertEquals(ks[2], "callee:mount");
});

Deno.test("a frame with no callee still gets its path and position", () => {
  assertEquals(kinds("    at /Users/x/acme-ui/widgets/badge.example.ts:1:24"), [
    "text:    ",
    "keyword:at ",
    "path:/Users/x/acme-ui/widgets/badge.example.ts",
    "position::1:24",
  ]);
});

Deno.test("a diagnostic's severity and its quoted literal", () => {
  assertEquals(kinds(`error: Could not resolve: "@acme/tokens/color"`), [
    "severity:error: ",
    "text:Could not resolve: ",
    `string:"@acme/tokens/color"`,
  ]);
});

Deno.test("`error` mid-sentence is prose, not a severity label", () => {
  const ks = kinds("the error was transient");
  assertEquals(ks, ["text:the error was transient"]);
});

Deno.test("a bare path:line with no frame around it is still a path", () => {
  assertEquals(kinds("sheets/src/plugins/index.ts:39"), [
    "path:sheets/src/plugins/index.ts",
    "position::39",
  ]);
});

Deno.test("an unrecognised line is one plain run", () => {
  assertEquals(kinds("sync aborted: token expired"), ["text:sync aborted: token expired"]);
});

Deno.test("an empty line produces no runs at all", () => {
  assertEquals(tokenize(""), []);
});

Deno.test("the scanner is not stateful across calls", () => {
  // SCAN is a module-level /g regex; forgetting to reset lastIndex makes the
  // SECOND call skip the first match, which is invisible in a single-line test.
  const once = kinds("sheets/src/plugins/index.ts:39");
  for (let i = 0; i < 3; i++) assertEquals(kinds("sheets/src/plugins/index.ts:39"), once);
});
