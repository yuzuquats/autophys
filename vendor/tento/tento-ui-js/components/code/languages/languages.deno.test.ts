import { assertEquals } from "@std/assert";

import { shellTokenizer } from "./shell.ts";
import { tokenizeLines, typeOf } from "./testing.ts";
import { tomlTokenizer } from "./toml.ts";

Deno.test("shell: commands, flags, variables, operators, comments", () => {
  const [line, next] = tokenizeLines(
    shellTokenizer,
    "ls -la $HOME | grep x # find\nif true; then echo ok; fi",
  );
  assertEquals(typeOf(line, "ls"), "variableName.function");
  assertEquals(typeOf(line, "-la"), "attributeName");
  assertEquals(typeOf(line, "$HOME"), "atom");
  assertEquals(typeOf(line, "|"), "operator");
  assertEquals(typeOf(line, "grep"), "variableName.function");
  assertEquals(typeOf(line, "# find"), "lineComment");
  assertEquals(typeOf(next, "if"), "keyword");
  assertEquals(typeOf(next, "echo"), "variableName.function");
});

Deno.test("shell: a quote left open continues on the next line", () => {
  const [, second, third] = tokenizeLines(shellTokenizer, "echo 'a\nb'\nls");
  assertEquals(second, [["b'", "string"]]);
  assertEquals(typeOf(third, "ls"), "variableName.function");
});

Deno.test("toml: tables, keys and values", () => {
  const [table, pair] = tokenizeLines(tomlTokenizer, '[package]\nname = "tsh" # c');
  assertEquals(table, [["[package]", "keyword"]]);
  assertEquals(pair.map(([, t]) => t), ["propertyName", "punctuation", "string", "lineComment"]);
});

Deno.test("highlightText runs a tokenizer without CodeMirror", async () => {
  const { highlightText } = await import("./highlight.ts");
  assertEquals(highlightText(shellTokenizer, "ls -la # x"), [
    { from: 0, to: 2, role: "function" },
    { from: 3, to: 6, role: "punctuation" },
    { from: 7, to: 10, role: "comment" },
  ]);
});

Deno.test("LineStream tokenizes like CodeMirror's StringStream", async () => {
  const { LineStream } = await import("./string-stream.ts");
  const { StringStream } = await import("npm:@codemirror/language@^6");
  const source = "ls -la $HOME | grep 'x' && echo \"y\" # done\nif a; then b; fi";
  for (const line of source.split("\n")) {
    const run = (stream: any) => {
      const state = shellTokenizer.startState(2);
      const out: [string, string | null][] = [];
      while (!stream.eol()) {
        stream.start = stream.pos;
        const type = shellTokenizer.token(stream, state);
        out.push([stream.current(), type]);
      }
      return out;
    };
    assertEquals(run(new LineStream(line)), run(new StringStream(line, 2, 2)));
  }
});

Deno.test("shell: assignments and expansions inside double quotes", () => {
  const [assign, quoted] = tokenizeLines(shellTokenizer, 'CC=clang make all\necho "home is $HOME, ok"');
  assertEquals(typeOf(assign, "CC"), "atom");
  assertEquals(typeOf(assign, "="), "operator");
  assertEquals(typeOf(assign, "make"), "variableName.function");
  assertEquals(typeOf(quoted, "$HOME"), "atom");
  assertEquals(typeOf(quoted, ', ok"'), "string");
});

Deno.test("shell: empty and quoted assignment values keep the command position", () => {
  const [empty, quoted, escaped] = tokenizeLines(
    shellTokenizer,
    'CC= make all\nCC="clang -O2" make all\necho \\( x',
  );
  assertEquals(typeOf(empty, "make"), "variableName.function");
  assertEquals(typeOf(empty, "all"), null);
  assertEquals(typeOf(quoted, '"clang -O2"'), "string");
  assertEquals(typeOf(quoted, "make"), "variableName.function");
  assertEquals(typeOf(escaped, "\\("), null);
});
