import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";

import { Tracing } from "../../tracing.ts";
import { ResponseDecodeError, TypedApi, RouteList } from "../../typed-api.ts";

// The request URL is built in exactly one place — `send` — and `baseUrl` is the
// only part of it a caller can change. These tests pin what that one line is
// allowed to produce, because for most of this file's life it produced a
// `URL` object and nobody noticed that the one-argument `URL` constructor
// REQUIRES an absolute URL.
//
// Every historical baseUrl was an absolute origin (`http://<app>.<host>.…`),
// so `new URL(baseUrl + path)` worked by accident. tento.localhost's relay
// introduced the first PATH-ONLY base — `/data/<host>/commit-review` — and
// `new URL("/data/rwc-01/commit-review/api/repos")` throws
// `TypeError: Failed to construct 'URL': Invalid URL`. The commit-review fleet
// view settles each host as `{ok:false}`, so the throw was swallowed per host
// and every pane rendered EMPTY against a healthy API: no bad status, nothing
// in the console. Only the single-host path, which does not catch, ever said
// what was wrong.
//
// The first test is the regression guard: it fails with `new URL(...)` and
// passes with concatenation. The other two are what that line must not break
// on its way past.

type Routes = {
  "/api/repos": { get: { response: { key: string }[] } };
};

/** Swap in a fetch that records its URL argument and answers 200 `[]`. */
async function urlPassedToFetch(baseUrl: string | null): Promise<unknown> {
  const original = globalThis.fetch;
  let seen: unknown = undefined;
  globalThis.fetch = ((input: unknown) => {
    seen = input;
    return Promise.resolve(
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  try {
    const api = baseUrl == null
      ? TypedApi.make<Routes>()
      : TypedApi.make<Routes>().withOptions({ baseUrl });
    await api.getResult("/api/repos");
    return seen;
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("send: a path-only baseUrl stays a relative string", async () => {
  // The tento.localhost relay prefix. `new URL()` cannot parse this; `fetch`
  // resolves it against the document, which is the whole point — the page is
  // served FROM that prefix, so a relative URL is already correct.
  const seen = await urlPassedToFetch("/data/rwc-01/commit-review");
  assertEquals(seen, "/data/rwc-01/commit-review/api/repos");
});

Deno.test("send: an absolute baseUrl still addresses the same absolute URL", async () => {
  // The shape every pre-relay caller used. This one is not the regression
  // guard — it passed before the fix too, when the argument was a `URL` rather
  // than a string. It is deliberately written against the VALUE (`String`) and
  // not the representation, so it keeps holding whichever of the two a future
  // rewrite picks, and cannot fail for a reason that does not matter.
  const seen = await urlPassedToFetch("https://example.test");
  assertEquals(String(seen), "https://example.test/api/repos");
});

Deno.test("send: no baseUrl sends the bare route", async () => {
  // Same-origin: `commit-review-server --web-root` serves the page itself, so
  // `Service.locate()` hands back "" and the route is already the whole URL.
  assertEquals(await urlPassedToFetch(null), "/api/repos");
  assertEquals(await urlPassedToFetch(""), "/api/repos");
});

// ── What a 200 body reads as ──────────────────────────────────────────────
//
// `jsonBody` rejects a non-JSON 200 with `ResponseDecodeError` (the server
// answered; the client cannot read what it said). A followed redirect to a
// page is malformed too on every ordinary verb: a row PATCH answered by
// `303 Location: /login` lands on the login page, and reading that as `null`
// would acknowledge a write the server never stored. Only `postNavigation*`,
// which a caller picks for a route whose redirect IS its answer (the app's
// onboarding `start-trial` POST), reads it as a navigation.

type StartTrial = {
  "/api/user/subscription/start-trial": { post: { response: null } };
};

/** A Response as `fetch` hands it back, optionally after following a redirect
 *  to `redirectedTo` (a constructed Response cannot be `redirected`). */
function answer(
  body: string,
  contentType: Option<string>,
  redirectedTo: Option<string>,
): Response {
  const r = new Response(body, {
    status: 200,
    headers: contentType == null ? {} : { "content-type": contentType },
  });
  if (redirectedTo != null) {
    Object.defineProperty(r, "redirected", { value: true });
    Object.defineProperty(r, "url", { value: redirectedTo });
  }
  return r;
}

/** The same route declared with the JSON answer a proxy-less server gives. */
type StartTrialJson = {
  "/api/user/subscription/start-trial": { post: { response: { redirect: string } } };
};

function apiAnswering<R extends RouteList = StartTrial>(r: () => Response): TypedApi<R> {
  return TypedApi.make<R>().withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(r()),
  });
}

/** Run `fn`, returning the `typed-api/redirected` roots traced meanwhile. */
async function redirectedTraces(fn: () => Promise<unknown>): Promise<Tracing.LjsonEntry[]> {
  const seen: Tracing.LjsonEntry[] = [];
  let armed = false; // `onEntry` replays the ring buffer on subscribe
  const cb = (e: Tracing.LjsonEntry) => {
    if (armed && e.rootSpan.name === "typed-api/redirected") seen.push(e);
  };
  Tracing.onEntry(cb);
  armed = true;
  try {
    await fn();
  } finally {
    Tracing.removeOnEntry(cb);
  }
  return seen;
}

const PAGE = "<!doctype html><html><body>calendar</body></html>";

Deno.test("jsonBody: a redirect followed to an HTML page is malformed on an ordinary verb, and names the redirect", async () => {
  const api = apiAnswering(() =>
    answer(PAGE, "text/html; charset=utf-8", "https://calendar.test/login")
  );
  const traces = await redirectedTraces(async () => {
    const err = await assertRejects(
      () => api.post("/api/user/subscription/start-trial"),
      ResponseDecodeError,
    );
    assertEquals(err.status, 200);
    assertStringIncludes(
      err.message,
      "redirected to https://calendar.test/login, which is not JSON",
    );
  });
  assertEquals(traces.length, 0);
});

Deno.test("jsonBody: the checked verb rejects a redirect to a page too, not Ok(null)", async () => {
  const api = apiAnswering(() => answer(PAGE, null, "https://calendar.test/"));
  await assertRejects(
    () => api.postResult("/api/user/subscription/start-trial"),
    ResponseDecodeError,
    "which is not JSON",
  );
});

Deno.test("postNavigation: a redirect followed to a page is a navigation answer, and is traced", async () => {
  const api = apiAnswering(() =>
    answer(PAGE, "text/html; charset=utf-8", "https://calendar.test/")
  );
  let got: unknown = "unset";
  const traces = await redirectedTraces(async () => {
    got = await api.postNavigation("/api/user/subscription/start-trial");
  });
  assertEquals(got, { kind: "navigated", url: "https://calendar.test/", status: 200 });
  assertEquals(traces.length, 1);
  const attrs = traces[0].rootSpan.attributes;
  assertEquals(traces[0].rootSpan.level, "info");
  assertEquals(attrs["url"], "https://calendar.test/");
  assertEquals(attrs["status"], 200);
  assertEquals(attrs["path"], "/api/user/subscription/start-trial");

  const r = await api.postNavigationResult("/api/user/subscription/start-trial");
  assert(r.isOk());
  assertEquals(r.expect("ok"), { kind: "navigated", url: "https://calendar.test/", status: 200 });
});

Deno.test("postNavigation: an answer that is not a redirect to a page reads as post reads it", async () => {
  const empty = apiAnswering(() => answer("", null, null));
  assertEquals(
    await empty.postNavigation("/api/user/subscription/start-trial"),
    { kind: "answered", body: null },
  );
  const json = apiAnswering<StartTrialJson>(() =>
    answer("{\"redirect\":\"/\"}", "application/json", "https://calendar.test/x")
  );
  assertEquals(
    await json.postNavigation("/api/user/subscription/start-trial"),
    { kind: "answered", body: { redirect: "/" } },
  );
  // Not redirected: an HTML 200 is a proxy's or a wrong route's page, and
  // stays malformed even here.
  const html = apiAnswering(() => answer(PAGE, "text/html", null));
  await assertRejects(
    () => html.postNavigation("/api/user/subscription/start-trial"),
    ResponseDecodeError,
    "the body is not JSON",
  );
});

Deno.test("postNavigation: a non-200 goes to the delegate and resolves null", async () => {
  const api = TypedApi.make<StartTrial>().withOptions({
    baseUrl: "https://calendar.test",
    fetch: () =>
      Promise.resolve(
        new Response("{\"reason\":\"not_logged_in\"}", {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
  });
  const seen: string[] = [];
  api.delegate = { onUncaughtError: (e, line) => seen.push(`${line.method} ${e.code} ${e.reason}`) };
  assertEquals(await api.postNavigation("/api/user/subscription/start-trial"), null);
  assertEquals(seen, ["POST 401 not_logged_in"]);
  const r = await api.postNavigationResult("/api/user/subscription/start-trial");
  assertEquals(r.err()?.code, 401);
});

Deno.test("jsonBody: a redirect followed to JSON is still parsed, and still checked", async () => {
  const ok = apiAnswering(() =>
    answer("{\"redirect\":\"/\"}", "application/json", "https://calendar.test/x")
  );
  assertEquals(await ok.post("/api/user/subscription/start-trial"), { redirect: "/" });
  const bad = apiAnswering(() =>
    answer("not json", "application/json", "https://calendar.test/x")
  );
  await assertRejects(
    () => bad.post("/api/user/subscription/start-trial"),
    ResponseDecodeError,
  );
});

Deno.test("jsonBody: a non-redirected HTML 200 is malformed, not null", async () => {
  const api = apiAnswering(() => answer(PAGE, "text/html", null));
  const statuses: number[] = [];
  const traces = await redirectedTraces(async () => {
    const err = await assertRejects(
      () => api.post("/api/user/subscription/start-trial"),
      ResponseDecodeError,
    );
    statuses.push(err.status);
  });
  assertEquals(traces.length, 0);
  assertEquals(statuses, [200]);
  await assertRejects(
    () => api.postResult("/api/user/subscription/start-trial"),
    ResponseDecodeError,
  );
});

Deno.test("jsonBody: an empty 200 body reads as null on a route that declares no response", async () => {
  // `StartTrial` declares `response: null` and gives the verb no `parse`: an
  // empty answer is its answer.
  const api = apiAnswering(() => answer("", null, null));
  assertEquals(await api.post("/api/user/subscription/start-trial"), null);
  const r = await api.postResult("/api/user/subscription/start-trial");
  assert(r.isOk());
  assertEquals(r.expect("ok"), null);
});

// A route that declares a response (a generated route map gives it a `parse`
// reviver) never answers an empty 200: reading one as `null` would hand a
// caller typed `T` a null it did not ask for (a checked SDK verb crashed on
// it with a TypeError instead of a malformed `SdkRequestError`). Declaring the
// verb `nullable` is how a route says an empty 200 is a real answer.

type Declared = {
  "/api/tasks": { post: { response: { id: string } } };
};

const TASK_REVIVERS = {
  "/api/tasks": {
    parse: {
      post: (s: UntypedJson) => {
        if (s == null || typeof s !== "object" || !("id" in s) || typeof s.id !== "string") {
          throw new TypeError("not a task");
        }
        return { id: s.id };
      },
    },
  },
};

function declaredAnswering(
  r: () => Response,
  nullable: boolean,
): TypedApi<Declared> {
  const revivers = nullable
    ? { "/api/tasks": { ...TASK_REVIVERS["/api/tasks"], nullable: { post: true as const } } }
    : TASK_REVIVERS;
  return TypedApi.makeWith<Declared>(revivers).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(r()),
  });
}

Deno.test("jsonBody: an empty 200 on a route that declares a response is malformed, on every verb form", async () => {
  const api = declaredAnswering(() => answer("", "application/json", null), false);
  const err = await assertRejects(() => api.post("/api/tasks"), ResponseDecodeError);
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "the body is empty, but the route declares a response");
  await assertRejects(() => api.postResult("/api/tasks"), ResponseDecodeError, "the body is empty");
});

Deno.test("jsonBody: a declared route answering a body still reads it", async () => {
  const api = declaredAnswering(() => answer("{\"id\":\"t1\"}", "application/json", null), false);
  const r = await api.postResult("/api/tasks");
  assertEquals(r.expect("ok"), { id: "t1" });
});

Deno.test("jsonBody: a verb declared nullable reads an empty 200 as null", async () => {
  const api = declaredAnswering(() => answer("", null, null), true);
  const r = await api.postResult("/api/tasks");
  assert(r.isOk());
  assertEquals(r.expect("ok"), null);
});

Deno.test("jsonBody: a body its route's validator rejects is malformed, not logged and returned", async () => {
  const api = TypedApi.makeWith<Declared>({
    "/api/tasks": {
      validate: {
        post: () => ({
          isOk: false,
          issues: [{ path: ["id"], code: "type", message: "expected a string" }],
        }),
      },
    },
  }).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(answer("{\"id\":7}", "application/json", null)),
  });
  const err = await assertRejects(() => api.postResult("/api/tasks"), ResponseDecodeError);
  assertStringIncludes(err.message, "the body does not validate: id: expected a string");
});

// ── Every 2xx is an answer; a falsy JSON body is a body (review C, N13) ──
//
// `exchange` used to accept only `200` (a `201 Created` or `204 No Content`
// write read as a refusal), and `jsonBody`'s `if (!json)` read a JSON
// `false` / `0` / `""` answer as "no body", skipping the route's validator
// and reviver. "No body" is the empty body (or the JSON literal `null`); a
// falsy JSON value is the route's answer.

type Flag = {
  "/api/flag": { get: { response: boolean } };
  "/api/count": { get: { response: number } };
  "/api/name": { get: { response: string } };
};

function flagAnswering(body: string, revived: string[]): TypedApi<Flag> {
  const record = (route: string) => (s: UntypedJson) => {
    revived.push(`${route}:${JSON.stringify(s)}`);
    return s;
  };
  return TypedApi.makeWith<Flag>({
    "/api/flag": { parse: { get: record("flag") } },
    "/api/count": { parse: { get: record("count") } },
    "/api/name": { parse: { get: record("name") } },
  }).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(answer(body, "application/json", null)),
  });
}

