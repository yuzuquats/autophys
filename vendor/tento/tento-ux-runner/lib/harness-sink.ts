// The in-page harness's two posts, and how a process beside the browser
// answers them into a run dir. Shared by the headless runner (`browser.ts`,
// puppeteer interception) and the agent driver's sidecar
// (`harness-sink.deno.ts`, raw DevTools), so both land a remote run's logs and
// completion in exactly the same files.
//
// No imports: the sidecar is written beside a run and executed with
// `--cached-only --no-config`, so this module must stand on its own.

/** Where the page's harness posts land when the runner keeps the session
 *  store itself: the session they belong to, and the run dir that holds
 *  `session.json`, `logs.ljson` and `complete.json`.
 *
 *  `corsHosts` (`ownsHost` patterns), when set, are the only pages a post is
 *  taken from: a request whose `Origin` is on another host, or is opaque
 *  (`null`), is refused `403` with no CORS headers and nothing written. A
 *  request with no `Origin` at all is not a cross-origin one and is taken.
 *  Absent ⇒ any `Origin` is echoed, as the headless runner (whose interception
 *  already scopes the request URL to the app's hosts) has always done. */
export type HarnessSink = { sessionId: string; dir: string; corsHosts?: string[] };

export const HARNESS_LOGS = "/_/ux-test/logs";
export const HARNESS_COMPLETE = "/_/ux-test/complete";

/** At most this many `logs.ljson` lines per run dir, and at most this many
 *  bytes, so a page (or an agent) that floods the harness cannot fill the
 *  disk. Past either, ONE `sink/cap-reached` entry is written and every later
 *  entry is dropped — still answered 200, so the page stops resending. */
export const MAX_LOG_ENTRIES = 50_000;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const LOG_CAP_REACHED = "sink/cap-reached";
export type LogLimits = { maxEntries: number; maxBytes: number };

/** What `sinkHarnessPost` needs of an intercepted request. A puppeteer
 *  request satisfies it, and so does the sidecar's adapter over a paused
 *  `Fetch.requestPaused`. */
export type SinkableRequest = {
  /** The request body, when the page sent one (a harness POST). */
  postData(): string | undefined;
  /** Whether the request carried a body at all, readable or not. */
  hasPostData?(): boolean;
  /** The request headers as the page sent them, in any case. Read for
   *  `Origin` (and a preflight's `Access-Control-Request-Headers`). */
  headers?(): Record<string, string>;
  /** Answer the request from here, without it ever reaching a server. */
  respond(response: {
    status: number;
    contentType?: string;
    headers?: Record<string, string>;
    body?: string;
  }): void;
};

/** A request header by name, whatever case the page (or DevTools) gave it. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The CORS headers a sink reply needs so the page may READ it.
 *
 * The harness posts to its logger's base URL, which is the `ux-test-origin`
 * cookie (rc.lona.so) — not necessarily the page's own origin. After an OAuth
 * redirect the page runs on a sibling host (rc--calendar.lona.so), so every
 * post is cross-origin and credentialed. A 200 with no
 * `Access-Control-Allow-Origin` is a CORS failure to the page: the logger's
 * catch re-buffers the batch and resends it every 3 s, each resend landed again
 * here, and the buffer never drains (c38: 2920 lines for 222 entries, and the
 * middle of every cross-origin page lost at unload).
 *
 * Echo the request's `Origin` — never `*`, which a credentialed request may not
 * accept — and only one `originAllowed` accepts for `corsHosts`. No `Origin`
 * (or an opaque `null` one) ⇒ no CORS headers at all, so a same-origin reply is
 * exactly what it was.
 */
