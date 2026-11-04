import { assertEquals } from "jsr:@std/assert";

import { DebouncedRequests } from "../../debounced-requests.ts";
import { ResponseError } from "../../typed-api.ts";

// `ResponseError.of` is the ONE place a non-2xx body becomes a typed error —
// `wrappedSend` and `DebouncedRequests.parseErrorBody` are its only callers,
// and no other module in the fleet may read an error envelope by hand. These
// tests are what makes that claim checkable: every envelope actually on the
// wire, and every degenerate body a proxy can answer with.
//
// The fleet emits TWO envelopes today (see the census in this commit's note):
//   { reason, details }  tento-web-error — so.lona, lona-service, tento-atoms,
//                        tento-web-auth, localhost.node api_error
//   { error }            commit-review.node, the three node-registry ApiErrors,
//                        localhost.node's proxy paths, ux-tests.node
// A third one arriving is the failure this file exists to catch.

Deno.test("of: the canonical { reason, details } envelope", () => {
  const e = ResponseError.of(409, { reason: "conflict", details: "rwc-04 is already in the fleet" });
  assertEquals(e.code, 409);
  assertEquals(e.reason, "conflict");
  assertEquals(e.details, "rwc-04 is already in the fleet");
  assertEquals(e.inner, { reason: "conflict", details: "rwc-04 is already in the fleet" });
});

Deno.test("of: a bare { error } fans into BOTH halves", () => {
  // The envelope does not separate the category from the sentence — server.rs
  // puts a slug in it, web.rs puts a formatted error in it — so its one string
  // is the best available answer to either question.
  const e = ResponseError.of(502, { error: "unknown-host" });
  assertEquals(e.reason, "unknown-host");
  assertEquals(e.details, "unknown-host");
});

Deno.test("of: the typed halves win over a bare error when a body carries both", () => {
  const e = ResponseError.of(400, { reason: "validation", details: "id is required", error: "legacy" });
  assertEquals(e.reason, "validation");
  assertEquals(e.details, "id is required");
});

Deno.test("of: bodies that are not an object degrade, never throw", () => {
  // `wrappedSend` fills the body from `jsonBody(response, null)`: a gateway's
  // HTML, an aborted read and a 204 all arrive here as null. The declared type
  // used to say this could not happen, and `sheet-list-accessor` shipped a
  // guard against it anyway.
  for (const body of [null, undefined, "plain text", 42, true]) {
    const e = ResponseError.of(500, body as never);
    assertEquals(e.reason, "", `reason for ${JSON.stringify(body)}`);
    assertEquals(e.details, "", `details for ${JSON.stringify(body)}`);
  }
  assertEquals(ResponseError.of(500, null).inner, null);
});

Deno.test("of: non-string fields are not coerced", () => {
  const e = ResponseError.of(500, { reason: 42, details: { nested: true } });
  assertEquals(e.reason, "");
  assertEquals(e.details, "");
});

Deno.test("of: an array body is an object to JS and must still degrade", () => {
  const e = ResponseError.of(500, ["reason", "details"]);
  assertEquals(e.reason, "");
  assertEquals(e.details, "");
});

Deno.test("sentence: reads details, and NEVER falls back to the category", () => {
  // `reason` is a category — localhost.node derives it from the status
  // (`error_slug`), so it is `conflict` or `bad_gateway`. A caller reaching for
  // the field whose name sounds right replaces the daemon's sentence with a
  // slug; that regression shipped once and this is the guard.
  const e = ResponseError.of(409, { reason: "conflict", details: "rwc-04 is already in the fleet" });
  assertEquals(ResponseError.sentence(e, "fallback"), "rwc-04 is already in the fleet");

  const slugOnly = ResponseError.of(409, { reason: "conflict" });
  assertEquals(ResponseError.sentence(slugOnly, "could not open the window"), "could not open the window");

  assertEquals(ResponseError.sentence(null, "fallback"), "fallback");
  assertEquals(ResponseError.sentence(ResponseError.of(500, null), "fallback"), "fallback");
});

Deno.test("parseErrorBody: absent fields stay NULL, not empty string", () => {
  // Its callers are outside this repo. The lona service worker unions this
  // result with a literal `{ reason: null }` on its success path
  // (so.lona/html/calendar.routes/sw.root.ts, CellWriteResult), so `""` would
  // be a third state neither consumer asked for.
  const body = (o: unknown, status: number) =>
    new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

  return (async () => {
    assertEquals(
      await DebouncedRequests.parseErrorBody(body({ reason: "calendar_read_only", details: "no write scope" }, 403)),
      { reason: "calendar_read_only", details: "no write scope" },
    );
    assertEquals(await DebouncedRequests.parseErrorBody(body({}, 500)), { reason: null, details: null });
    assertEquals(
      await DebouncedRequests.parseErrorBody(new Response("<html>502</html>", { status: 502 })),
      { reason: null, details: null },
    );
    // The blind spot this seam had before it shared the parse: a node-registry
    // surface answers `{ error }`, and the old hand-rolled reader looked only
    // for `reason`, so a debounced write rejected by one reported nothing.
    assertEquals(
      await DebouncedRequests.parseErrorBody(body({ error: "row is read-only" }, 403)),
      { reason: "row is read-only", details: "row is read-only" },
    );
  })();
});