Deno.test("jsonBody: a JSON false answer is false, not null, and is revived", async () => {
  const revived: string[] = [];
  const api = flagAnswering("false", revived);
  const r = await api.getResult("/api/flag");
  assert(r.isOk());
  assertEquals(r.expect("ok"), false);
  assertEquals(await api.get("/api/flag"), false);
  assertEquals(revived, ["flag:false", "flag:false"]);
});

Deno.test("jsonBody: JSON 0 and \"\" answers are the body, not null", async () => {
  const revived: string[] = [];
  assertEquals((await flagAnswering("0", revived).getResult("/api/count")).expect("ok"), 0);
  assertEquals((await flagAnswering("\"\"", revived).getResult("/api/name")).expect("ok"), "");
  assertEquals(revived, ["count:0", "name:\"\""]);
});

Deno.test("jsonBody: a falsy JSON body is validated like any other", async () => {
  const api = TypedApi.makeWith<Flag>({
    "/api/flag": {
      validate: {
        get: (json: UntypedJson) =>
          typeof json === "boolean"
            ? { isOk: true }
            : { isOk: false, issues: [{ path: [], code: "type", message: "expected a boolean" }] },
      },
    },
  }).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(answer("0", "application/json", null)),
  });
  const err = await assertRejects(() => api.getResult("/api/flag"), ResponseDecodeError);
  assertStringIncludes(err.message, "the body does not validate: $: expected a boolean");
});

