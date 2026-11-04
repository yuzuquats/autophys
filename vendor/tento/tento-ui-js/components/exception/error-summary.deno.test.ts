import { assertEquals } from "jsr:@std/assert";

import { ErrorSummary } from "./error-summary.ts";

const IMPORT_FAILURE =
  "TypeError: Failed to fetch dynamically imported module: https://dev--ui.lona.so/@/static/js/codemirror.min.js";

Deno.test("an Error's message reaches the title even when its stack is all header", () => {
  // The case that motivated this module: Chrome's dynamic-import failure has a
  // one-line stack that only repeats the message.
  const e = new TypeError(IMPORT_FAILURE.slice("TypeError: ".length));
  e.stack = IMPORT_FAILURE;
  const s = ErrorSummary.ofRejection(e);
  assertEquals(s.title, IMPORT_FAILURE);
  assertEquals(ErrorSummary.frames(s.stack), "");
  assertEquals(s.detail, null);
});

Deno.test("frames drops the V8 header, including a multi-line message", () => {
  const stack = "Error: line one\nline two\n    at a (x.js:1:2)\n    at async b (y.js:3:4)";
  assertEquals(ErrorSummary.frames(stack), "    at a (x.js:1:2)\n    at async b (y.js:3:4)");
});

Deno.test("frames keeps the first frame of a Firefox / Safari stack", () => {
  const stack = "render@https://x.test/index.root.js:4821:12\nglobal code@https://x.test/a.js:1:1\n";
  assertEquals(ErrorSummary.frames(stack), stack.trimEnd());
  assertEquals(ErrorSummary.frames("fn@[native code]"), "fn@[native code]");
  // A message that merely contains `@` (here a `/@/static` path) is not a frame.
  assertEquals(ErrorSummary.frames("Error: see https://x.test/@/static/a.js"), "");
});

Deno.test("causes, aggregated errors and extra fields land in detail", () => {
  const root = new Error("socket closed");
  const e = new AggregateError([new RangeError("bad index"), "plain"], "two failures", { cause: root });
  (e as unknown as { code: string }).code = "E_SYNC";
  const s = ErrorSummary.ofRejection(e);
  assertEquals(s.title, "AggregateError: two failures");
  const detail = s.detail ?? "";
  assertEquals(detail.includes('code: "E_SYNC"'), true);
  assertEquals(detail.includes("[0] RangeError: bad index"), true);
  assertEquals(detail.includes("[1] Promise rejected: plain"), true);
  assertEquals(detail.includes("Caused by: Error: socket closed"), true);
});

Deno.test("a cross-realm or hand-built error is still treated as an error", () => {
  const s = ErrorSummary.ofRejection({ name: "AbortError", message: "The user aborted a request." });
  assertEquals(s.title, "AbortError: The user aborted a request.");
});

Deno.test("primitives, null and undefined say what they were", () => {
  assertEquals(ErrorSummary.ofRejection(null).title, "Promise rejected with null");
  assertEquals(ErrorSummary.ofRejection(undefined).title, "Promise rejected with undefined");
  assertEquals(ErrorSummary.ofRejection(404).title, "Promise rejected with 404");
  assertEquals(ErrorSummary.ofRejection(Symbol("x")).title, "Promise rejected with Symbol(x)");
});

Deno.test("strings become the title; long or multi-line ones keep the full text", () => {
  assertEquals(ErrorSummary.ofRejection("sync aborted"), {
    title: "Promise rejected: sync aborted",
    detail: null,
  });
  const multi = ErrorSummary.ofRejection("first\nsecond");
  assertEquals(multi.title, "Promise rejected: first");
  assertEquals(multi.detail, "first\nsecond");
});

Deno.test("Responses, Events and plain objects are described, not dropped", () => {
  const r = ErrorSummary.ofRejection(new Response(null, { status: 503, statusText: "Service Unavailable" }));
  assertEquals(r.title, "Promise rejected with HTTP 503 Service Unavailable");

  const ev = ErrorSummary.ofRejection(new Event("error"));
  assertEquals(ev.title, 'Promise rejected with a "error" event');

  const o = ErrorSummary.ofRejection({ status: 401, reason: "expired" });
  assertEquals(o.title, "Promise rejected with an object");
  assertEquals(o.detail, '{\n  "status": 401,\n  "reason": "expired"\n}');

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertEquals(ErrorSummary.ofRejection(cyclic).detail, "[object Object]");
});
