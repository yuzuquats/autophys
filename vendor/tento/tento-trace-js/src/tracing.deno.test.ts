import { assertEquals } from "jsr:@std/assert";

import { Tracing } from "./tracing.ts";

const SINK = "http://sink.invalid/_/ux-test/logs";

type Captured = { url: string; entries: { rootSpan: { name: string } }[] };

/**
 * Replace `fetch` so a flush is observable without a network. The trace
 * uploader is fire-and-forget, so returning a resolved response is enough.
 */
function captureFetch(): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : '{"entries":[]}';
    captured.push({ url: String(_url), entries: JSON.parse(raw).entries });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

/**
 * Module state is global, so drain whatever earlier tests left behind: attach a
 * sink, flush it out, then detach. Retention is exactly why this can no longer
 * be done by flushing with no sink configured.
 */
function drain(): void {
  Tracing.configure({ sinks: [SINK] });
  Tracing.flush();
  Tracing.configure({ sinks: [] });
}

Deno.test("an early error does not wipe the pre-sink boot window", () => {
  const { captured, restore } = captureFetch();
  try {
    drain();
    captured.length = 0;

    // The pre-`configure()` window: where a UX test's boot spans and its
    // app-command dispatch live.
    Tracing.span("before-configure", () => {});

    // An error-carrying span calls `flushImmediate()`. That is the realistic
    // trigger — one error early in boot used to take the entire buffer and
    // discard it on discovering there was no sink yet, so the dispatch span a
    // spec was there to observe vanished along with it.
    Tracing.span("boot-error", (s) => {
      s.event("error", "something failed during boot");
    });
    assertEquals(captured.length, 0, "nothing should upload without a sink");

    Tracing.configure({ sinks: [SINK] });
    Tracing.flush();

    const names = captured.flatMap((c) => c.entries.map((e) => e.rootSpan.name));
    assertEquals(names.includes("before-configure"), true);
    assertEquals(names.includes("boot-error"), true);
  } finally {
    restore();
    drain();
  }
});

Deno.test("a flush with no sink does not discard the buffer", () => {
  const { captured, restore } = captureFetch();
  try {
    drain();
    captured.length = 0;

    Tracing.span("kept-across-flush", () => {});
    // This is the exact call that used to destroy the entry: it took the
    // buffer, then discovered there was nowhere to send it.
    Tracing.flush();
    assertEquals(captured.length, 0);

    Tracing.configure({ sinks: [SINK] });
    Tracing.flush();

    const names = captured.flatMap((c) => c.entries.map((e) => e.rootSpan.name));
    assertEquals(names.includes("kept-across-flush"), true);
  } finally {
    restore();
    drain();
  }
});

Deno.test("retention is bounded when no sink is ever configured", () => {
  const { captured, restore } = captureFetch();
  try {
    drain();
    captured.length = 0;

    // Retaining the buffer must not become an unbounded leak in a process that
    // never installs a sink. 2500 > PENDING_BUFFER_CAP (2000).
    for (let i = 0; i < 2500; i++) {
      Tracing.span(`overflow-${i}`, () => {});
    }

    Tracing.configure({ sinks: [SINK] });
    Tracing.flush();

    const entries = captured.flatMap((c) => c.entries);
    assertEquals(entries.length, 2000, "buffer should cap at PENDING_BUFFER_CAP");
    // Oldest-out: the earliest spans are the ones dropped.
    const names = entries.map((e) => e.rootSpan.name);
    assertEquals(names.includes("overflow-0"), false);
    assertEquals(names.includes("overflow-2499"), true);
  } finally {
    restore();
    drain();
  }
});

Deno.test("watchdog: disarm before deadline never fires; a hung arm fires once", async () => {
  drain();
  const { captured, restore } = captureFetch();
  try {
    Tracing.configure({ sinks: [SINK] });
    const wd = new Tracing.Witness.Watchdog({ name: "test" });
    // Disarmed arm: the shared sweep timer may still fire, but must emit nothing.
    const disarm = wd.arm(10, null);
    disarm();
    disarm(); // double-disarm is a no-op
    // Hung arm: fires via the shared sweep.
    wd.arm(10, { probe: 1 });
    await new Promise((r) => setTimeout(r, 80));
    Tracing.flush();
    const fired = captured
      .flatMap((c) => c.entries)
      .filter((e) => e.rootSpan.name === "witness/watchdog");
    assertEquals(fired.length, 1);
  } finally {
    restore();
    Tracing.configure({ sinks: [] });
  }
});

// ---------------------------------------------------------------------------
// Root held open by async children
// ---------------------------------------------------------------------------

type Span = {
  name: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  children: ({ type: string } & Span)[];
};