Deno.test("jsonBody: the JSON literal null still reads as null", async () => {
  const revived: string[] = [];
  const r = await flagAnswering("null", revived).getResult("/api/flag");
  assertEquals(r.expect("ok"), null);
  assertEquals(revived, [], "no body: nothing to revive");
});

Deno.test("exchange: a 201 Created with a body is an answer, not an error", async () => {
  const api = TypedApi.makeWith<Declared>(TASK_REVIVERS).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () =>
      Promise.resolve(new Response("{\"id\":\"t1\"}", {
        status: 201,
        headers: { "content-type": "application/json" },
      })),
  });
  const r = await api.postResult("/api/tasks");
  assert(r.isOk(), "a 201 is not folded into Result.err");
  assertEquals(r.expect("ok"), { id: "t1" });
});

Deno.test("exchange: a 204 No Content reads as null on a route that declares no response", async () => {
  const api = apiAnswering(() => new Response(null, { status: 204 }));
  const r = await api.postResult("/api/user/subscription/start-trial");
  assert(r.isOk(), "a 204 is an answer");
  assertEquals(r.expect("ok"), null);
  assertEquals(await api.post("/api/user/subscription/start-trial"), null);
});

Deno.test("exchange: a 204 on a route that declares a response is malformed, as an empty 200 is", async () => {
  const api = TypedApi.makeWith<Declared>(TASK_REVIVERS).withOptions({
    baseUrl: "https://calendar.test",
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  });
  const err = await assertRejects(() => api.postResult("/api/tasks"), ResponseDecodeError);
  assertEquals(err.status, 204);
  assertStringIncludes(err.message, "the body is empty, but the route declares a response");
});

