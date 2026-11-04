// Harness-post sink for agent-driven `ux-test run --auto` against a remote
// target.
//
// The in-page harness posts `/_/ux-test/logs` and `/_/ux-test/complete` to the
// page origin. Under a named profile (rc, ci, prod) that origin is a server
// whose store has never heard of this run's session, so without this process
// the agent's `__lonaUxComplete("success")` lands there, 400s, and the driver
// reports "ended without completing the session" (c37, 2026-09-26). The
// headless runner answers those posts with puppeteer interception
// (`lib/browser.ts`); an agent-driven run has no runner, so `tento-ux-test`
// (src/agent.rs) starts this sidecar on the agent's browser instead. The Rust
// side embeds this file and `lib/harness-sink.ts` (`include_str!`) and writes
// them beside the run, so the script always matches the binary that runs it.
//
//   deno run --no-prompt --cached-only --no-config --no-lock \
//     --allow-net=127.0.0.1:<port> --allow-read=<run-dir> --allow-write=<run-dir> \
//     harness-sink.deno.ts <devtools-url> <session-id> <run-dir> [app-domain ...]
//
// It speaks DevTools directly (no puppeteer) and asks for as little as it can:
//   - `Fetch.enable` on the BROWSER target, which pauses matching requests from
//     every tab, every navigation and the service worker alike — new tabs and
//     OAuth round trips (accounts.google.com and back) need nothing more;
//   - one pattern, `*/_/ux-test/*`, so Google's, Stripe's and the app's own
//     traffic is never paused at all;
//   - a paused request that is not this session's POST is continued untouched
//     (no header is added: the agent's browser authenticates with its own
//     cookies, and the headless path's bearer token has no counterpart here);
//   - a CORS preflight (OPTIONS) for a harness path on an app host is answered
//     here with 204: after an OAuth redirect the page (rc--calendar) posts to
//     the logger's base URL (rc.lona.so), cross-origin, so the POST's own reply
//     carries CORS headers too (`corsHeaders` in lib/harness-sink.ts);
//   - but only for a page on the app's hosts (the app domains, which the driver
//     extends with the launch URL's host and its subdomains): a harness request
//     whose `Origin` is anything else — another site, an opaque `null` — is
//     refused 403 with no CORS headers and nothing written;
//   - `logs.ljson` is capped per run (lib/harness-sink.ts `MAX_LOG_ENTRIES`,
//     `MAX_LOG_BYTES`); past the cap one `sink/cap-reached` entry is written.
// It never opens, closes or activates a page. The driver opens the launch URL
// only after this process says `ready`, so the app's first harness post
// cannot race ahead of the sink.
//
// Status lines on stdout:
//   harness-sink: ready                       (interception on)
//   harness-sink: sunk <path>                 (one per answered post)
//   harness-sink: preflight <path>            (one per answered OPTIONS)
//   harness-sink: refused <path> <origin>     (one per foreign-origin request)
//   harness-sink: stopped                     exit 0 (SIGTERM)
//   harness-sink: closed devtools-closed      exit 1 (the browser went away)
//   harness-sink: error <reason>              exit 1 (could not start)

import {
  answerPreflight,
  HARNESS_COMPLETE,
  HARNESS_LOGS,
  type HarnessSink,
  originAllowed,
  ownsHost,
  type SinkableRequest,
  sinkHarnessPost,
} from "./lib/harness-sink.ts";

export const STATUS = "harness-sink:";

/** The only requests this sidecar ever pauses. Fetch URL patterns are
 *  wildcards over the whole URL (`*` = any run, including none), so this is
 *  "any scheme, any host, a path under `/_/ux-test/`" — the exact paths are
 *  checked again in `harnessPath`. */
export const FETCH_PATTERNS: ReadonlyArray<{ urlPattern: string; requestStage: "Request" }> = [
  { urlPattern: "*/_/ux-test/*", requestStage: "Request" },
];

/** The harness path a paused request is for, or `null` when it is not ours to
 *  answer: not a POST or its CORS preflight (OPTIONS), not one of the two
 *  harness paths, or on a host outside the app's declared domains. An app that
 *  declares no domains is scoped by its session id alone (checked by
 *  `sinkHarnessPost`; a preflight has no body, so it is scoped by path and
 *  host only), because a sink that answers nothing is the bug this file exists
 *  to fix. */
export function harnessPath(url: string, method: string, appDomains: string[]): string | null {
  if (method !== "POST" && method !== "OPTIONS") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname !== HARNESS_LOGS && parsed.pathname !== HARNESS_COMPLETE) return null;
  if (appDomains.length > 0 && !ownsHost(parsed.hostname, appDomains)) return null;
  return parsed.pathname;
}

/** The DevTools calls this file makes. A seam, so a test drives the decisions
 *  with a fake instead of a browser. */
export type Cdp = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
};

/** `Fetch.requestPaused`, as far as this file reads it. */
export type Paused = {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: Array<{ bytes?: string }>;
  };
};

function utf8ToBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
}

/** The body of a paused request: `postData` when DevTools sent it, else the
 *  joined `postDataEntries` (newer Chromes send only those). */
export function pausedBody(paused: Paused): string | undefined {
  if (typeof paused.request.postData === "string") return paused.request.postData;
  const entries = paused.request.postDataEntries ?? [];
  if (entries.length === 0 || entries.some((entry) => typeof entry.bytes !== "string")) return undefined;
  return entries.map((entry) => base64ToUtf8(entry.bytes as string)).join("");
}