/**
 * Subscribe to entries whose root is `name`, serializing each the moment it is
 * queued — the earliest point any uploader could serialize it. `onEntry`
 * replays history, so filter on a name unique to the test.
 */
function watchRoot(name: string): { seen: Span[]; stop: () => void } {
  const seen: Span[] = [];
  const cb = (entry: Tracing.LjsonEntry) => {
    if (entry.rootSpan.name === name) {
      seen.push(JSON.parse(JSON.stringify(entry.rootSpan)));
    }
  };
  Tracing.onEntry(cb);
  return { seen, stop: () => Tracing.removeOnEntry(cb) };
}

function allDurations(span: Span): number[] {
  return [span.durationMs, ...span.children.flatMap((c) => c.type === "span" ? allDurations(c) : [])];
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("a sync root waits for its un-awaited async child before it is queued", async () => {
  drain();
  const { seen, stop } = watchRoot("app-command/held-root");
  try {
    let child: Promise<void> = Promise.resolve();
    // The shape of an app-command that fires an api-call without awaiting it:
    // the root ends in ~0ms, the fetch resolves hundreds of ms later.
    Tracing.span("app-command/held-root", () => {
      child = Tracing.span("api-call", async (s) => {
        s.record("http.method", "GET");
        s.record("http.path", "/api/user/catalog");
        await delay(40);
        s.record("http.status", 200);
      });
    });
    assertEquals(seen.length, 0, "root must not be queued while its child is in flight");

    await child;
    assertEquals(seen.length, 1);
    const apiCall = seen[0].children.find((c) => c.name === "api-call");
    assertEquals(apiCall?.attributes["http.status"], 200);
    assertEquals(apiCall?.attributes["trace.unsettled"], undefined);
    assertEquals(seen[0].attributes["trace.flush"], undefined);
    for (const d of allDurations(seen[0])) {
      assertEquals(d >= 0, true, `negative durationMs ${d}`);
    }
    assertEquals((apiCall?.durationMs ?? 0) >= 30, true, "child duration covers the fetch");
  } finally {
    stop();
    drain();
  }
});

Deno.test("nested async descendants all hold the root; an awaited async root is unchanged", async () => {
  drain();
  const { seen, stop } = watchRoot("app-command/nested");
  try {
    let grandchild: Promise<void> = Promise.resolve();
    await Tracing.span("app-command/nested", async () => {
      await Tracing.span("outer", () => {
        grandchild = Tracing.span("inner-api-call", async (s) => {
          await delay(30);
          s.record("http.status", 204);
        });
        return Promise.resolve();
      });
    });
    assertEquals(seen.length, 0, "the grandchild is still in flight");
    await grandchild;
    assertEquals(seen.length, 1);
    const inner = seen[0].children[0].children[0];
    assertEquals(inner.name, "inner-api-call");
    assertEquals(inner.attributes["http.status"], 204);
    for (const d of allDurations(seen[0])) assertEquals(d >= 0, true);
  } finally {
    stop();
    drain();
  }
});

Deno.test("a child that never settles still flushes its root after the settle cap", async () => {
  drain();
  const { seen, stop } = watchRoot("app-command/never-settles");
  Tracing.configure({ settleCapMs: 30 });
  try {
    Tracing.span("app-command/never-settles", () => {
      void Tracing.span("api-call", (_s) => new Promise<void>(() => {}));
    });
    assertEquals(seen.length, 0);
    await delay(80);
    assertEquals(seen.length, 1, "the cap must queue the root anyway");
    assertEquals(seen[0].attributes["trace.flush"], "settle-cap");
    assertEquals(seen[0].attributes["trace.pendingChildren"], 1);
    const apiCall = seen[0].children[0];
    assertEquals(apiCall.attributes["trace.unsettled"], true);
    for (const d of allDurations(seen[0])) assertEquals(d >= 0, true, `negative durationMs ${d}`);
  } finally {
    Tracing.configure({ settleCapMs: 15_000 });
    stop();
    drain();
  }
});

Deno.test("releaseHeld queues a held root immediately (page hide)", async () => {
  drain();
  const { seen, stop } = watchRoot("app-command/page-hide");
  try {
    let child: Promise<void> = Promise.resolve();
    Tracing.span("app-command/page-hide", () => {
      child = Tracing.span("api-call", async () => {
        await delay(20);
      });
    });
    Tracing.releaseHeld();
    assertEquals(seen.length, 1);
    assertEquals(seen[0].attributes["trace.flush"], "page-hide");
    // Settling afterwards must not queue the root a second time.
    await child;
    assertEquals(seen.length, 1);
  } finally {
    stop();
    drain();
  }
});