Deno.test("exchange: a 3xx that was not followed and a 4xx are still errors", async () => {
  for (const status of [304, 400, 409]) {
    const api = apiAnswering(() => new Response(null, { status }));
    const r = await api.postResult("/api/user/subscription/start-trial");
    assert(!r.isOk(), `${status} is not an answer`);
  }
});

// ── The performance timeline (judge P r31 P8) ──────────────────────────
//
// Every request used to leave two named marks and a measure on the global
// timeline, never cleared (1,122 marks + 561 measures after one 100-row
// scroll), and paired the measure's marks BY ROUTE NAME, so two requests in
// flight on one route timed each other. By default a request now leaves
// nothing (its `api-call` span carries the duration); with `timeline: true`
// it leaves exactly one measure, from its own start, and no mark.

/** `n` concurrent GETs of one route through `api`, answered out of order; the timeline entries they leave. */
async function timelineOf(api: TypedApi<Routes>, n: number): Promise<{ marks: number; measures: PerformanceEntry[] }> {
  performance.clearMarks();
  performance.clearMeasures();
  const original = globalThis.fetch;
  let k = 0;
  globalThis.fetch = (() => {
    const delay = (n - k++) * 5;
    return new Promise<Response>((resolve) =>
      setTimeout(() => resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })), delay)
    );
  }) as typeof globalThis.fetch;
  try {
    await Promise.all(Array.from({ length: n }, () => api.getResult("/api/repos")));
    return { marks: performance.getEntriesByType("mark").length, measures: performance.getEntriesByType("measure") };
  } finally {
    globalThis.fetch = original;
    performance.clearMarks();
    performance.clearMeasures();
  }
}

