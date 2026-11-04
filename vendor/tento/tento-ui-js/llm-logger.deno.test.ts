import "./deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";
import type { HarnessGlobals } from "./harness-protocol.ts";
import { LLMLogger } from "./llm-logger.ts";
import { Logger, tracingLogSink } from "@tento-trace";

// A `?ux=` document that navigates away before its first timed upload (3 s)
// holds its whole boot record — page-load, the initial payload, the auth
// calls — in the buffer when the page hides. The page-hide upload is bounded
// (the browser caps in-flight keepalive bodies at 64 KiB per document), so it
// cannot carry ~150 KB; what it must not do is spend that budget on the newest
// entries and leave the boot record, the part every spec asserts on, behind.

type Posted = { url: string; keepalive: boolean; body: string };
type Entry = { rootSpan: { name: string; attributes: Record<string, unknown> } };

// deno-lint-ignore no-explicit-any
const gt = globalThis as any;

const posted: Posted[] = [];
const listeners = new Map<string, Array<() => void>>();
const timers: Array<() => void> = [];

function installPage(): void {
  const href = "https://dev.lona.so/calendar?ux=ux-logger-session&tid=t1";
  const location = {
    href,
    origin: "https://dev.lona.so",
    pathname: "/calendar",
    search: "?ux=ux-logger-session&tid=t1",
  };
  const history = {
    pushState: () => {},
    replaceState: (_s: unknown, _t: string, url: string) => {
      location.href = url;
      location.search = new URL(url).search;
    },
  };
  let cookie = "";
  Object.defineProperty(gt.document, "cookie", {
    configurable: true,
    get: () => cookie,
    set: (value: string) => {
      const pair = value.split(";")[0];
      const name = pair.split("=")[0];
      const kept = cookie.split("; ").filter((c) => c !== "" && !c.startsWith(`${name}=`));
      cookie = [...kept, pair].join("; ");
    },
  });
  Object.assign(gt.window, {
    location,
    history,
    innerWidth: 1280,
    innerHeight: 800,
    // The timed upload is armed but never fires: the document dies first.
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    addEventListener: (type: string, fn: () => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type)!).push(fn);
    },
    removeEventListener: () => {},
  });
  gt.location = location;
  gt.history = history;
  gt.screen = { width: 1280, height: 800 };
  Object.defineProperty(gt.navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: Blob) => {
      posted.push({ url, keepalive: false, body: `[beacon ${body.size}]` });
      return true;
    },
  });
  gt.fetch = (input: string | URL, init?: RequestInit) => {
    posted.push({
      url: String(input),
      keepalive: init?.keepalive === true,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
}

// The url-param session the page activated, reached through its private
// fields: the buffer and the tracing hook are the logger's own seams.
type Session = {
  entryBuffer: Entry[];
  onEntryCallback: (entry: Entry) => void;
};
function session(): Session {
  return (LLMLogger as unknown as { urlParamSession: Session }).urlParamSession;
}

let activated: Promise<void> | undefined;
async function activate(): Promise<Session> {
  if (!activated) {
    installPage();
    activated = LLMLogger.initFromUrlParam().catch(() => {
      // The session popover needs a real DOM; the session is live before it.
    });
    await activated;
  }
  const s = session();
  assert(s, "the ?ux= session activated");
  return s;
}

/** ~150 KB of boot entries (the size of calendar doc1's boot record). */
function bootRecord(s: Session, count = 75): void {
  for (let i = 0; i < count; i++) {
    s.onEntryCallback({
      rootSpan: { name: `boot-${i}`, attributes: { seq: i, pad: "x".repeat(1_950) } },
    });
  }
}

function unloadEntries(): { names: string[]; bytes: number } {
  const names: string[] = [];
  let bytes = 0;
  for (const p of posted) {
    if (!p.url.endsWith("/_/ux-test/logs")) continue;
    bytes += new TextEncoder().encode(p.body).length;
    const parsed = JSON.parse(p.body) as { entries: Entry[] };
    for (const e of parsed.entries) names.push(e.rootSpan.name);
  }
  return { names, bytes };
}

function hidePage(): void {
  posted.length = 0;
  for (const fn of listeners.get("pagehide") ?? []) fn();
}

Deno.test("a ?ux= page hiding before its first upload sends its boot record, oldest first", async () => {
  const s = await activate();
  s.entryBuffer = [];
  bootRecord(s);
  const first = s.entryBuffer[0].rootSpan.name;
  assertEquals(first, "boot-0");

  hidePage();

  const { names } = unloadEntries();
  assert(names.length > 0, "page-hide uploaded something");
  assertEquals(names[0], "boot-0", `page-hide began with ${names[0]}, not the oldest entry`);
  // What it sent is a contiguous run from the head: no gap in the boot record.
  names.forEach((name, i) => assertEquals(name, `boot-${i}`));
});

Deno.test("a ?ux= page-hide stays inside the keepalive budget and keeps the rest buffered, in order", async () => {
  const s = await activate();
  s.entryBuffer = [];
  bootRecord(s);
  const total = s.entryBuffer.length;

  hidePage();

  const { names, bytes } = unloadEntries();
  assert(bytes <= 64 * 1024, `page-hide queued ${bytes} bytes of keepalive bodies`);
  // Nothing vanishes on a page-hide that turns out to be a tab switch: what was
  // not sent is still buffered, in its original order, for the next upload.
  const left = s.entryBuffer.map((e) => e.rootSpan.name);
  assertEquals(names.length + left.length, total);
  assertEquals([...names, ...left].sort(), Array.from({ length: total }, (_, i) => `boot-${i}`).sort());
  left.forEach((name, i) => {
    if (i > 0) {
      const prev = Number(left[i - 1].slice(5));
      assert(Number(name.slice(5)) > prev, `buffer out of order at ${name}`);
    }
  });
});

Deno.test("a ?ux= page's __uxFlush uploads everything it holds, and resolves after", async () => {
  // The runner awaits this before a spec navigation, so the page-hide budget
  // never decides what survives a document the spec leaves.
  const s = await activate();
  s.entryBuffer = [];
  bootRecord(s);
  posted.length = 0;
  const flush = (gt.window as HarnessGlobals).__uxFlush;
  assert(typeof flush === "function", "the ?ux= page registers __uxFlush");
  await flush();
  const { names } = unloadEntries();
  assertEquals(names, Array.from({ length: 75 }, (_, i) => `boot-${i}`));
  assertEquals(s.entryBuffer.length, 0);
});

Deno.test("a ?ux= page's __uxLogSink detaches the console bridge and attaches it again", async () => {
  // A perf control arm prices what the bridge costs the page: with it detached
  // `Logger` output stops reaching the session log; spans still upload.
  await activate();
  const attach = (gt.window as HarnessGlobals).__uxLogSink;
  assert(typeof attach === "function", "the ?ux= page registers __uxLogSink");
  assert(Logger._sinks.includes(tracingLogSink), "the bridge is attached when the session activates");
  assertEquals(attach(false), false);
  assert(!Logger._sinks.includes(tracingLogSink), "detached");
  assertEquals(attach(false), false, "detaching twice is a no-op");
  assertEquals(attach(true), true);
  assertEquals(Logger._sinks.filter((sink) => sink === tracingLogSink).length, 1, "attached once again");
});