/** A paused request as `sinkHarnessPost` sees it. `respond` fulfils it in
 *  Chrome, so it never reaches the page origin. */
export function asSinkable(cdp: Cdp, paused: Paused): SinkableRequest {
  return {
    postData: () => pausedBody(paused),
    hasPostData: () => paused.request.hasPostData === true,
    headers: () => paused.request.headers ?? {},
    respond: ({ status, contentType, headers, body }) => {
      cdp.send("Fetch.fulfillRequest", {
        requestId: paused.requestId,
        responseCode: status,
        responseHeaders: [
          ...(status === 204 ? [] : [{ name: "Content-Type", value: contentType ?? "text/plain" }]),
          ...Object.entries(headers ?? {}).map(([name, value]) => ({ name, value })),
        ],
        body: utf8ToBase64(body ?? ""),
      }).catch((err) => console.error(`${STATUS} fulfil failed: ${err}`));
    },
  };
}

/** Decide one paused request: answer it into the run dir, refuse it, or let it
 *  go on to the server untouched. Never leaves a request paused. */
export async function handlePaused(
  cdp: Cdp,
  paused: Paused,
  options: { sink: HarnessSink; appDomains: string[] },
): Promise<"sunk" | "preflight" | "refused" | "passed"> {
  const path = harnessPath(paused.request.url, paused.request.method, options.appDomains);
  // A harness request is taken, and given CORS, only from a page on the app's
  // own hosts: never a reflected `Origin` with credentials for any site.
  const sink = { ...options.sink, corsHosts: options.sink.corsHosts ?? options.appDomains };
  const headers = paused.request.headers ?? {};
  if (path != null && !originAllowed(headers, sink.corsHosts)) {
    asSinkable(cdp, paused).respond({
      status: 403,
      contentType: "text/plain",
      body: "harness sink: origin not allowed",
    });
    const origin = Object.entries(headers).find(([name]) => name.toLowerCase() === "origin")?.[1] ?? "";
    console.log(`${STATUS} refused ${path} ${slug(origin)}`);
    return "refused";
  }
  if (path != null && paused.request.method === "OPTIONS") {
    answerPreflight(asSinkable(cdp, paused), sink.corsHosts);
    console.log(`${STATUS} preflight ${path}`);
    return "preflight";
  }
  if (path != null) {
    let handled = false;
    try {
      handled = await sinkHarnessPost(asSinkable(cdp, paused), sink, path);
    } catch (err) {
      console.error(`${STATUS} sink failed on ${path}: ${err}`);
    }
    if (handled) {
      console.log(`${STATUS} sunk ${path}`);
      return "sunk";
    }
  }
  await cdp.send("Fetch.continueRequest", { requestId: paused.requestId }).catch((err) =>
    console.error(`${STATUS} continue failed: ${err}`)
  );
  return "passed";
}

/** Turn interception on for the whole browser, scoped to `FETCH_PATTERNS`. */
export async function enableSink(
  cdp: Cdp,
  options: { sink: HarnessSink; appDomains: string[] },
): Promise<void> {
  cdp.on("Fetch.requestPaused", (params) => {
    void handlePaused(cdp, params as unknown as Paused, options);
  });
  await cdp.send("Fetch.enable", { patterns: FETCH_PATTERNS, handleAuthRequests: false });
}

/** A DevTools client over the browser's WebSocket, flat sessions. */
async function connect(browserURL: string): Promise<Cdp & { closed: Promise<string> }> {
  const version = await (await fetch(`${browserURL}/json/version`)).json() as {
    webSocketDebuggerUrl?: string;
  };
  if (!version.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new Error(`websocket: ${(event as ErrorEvent).message ?? "error"}`));
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter?.resolve(message.result ?? {});
    } else if (typeof message.method === "string" && message.sessionId == null) {
      for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
    }
  };
  const closed = new Promise<string>((resolve) => {
    ws.onclose = () => {
      for (const waiter of pending.values()) waiter.reject(new Error("devtools closed"));
      pending.clear();
      resolve("devtools-closed");
    };
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    closed,
  };
}

function slug(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function main(): Promise<number> {
  const [browserURL, sessionId, dir, ...appDomains] = Deno.args;
  if (!browserURL || !sessionId || !dir) {
    console.error(
      "usage: harness-sink.deno.ts <devtools-url> <session-id> <run-dir> [app-domain ...]",
    );
    console.log(`${STATUS} error usage`);
    return 2;
  }
  let cdp: Awaited<ReturnType<typeof connect>>;
  try {
    cdp = await connect(browserURL);
    await enableSink(cdp, { sink: { sessionId, dir, corsHosts: appDomains }, appDomains });
  } catch (err) {
    console.log(`${STATUS} error ${slug(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  console.log(`${STATUS} ready`);
  const stopped = new Promise<string>((resolve) => {
    Deno.addSignalListener("SIGTERM", () => resolve("stopped"));
    Deno.addSignalListener("SIGINT", () => resolve("stopped"));
  });
  const why = await Promise.race([stopped, cdp.closed]);
  if (why === "stopped") {
    console.log(`${STATUS} stopped`);
    return 0;
  }
  // The browser went away under us: nothing left to sink, and the driver
  // decides what that means for the run.
  console.log(`${STATUS} closed ${why}`);
  return 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