Deno.test("timeline: a request leaves no mark and no measure by default", async () => {
  const { marks, measures } = await timelineOf(TypedApi.make<Routes>(), 3);
  assertEquals({ marks, measures: measures.length }, { marks: 0, measures: 0 });
});

Deno.test("timeline: opted in, one measure per request from its own start, no named marks", async () => {
  const { marks, measures } = await timelineOf(TypedApi.make<Routes>().withOptions({ timeline: true }), 3);
  assertEquals(marks, 0);
  assertEquals(measures.map((m) => m.name), Array(3).fill("[network][/api/repos] send"));
  // Answered last-first with 15/10/5 ms delays: each measure spans its own request.
  const durations = measures.map((m) => m.duration).sort((a, b) => a - b);
  assert(durations[0]! >= 4 && durations[2]! >= 14, `durations ${durations.join(", ")}`);
});

Deno.test("send: the body is stringified once, and the logged string is the sent one", async () => {
  const original = globalThis.fetch;
  const stringify = JSON.stringify;
  let calls = 0;
  let sent: unknown = null;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    calls++;
    return stringify(...args);
  }) as typeof JSON.stringify;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    sent = init?.body ?? null;
    return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;
  try {
    calls = 0;
    await TypedApi.make<{ "/api/repos": { post: { config: { body: { a: number } }; response: { key: string }[] } } }>()
      .postResult("/api/repos", { body: { a: 1 } });
  } finally {
    JSON.stringify = stringify;
    globalThis.fetch = original;
  }
  assertEquals(sent, "{\"a\":1}");
  assertEquals(calls, 1);
});