export function corsHeaders(
  requestHeaders: Record<string, string>,
  corsHosts?: string[],
): Record<string, string> {
  const origin = headerValue(requestHeaders, "origin");
  if (!origin || origin === "null") return {};
  if (!originAllowed(requestHeaders, corsHosts)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

/** Whether a request's `Origin` may post to a sink scoped to `corsHosts` (see
 *  `HarnessSink`): no `corsHosts` ⇒ any; no `Origin` ⇒ yes; an opaque `null`
 *  or unparsable one ⇒ no; otherwise its host must be one `corsHosts` owns. */
export function originAllowed(requestHeaders: Record<string, string>, corsHosts?: string[]): boolean {
  if (corsHosts == null) return true;
  const origin = headerValue(requestHeaders, "origin");
  if (origin == null || origin === "") return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return host !== "" && ownsHost(host, corsHosts);
}

/** The headers of a `204` answer to a CORS preflight for a harness path. */
export function preflightHeaders(
  requestHeaders: Record<string, string>,
  corsHosts?: string[],
): Record<string, string> {
  const asked = headerValue(requestHeaders, "access-control-request-headers");
  return {
    ...corsHeaders(requestHeaders, corsHosts),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": asked && asked.trim() !== "" ? asked : "content-type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

/**
 * Answer a CORS preflight (`OPTIONS`) for a harness path from here.
 *
 * A preflight carries no body, so it cannot be matched to a session; the
 * caller scopes it by path and host instead. Answering one that belongs to
 * another session is harmless: the POST that follows is still session-checked
 * by `sinkHarnessPost`, and passed through when it is not ours. A preflight
 * from a page `corsHosts` does not own is refused `403` with no CORS headers,
 * so the browser never sends the POST.
 */
export function answerPreflight(
  req: Pick<SinkableRequest, "headers" | "respond">,
  corsHosts?: string[],
): void {
  const headers = req.headers?.() ?? {};
  if (!originAllowed(headers, corsHosts)) {
    req.respond({ status: 403, body: "" });
    return;
  }
  req.respond({ status: 204, headers: preflightHeaders(headers, corsHosts), body: "" });
}

/** Per run dir: every `logs.ljson` line already written, and how many lines
 *  and bytes that is. A promise so that concurrent posts share one read of the
 *  file; seeded from the file itself so a sink that restarts mid-run (a new
 *  sidecar, a new runner) still refuses a line it wrote before and still
 *  counts it toward the caps. A process that may not read the file (a sidecar
 *  launched with write-only access to it) starts empty and de-duplicates and
 *  counts within its own lifetime only. */
type LogState = { seen: Set<string>; entries: number; bytes: number; capped: boolean };

const logStates = new Map<string, Promise<LogState>>();

const encoder = new TextEncoder();

function emptyLogState(): LogState {
  return { seen: new Set<string>(), entries: 0, bytes: 0, capped: false };
}

function logState(dir: string): Promise<LogState> {
  let state = logStates.get(dir);
  if (state == null) {
    state = Deno.readTextFile(`${dir}/logs.ljson`).then(
      (text) => {
        const lines = text.split("\n").filter((line) => line !== "");
        return {
          seen: new Set(lines),
          entries: lines.length,
          bytes: encoder.encode(text).length,
          capped: lines.some((line) => line.includes(`"name":"${LOG_CAP_REACHED}"`)),
        };
      },
      (err) => {
        if (err instanceof Deno.errors.NotFound) return emptyLogState();
        if (err instanceof Deno.errors.PermissionDenied || (err as Error)?.name === "NotCapable") {
          return emptyLogState();
        }
        throw err;
      },
    );
    state.catch(() => logStates.delete(dir));
    logStates.set(dir, state);
  }
  return state;
}

/** The one entry that says a cap was hit, in the LJSON shape the judge parses
 *  (`v`, `ts`, `sessionId`, `rootSpan`). Its `sessionId` is the batch's own
 *  (the page's tracing id), so it sits with the entries it cut off. */
function capEntry(batch: unknown[], state: LogState, limits: LogLimits): string {
  const withId = batch.find((entry) =>
    entry != null && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string"
  ) as { sessionId: string } | undefined;
  return JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    sessionId: withId?.sessionId ?? "00000000-0000-0000-0000-000000000000",
    origin: "client",
    rootSpan: {
      id: 0,
      name: LOG_CAP_REACHED,
      level: "warn",
      location: {},
      attributes: {
        message:
          `harness sink: logs.ljson reached its cap (${limits.maxEntries} entries / ${limits.maxBytes} bytes); later entries were dropped`,
        maxEntries: limits.maxEntries,
        maxBytes: limits.maxBytes,
        entries: state.entries,
        bytes: state.bytes,
      },
      children: [],
    },
  });
}

/**
 * Append `entries` to the run's `logs.ljson`, each at most once per run, and
 * never past `limits` (`MAX_LOG_ENTRIES` / `MAX_LOG_BYTES` by default).
 *
 * A batch can arrive more than once: the page's logger resends any batch whose
 * reply it could not read, and a retry carries the very same entries. The key
 * is the entry's own serialized line (it carries `sessionId`, `origin`, `ts`
 * and a `rootSpan` with its id), so only a byte-identical entry is dropped —
 * two distinct entries cannot collide. The check, the count and the claim are
 * synchronous after the one await, so two concurrent resends cannot both
 * write, and two concurrent batches cannot both slip under a cap.
 */
export async function appendLogEntries(
  dir: string,
  entries: unknown[],
  limits: LogLimits = { maxEntries: MAX_LOG_ENTRIES, maxBytes: MAX_LOG_BYTES },
): Promise<void> {
  const state = await logState(dir);
  if (state.capped) return;
  const fresh: string[] = [];
  let freshBytes = 0;
  let capReached = false;
  for (const entry of entries) {
    const line = JSON.stringify(entry);
    if (state.seen.has(line)) continue;
    const size = encoder.encode(line).length + 1;
    if (state.entries + 1 > limits.maxEntries || state.bytes + size > limits.maxBytes) {
      capReached = true;
      break;
    }
    state.seen.add(line);
    state.entries += 1;
    state.bytes += size;
    freshBytes += size;
    fresh.push(line);
  }
  const lines = [...fresh];
  if (capReached) {
    state.capped = true;
    lines.push(capEntry(entries, state, limits));
    console.warn(`harness sink: ${dir}/logs.ljson reached its cap; later entries are dropped`);
  }
  if (lines.length === 0) return;
  try {
    await Deno.writeTextFile(`${dir}/logs.ljson`, lines.join("\n") + "\n", { append: true });
  } catch (err) {
    // Not written, so not claimed: the page's resend gets another chance.
    for (const line of fresh) state.seen.delete(line);
    state.entries -= fresh.length;
    state.bytes -= freshBytes;
    if (capReached) state.capped = false;
    throw err;
  }
}

/**
 * Take a harness post the page meant for its origin and land it in the run
 * dir instead.
 *
 * The in-page harness posts `/_/ux-test/logs` and `/_/ux-test/complete` to the
 * PAGE ORIGIN. Locally that origin is the daemon on this machine and its store
 * is this run's directory, so the post and the runner's poll meet. Against a
 * remote target (rc, ci, prod) the origin is a server on another host with a
 * store of its own — one that has never heard of this session — so the post
 * 400s there, the local store never flips, and every remote run ends in
 * "Timeout waiting for session to complete" after its steps ran (every rc run
 * on 2026-09-18). The Chrome that fires the post sits beside the runner, so
 * the runner answers it: entries go to `logs.ljson`, completion to
 * `complete.json` + `session.json`, exactly the files the orchestrator polls.
 *
 * A post for some OTHER session (a second tab, an embedded page with its own
 * `?ux=`) is not ours to answer and is passed through untouched.
 *
 * The reply carries CORS headers for a cross-origin page on an allowed host
 * (`corsHeaders`); this session's post from any other page is refused `403`
 * and not written (`HarnessSink.corsHosts`). Log entries are written once
 * however often the page resends them, and only up to the per-run caps
 * (`appendLogEntries`).
 */
export async function sinkHarnessPost(
  req: SinkableRequest,
  sink: HarnessSink,
  pathname: string,
): Promise<boolean> {
  let body: { sessionId?: unknown; entries?: unknown; result?: unknown; feedback?: unknown };
  const raw = req.postData();
  if (raw == null && req.hasPostData?.()) {
    // The page sent a body DevTools cannot hand us (a Blob beacon at
    // beforeunload). Passing it through reaches a server that has never
    // heard of this session, so its entries would vanish without a trace.
    console.warn(
      `ux-runner: a harness post to ${pathname} carried a body interception could not read; its entries are lost`,
    );
    return false;
  }
  try {
    body = JSON.parse(raw ?? "");
  } catch {
    return false;
  }
  if (body.sessionId !== sink.sessionId) return false;
  const headers = req.headers?.() ?? {};
  if (!originAllowed(headers, sink.corsHosts)) {
    // This session's id from a page that is not the app's: refused, not
    // written, and not passed on either — it was addressed to this run.
    req.respond({ status: 403, contentType: "text/plain", body: "harness sink: origin not allowed" });
    return true;
  }
  const cors = corsHeaders(headers, sink.corsHosts);
  try {
    if (pathname === HARNESS_LOGS) {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length > 0) await appendLogEntries(sink.dir, entries);
    } else {
      const completion = {
        result: body.result,
        ...(typeof body.feedback === "string" && body.feedback !== "" ? { feedback: body.feedback } : {}),
      };
      await Deno.writeTextFile(
        `${sink.dir}/complete.json`,
        JSON.stringify(completion, null, 2) + "\n",
      );
      const sessionPath = `${sink.dir}/session.json`;
      const session = JSON.parse(await Deno.readTextFile(sessionPath));
      session.status = "completed";
      await Deno.writeTextFile(sessionPath, JSON.stringify(session, null, 2) + "\n");
    }
    req.respond({ status: 200, contentType: "application/json", headers: cors, body: "{}" });
  } catch (err) {
    req.respond({ status: 500, contentType: "text/plain", headers: cors, body: `harness sink: ${err}` });
  }
  return true;
}

/** Does `host` belong to one of `domains`? `*.example.com` matches any
 *  subdomain and not the apex; a bare entry matches itself exactly. Mirrors
 *  `AppManifest::owns_host` in `tento-ux-test/src/manifest.rs` — the two must
 *  agree, because one decides what gets rewritten and the other decides what
 *  the plan declares. */
export function ownsHost(host: string, domains: string[]): boolean {
  const target = host.toLowerCase();
  return domains.some((entry) => {
    const domain = entry.toLowerCase();
    return domain.startsWith("*.")
      ? target.endsWith(`.${domain.slice(2)}`)
      : target === domain;
  });
}
