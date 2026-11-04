import type { Option } from "./option";
/**
 * @tento-trace tracing — Client-side span tracing.
 *
 * Produces LJSON entries (origin:"client") that graft with server request
 * logs when viewed through `logs.render` / `ux-test trace`.
 *
 * Usage:
 *   import { Tracing } from "@tento-trace";
 *
 *   await Tracing.span("create-sheet", async () => {
 *     const sheet = await LonaApi.post("/api/sheets", { body });
 *     Tracing.event("info", "Sheet created", { sheet_id: sheet.id });
 *   });
 */

import {
  type LogFunction,
  type LogFunctionWithCategory,
  type LogSink,
  Logger,
} from "./log";
import { Uuid } from "./uuid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Level = "trace" | "debug" | "info" | "warn" | "error";

type SpanNode = {
  id: number;
  name: string;
  level: Level;
  startMs: number;
  endMs: number;
  /** Set once `endMs` is final. A span serialized before it ends is marked. */
  ended: boolean;
  attributes: Record<string, unknown>;
  children: ChildNode[];
  /** The root span this span reports through; `null` for a root itself. */
  rootNode: Option<SpanNode>;
  // Root-only bookkeeping (unused on non-root spans). A root is queued once it
  // has ended AND every async descendant has settled — see `endRoot`.
  /** Async descendants still in flight. */
  pendingChildren: number;
  /** Already handed to `enqueue` — never queued twice. */
  queued: boolean;
  /** The root itself threw/rejected. */
  failed: boolean;
  /** Wall time the root ended; the entry's `ts` (not the later queue time). */
  endedAtIso: Option<string>;
  /** Safety cap for a descendant that never settles. */
  capTimer: Option<ReturnType<typeof setTimeout>>;
};

type EventNode = {
  level: Level;
  attributes: Record<string, unknown>;
};

type ChildNode =
  | { type: "span"; span: SpanNode }
  | { type: "event"; event: EventNode };

type _LjsonEntry = {
  v: 1;
  ts: string;
  sessionId: string;
  origin: "client";
  rootSpan: LjsonSpan;
};

type LjsonSpan = {
  id: number;
  name: string;
  level: Level;
  durationMs: number;
  location: { file?: string; line?: number };
  attributes: Record<string, unknown>;
  children: LjsonChild[];
};

type LjsonChild =
  | { type: "span" } & LjsonSpan
  | { type: "event" } & LjsonEvent;

type LjsonEvent = {
  level: Level;
  location: {};
  attributes: Record<string, unknown>;
};

type SpanHandle = {
  record(key: string, value: unknown): void;
  setLevel(level: Level): void;
  event(level: Level, message: string, attributes?: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let nextId = 1;
let sessionId: string = Uuid.make();
const activeSpans: SpanNode[] = [];
let buffer: _LjsonEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let uploadUrls: string[] = [];
let configured = false;

const FLUSH_INTERVAL_MS = 2_000;

/**
 * How long an ended root waits for its in-flight async children before it is
 * queued anyway. A root (e.g. a 2ms `app-command/*`) that fires an `api-call`
 * without awaiting it used to be queued immediately, so an uploader that
 * serialized it before the fetch resolved shipped the child with no
 * `http.status` and a negative `durationMs` — and trace verification, which
 * matches `"<status> <METHOD> <path>"`, lost the evidence. On a LAN the fetch
 * won the race; over the WAN (300–700ms to rc) it does not. The cap only bounds
 * a child that never settles; such an entry is marked `trace.flush`.
 */
const SETTLE_CAP_MS_DEFAULT = 15_000;
let settleCapMs = SETTLE_CAP_MS_DEFAULT;
/** Ended roots waiting on async children — released early on page hide. */
const heldRoots: Set<SpanNode> = new Set();

// ---------------------------------------------------------------------------
// Observer mechanism
// ---------------------------------------------------------------------------

const RECENT_ENTRIES_CAP = 500;
/**
 * Bound on the un-flushed `buffer` while no sink is configured. The buffer is
 * retained (rather than discarded) so the pre-`configure()` window survives to
 * be uploaded; this keeps that retention from growing without limit in a
 * process that never installs a sink.
 */
const PENDING_BUFFER_CAP = 2000;
const recentEntries: _LjsonEntry[] = [];
const entryCallbacks: Set<(entry: _LjsonEntry) => void> = new Set();

// ---------------------------------------------------------------------------
// LJSON serialization
// ---------------------------------------------------------------------------

function toSpan(node: SpanNode, nowMs: number): LjsonSpan {
  // A span still running when its root is force-queued (settle cap, page hide)
  // reports its elapsed time so far and says so, instead of `0 - startMs`.
  return {
    id: node.id,
    name: node.name,
    level: node.level,
    durationMs: Math.round((node.ended ? node.endMs : nowMs) - node.startMs),
    location: {},
    attributes: node.ended
      ? node.attributes
      : { ...node.attributes, "trace.unsettled": true },
    children: node.children.map((child) => toChild(child, nowMs)),
  };
}

function toChild(child: ChildNode, nowMs: number): LjsonChild {
  if (child.type === "span") {
    return { type: "span", ...toSpan(child.span, nowMs) };
  }
  return {
    type: "event",
    level: child.event.level,
    location: {},
    attributes: child.event.attributes,
  };
}

type ForcedFlush = "settle-cap" | "page-hide";

function toEntry(root: SpanNode, forced: Option<ForcedFlush>): _LjsonEntry {
  const rootSpan = toSpan(root, performance.now());
  if (forced) {
    rootSpan.attributes = {
      ...rootSpan.attributes,
      "trace.flush": forced,
      "trace.pendingChildren": root.pendingChildren,
    };
  }
  return {
    v: 1,
    ts: root.endedAtIso ?? new Date().toISOString(),
    sessionId,
    origin: "client",
    rootSpan,
  };
}

// ---------------------------------------------------------------------------
// Root lifecycle — a root is queued when it has ended AND its async
// descendants have settled (or the settle cap / page hide forces it).
// ---------------------------------------------------------------------------

function rootOf(node: SpanNode): SpanNode {
  return node.rootNode ?? node;
}

function endRoot(root: SpanNode): void {
  root.endedAtIso = new Date().toISOString();
  if (root.pendingChildren === 0) {
    queueRoot(root, null);
    return;
  }
  heldRoots.add(root);
  root.capTimer = setTimeout(() => {
    root.capTimer = null;
    queueRoot(root, "settle-cap");
  }, settleCapMs);
}

function childSettled(root: SpanNode): void {
  root.pendingChildren--;
  if (root.ended && !root.queued && root.pendingChildren === 0) {
    queueRoot(root, null);
  }
}

function queueRoot(root: SpanNode, forced: Option<ForcedFlush>): void {
  if (root.queued) return;
  root.queued = true;
  heldRoots.delete(root);
  if (root.capTimer != null) {
    clearTimeout(root.capTimer);
    root.capTimer = null;
  }
  enqueue(toEntry(root, forced), root.failed || hasErrorChild(root));
}

function releaseHeldRoots(): void {
  for (const root of [...heldRoots]) {
    queueRoot(root, "page-hide");
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function scheduleFlush(): void {
  // No upload sink configured (Deno tests, Node CLI, ad-hoc scripts)
  // — scheduling a timer would leak into Deno's test sanitizer.
  // `buffer` keeps accumulating (bounded by PENDING_BUFFER_CAP) so nothing
  // emitted before a sink exists is lost, and `configure()` calls back here to
  // re-arm the moment one arrives.
  if (uploadUrls.length === 0) return;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

function flush(): void {
  if (buffer.length === 0) return;

  // Check for a sink BEFORE taking the buffer. Doing it the other way round
  // destroyed every span emitted before `configure()` installed a sink — which
  // is the whole boot window, including the app-command dispatch a UX test is
  // usually there to observe. Five ledger entries once concluded from that
  // absence that the product never dispatched; it had, and the evidence was
  // deleted before anyone asked for it.
  if (uploadUrls.length === 0) return;

  const entries = buffer;
  buffer = [];

  const payload = JSON.stringify({ entries });
  for (const url of uploadUrls) {
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {
        // Fire-and-forget — don't retry
      });
    } catch {
      // Ignore errors
    }
  }
}

function flushSync(): void {
  if (buffer.length === 0) return;
  // Same rule as `flush`: with no sink there is nothing to send, so retain the
  // entries rather than discarding them. A page hidden before `configure()`
  // used to lose its whole boot window here.
  if (uploadUrls.length === 0) return;

  const entries = buffer;
  buffer = [];

  if (typeof navigator !== "undefined") {
    const payload = JSON.stringify({ entries });
    for (const url of uploadUrls) {
      navigator.sendBeacon(
        url,
        new Blob([payload], { type: "application/json" }),
      );
    }
  }
}

function flushImmediate(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

function enqueue(entry: _LjsonEntry, hasError: boolean): void {
  buffer.push(entry);

  // With no sink the buffer is never drained, so it needs its own bound —
  // retaining the pre-`configure()` window must not become an unbounded leak in
  // a process that never configures one (Deno tests, Node CLI, ad-hoc scripts).
  // Oldest-out, like `recentEntries`. In a browser this is unreachable:
  // `configure()` runs during boot, long before 2000 spans accumulate.
  if (uploadUrls.length === 0 && buffer.length > PENDING_BUFFER_CAP) {
    buffer.shift();
  }

  // Push to ring buffer and notify observers
  recentEntries.push(entry);
  if (recentEntries.length > RECENT_ENTRIES_CAP) {
    recentEntries.shift();
  }
  for (const cb of entryCallbacks) {
    try {
      cb(entry);
    } catch {
      // Must not break enqueue pipeline
    }
  }

  if (hasError) {
    flushImmediate();
  } else {
    scheduleFlush();
  }
}

// ---------------------------------------------------------------------------
// Span context helpers
// ---------------------------------------------------------------------------

function currentSpan(): SpanNode | null {
  if (activeSpans.length === 0) return null;
  return activeSpans[activeSpans.length - 1];
}

function makeHandle(node: SpanNode): SpanHandle {
  return {
    record(key, value) {
      node.attributes[key] = value;
    },
    setLevel(level) {
      node.level = level;
    },
    event(level, message, attributes) {
      node.children.push({
        type: "event",
        event: { level, attributes: { message, ...attributes } },
      });
    },
  };
}

function hasErrorChild(node: SpanNode): boolean {
  if (node.level === "error") return true;
  for (const child of node.children) {
    if (child.type === "event" && child.event.level === "error") return true;
    if (child.type === "span" && hasErrorChild(child.span)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export namespace Tracing {
  // Console logging facade. These are installed as accessors below so they
  // always point at Logger's current bindings after install/reinstall.
  export let info: LogFunctionWithCategory;
  export let warn: LogFunctionWithCategory;
  export let err: LogFunctionWithCategory;
  export let dbg: LogFunction;
  export let dev: LogFunction;
  export let noop: LogFunctionWithCategory;
  export let admin: typeof Logger.admin;

  export const addSink: (sink: LogSink) => void = Logger.addSink;
  export const removeSink: (sink: LogSink) => void = Logger.removeSink;
  export const setFrameContext = Logger.setFrameContext;
  export const install = Logger.install;
  export const installToConsole = Logger.installToConsole;
  export const flushStart = Logger.flushStart;
  export const flushEnd = Logger.flushEnd;

  /**
   * Configure the upload endpoint URL and optional session ID override.
   * Must be called before spans will be uploaded.
   */
  export function configure(opts: {
    /** Single sink URL (back-compat). Prefer `sinks` for one-or-many. */
    uploadUrl?: string;
    /**
     * Destination URL(s) the trace stream POSTs/beacons to. A batch lets the
     * client fan out (e.g. a UX-test sink + a telemetry sink). The host passes
     * these in — typically `Network.*`-codegenerated route URLs from tento-web
     * — so this package stays free of any API-client dependency.
     */
    sinks?: string | string[];
    sessionId?: string;
    /**
     * Override how long an ended root waits for in-flight async children
     * before it is queued anyway (default 15s). Tests shorten it.
     */
    settleCapMs?: number;
  }): void {
    if (opts.settleCapMs !== undefined) {
      settleCapMs = opts.settleCapMs;
    }
    if (opts.sinks !== undefined) {
      uploadUrls = Array.isArray(opts.sinks) ? [...opts.sinks] : [opts.sinks];
    } else if (opts.uploadUrl !== undefined) {
      uploadUrls = [opts.uploadUrl];
    }
    if (opts.sessionId) {
      sessionId = opts.sessionId;
    }

    // A sink just arrived, and `buffer` may already hold the whole boot window.
    // Without this the retained entries wait for the next `enqueue` to schedule
    // a flush — and a page that emits nothing further would never send them.
    scheduleFlush();

    // Install page visibility handler for flush-on-hide (once)
    if (!configured && typeof document !== "undefined") {
      configured = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushSync();
        }
      });
    }
  }

  /**
   * Execute a callback inside a named span.
   *
   * Supports both sync and async callbacks. When async, the span closes
   * after the promise settles.
   *
   * Returns the callback's return value.
   */
  export function span<T>(name: string, fn: (span: SpanHandle) => T): T {
    const parent = currentSpan();
    const node: SpanNode = {
      id: nextId++,
      name,
      level: "info",
      startMs: performance.now(),
      endMs: 0,
      ended: false,
      attributes: {},
      children: [],
      rootNode: parent ? rootOf(parent) : null,
      pendingChildren: 0,
      queued: false,
      failed: false,
      endedAtIso: null,
      capTimer: null,
    };

    if (parent) {
      parent.children.push({ type: "span", span: node });
    }

    activeSpans.push(node);

    let result: T;
    try {
      result = fn(makeHandle(node));
    } catch (e) {
      node.level = "error";
      node.endMs = performance.now();
      node.ended = true;
      activeSpans.pop();
      if (!parent) {
        node.failed = true;
        endRoot(node);
      }
      throw e;
    }

    // Async path: the callback returned a promise.
    // Pop immediately so concurrent async spans don't falsely nest.
    // The parent-child link is already established (line 279), and all
    // record() calls in fn() happen synchronously before the first await.
    // An async descendant holds its root open: the root is not queued until
    // this settles (see `endRoot`), so attributes recorded after the await —
    // `http.status` on an `api-call` — are in the entry the uploader ships.
    if (result instanceof Promise) {
      activeSpans.pop();
      const root = node.rootNode;
      if (root) root.pendingChildren++;
      return result.then(
        (val) => {
          node.endMs = performance.now();
          node.ended = true;
          if (root) {
            childSettled(root);
          } else {
            endRoot(node);
          }
          return val;
        },
        (err) => {
          node.level = "error";
          node.endMs = performance.now();
          node.ended = true;
          if (root) {
            childSettled(root);
          } else {
            node.failed = true;
            endRoot(node);
          }
          throw err;
        },
      ) as T;
    }

    // Sync path
    node.endMs = performance.now();
    node.ended = true;
    activeSpans.pop();
    if (!parent) {
      endRoot(node);
    }
    return result;
  }

  /**
   * Record a key-value attribute on the current span.
   * No-op if no span is active.
   */
  export function record(key: string, value: unknown): void {
    const s = currentSpan();
    if (s) {
      s.attributes[key] = value;
    }
  }

  /**
   * Structured trace log.
   * Creates a span with the given label and records each data entry as an attribute.
   */
  export function log(label: string, data: Option<Record<string, unknown>>): void {
    span(label, () => {
      if (data) {
        for (const [k, v] of Object.entries(data)) {
          record(k, v);
        }
      }
    });
  }

  /**
   * @deprecated Use `Tracing.log`; there is no special LLM-specific behavior.
   */
  export function llm(label: string, data?: Option<Record<string, unknown>>): void {
    log(label, data ?? null);
  }

  /**
   * Record an event on the current span.
   */
  export function event(
    level: Level,
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    const s = currentSpan();
    if (!s) return;
    s.children.push({
      type: "event",
      event: {
        level,
        attributes: { message, ...attributes },
      },
    });
  }

  /**
   * Override the level of the current span.
   */
  export function setLevel(level: Level): void {
    const s = currentSpan();
    if (s) {
      s.level = level;
    }
  }

  /**
   * Returns the session ID for this tracing session.
   */
  export function getSessionId(): string {
    return sessionId;
  }

  /**
   * Returns true if there's an active span context.
   */
  export function isActive(): boolean {
    return activeSpans.length > 0;
  }

  /**
   * Flush all buffered tracing entries immediately using async fetch.
   */
  export function flush(): void {
    flushImmediate();
  }

  /**
   * Flush all buffered tracing entries synchronously using sendBeacon.
   * Safe to call during page unload.
   */
  export function flushBeacon(): void {
    releaseHeldRoots();
    flushSync();
  }

  /**
   * Queue every ended root still waiting on in-flight async children, now,
   * marked `trace.flush: "page-hide"` (unfinished children carry
   * `trace.unsettled`). Call on page hide / unload and before a session
   * completes: a held root is not yet in any buffer, so without this it would
   * die with the document.
   */
  export function releaseHeld(): void {
    releaseHeldRoots();
  }

  /**
   * Subscribe to completed root span entries.
   * Replays recent entries (up to 500) then subscribes for future entries.
   */
  export function onEntry(cb: (entry: LjsonEntry) => void): void {
    for (const entry of recentEntries) {
      try {
        cb(entry);
      } catch {
        // Must not break replay
      }
    }
    entryCallbacks.add(cb);
  }

  /**
   * Unsubscribe from entry notifications.
   */
  export function removeOnEntry(cb: (entry: LjsonEntry) => void): void {
    entryCallbacks.delete(cb);
  }

  // Re-export via alias (can't use `export type { X }` in namespaces)
  export type LjsonEntry = _LjsonEntry;
  export type Handle = SpanHandle;

  // ---------------------------------------------------------------------------
  // Witnesses — reusable detectors for loop / thrash / hang patterns.
  // Every primitive emits via `Tracing.log("witness/<kind>", …)` on the
  // trip transition. Throttling + state lives in each instance.
  //
  // Convention: construct once at module scope (or per long-lived
  // instance), never per-call. The `name` arg is the instance identity
  // in `logs.render --session` queries — make it specific (e.g.
  // `"events-facade/refresh"`, `"sheet-invalidation/loop"`).
  // ---------------------------------------------------------------------------

  export namespace Witness {
    /** Thrown by `Reentrancy.enter` when called nested in "throw" mode. */
    export class ReentrancyError extends Error {
      readonly witnessName: string;
      constructor(
        witnessName: string,
        public readonly context: Option<Record<string, unknown>>,
      ) {
        super(
          `Reentrancy: '${witnessName}' called while already active`,
        );
        this.name = "ReentrancyError";
        this.witnessName = witnessName;
      }
    }

    /**
     * Sliding-window counter. `observe(id)` returns "ok" while the
     * per-id count in the last `windowMs` is at or below `threshold`,
     * "tripped" otherwise. The first cross into "tripped" within a
     * window emits `Tracing.log("witness/rate-limit", …)`; subsequent
     * observations stay "tripped" but don't re-emit until the window
     * decays past or `reset()` is called.
     *
     * Caller decides whether to skip the op on "tripped" — primitive
     * only observes + emits. Pair with `Logger.err` at the call site
     * if console-visible operator alerts are needed.
     */
    export class RateLimit {
      private readonly name_: string;
      private readonly windowMs_: number;
      private readonly threshold_: number;
      /**
       * Per id, the times of its observations still inside the window,
       * oldest first, from `head` on (a queue: the drained prefix is cut
       * off in bulk). `observe` counts one id, so it touches only that id's
       * queue: O(1) amortized, where a single shared list made a burst of N
       * observations cost O(N²).
       */
      private readonly byId = new Map<string, { times: number[]; head: number }>();
      /** When `byId` last dropped the ids with nothing left in the window. */
      private lastSweepAt = 0;
      // `null` = never emitted; `number` = wall time of last emit.
      // The first trip always emits; subsequent trips within the
      // window are suppressed.
      private lastEmitAt: number | null = null;

      constructor(opts: {
        name: string;
        windowMs: number;
        threshold: number;
      }) {
        this.name_ = opts.name;
        this.windowMs_ = opts.windowMs;
        this.threshold_ = opts.threshold;
      }

      observe(
        id: string,
        context: Option<Record<string, unknown>>,
      ): "ok" | "tripped" {
        const now = performance.now();
        const cutoff = now - this.windowMs_;
        // Once per window, forget the ids whose observations all aged out,
        // so ids seen once do not accumulate.
        if (now - this.lastSweepAt > this.windowMs_) {
          this.lastSweepAt = now;
          for (const [key, q] of this.byId) {
            const last = q.times[q.times.length - 1];
            if (last === undefined || last < cutoff) this.byId.delete(key);
          }
        }
        let q = this.byId.get(id);
        if (q === undefined) {
          q = { times: [], head: 0 };
          this.byId.set(id, q);
        }
        // Drain this id's entries older than the window (the same test the
        // shared list applied to every id).
        while (q.head < q.times.length && q.times[q.head]! < cutoff) q.head++;
        if (q.head > 32 && q.head * 2 > q.times.length) {
          q.times = q.times.slice(q.head);
          q.head = 0;
        }
        q.times.push(now);
        const count = q.times.length - q.head;
        if (count <= this.threshold_) return "ok";
        // Tripped — emit on first trip ever, then throttle to once
        // per window. Marked at "error" level so ux-test runners
        // with `auto_fail_on_errors: true` catch it without each
        // test having to declare it in `forbidden_logs`.
        if (
          this.lastEmitAt == null ||
          now - this.lastEmitAt > this.windowMs_
        ) {
          this.lastEmitAt = now;
          span("witness/rate-limit", (s) => {
            s.record("name", this.name_);
            s.record("id", id);
            s.record("count", count);
            s.record("windowMs", this.windowMs_);
            s.record("threshold", this.threshold_);
            if (context) {
              for (const [k, v] of Object.entries(context)) s.record(k, v);
            }
            setLevel("error");
          });
        }
        return "tripped";
      }

      reset(): void {
        this.byId.clear();
        this.lastSweepAt = 0;
        this.lastEmitAt = null;
      }
    }

    /**
     * Detects re-entry into an op already in progress. `enter()`
     * returns an `exit` thunk; calling it pops the active state. If
     * `enter()` is called while already active, emits
     * `Tracing.log("witness/reentry", …)` and either throws
     * `ReentrancyError` (mode "throw") or just logs (mode "log").
     *
     * Usage:
     *   const exit = witness.enter({ rowId });
     *   try { …work… } finally { exit(); }
     */
    export class Reentrancy {
      private readonly name_: string;
      private readonly onReentry_: "log" | "throw";
      private active: number = 0;

      constructor(opts: { name: string; onReentry: "log" | "throw" }) {
        this.name_ = opts.name;
        this.onReentry_ = opts.onReentry;
      }

      enter(context: Option<Record<string, unknown>>): () => void {
        if (this.active > 0) {
          // Emit at "error" level so `auto_fail_on_errors: true`
          // catches re-entry without each ux-test declaring it.
          span("witness/reentry", (s) => {
            s.record("name", this.name_);
            s.record("activeDepth", this.active);
            s.record("mode", this.onReentry_);
            if (context) {
              for (const [k, v] of Object.entries(context)) s.record(k, v);
            }
            setLevel("error");
          });
          if (this.onReentry_ === "throw") {
            throw new ReentrancyError(this.name_, context);
          }
        }
        this.active++;
        let exited = false;
        return () => {
          if (exited) return;
          exited = true;
          this.active--;
        };
      }

      /** Active call depth — `0` when no calls are in progress. */
      get depth(): number {
        return this.active;
      }
    }

    /**
     * Async watchdog. `arm(timeoutMs)` returns a `disarm` thunk; if
     * not called within `timeoutMs`, emits
     * `Tracing.log("witness/watchdog", …)` with elapsed time.
     * Multiple concurrent arms are fine (each tracked independently
     * by `armId`). Disarm-after-fire is a safe no-op.
     *
     * Usage:
     *   const disarm = watchdog.arm(2000, { eventId });
     *   try { await persist(); } finally { disarm(); }
     */
    /**
     * Timer/clock seam so tests can drive Watchdog deterministically
     * instead of racing real setTimeout delays. Defaults to the real
     * clock — no behaviour change for production callers.
     */
    export type WatchdogClock = {
      now(): number;
      setTimeout(fn: () => void, ms: number): Timeout;
      clearTimeout(id: Timeout): void;
    };

    type WatchdogScheduler = {
      now(): number;
      schedule(fn: () => void, ms: number): () => void;
    };

    const systemWatchdogClock: WatchdogScheduler = {
      now: () => performance.now(),
      schedule: (fn, ms) => {
        const clear = clearTimeout;
        const timer = setTimeout(fn, ms);
        return () => clear(timer);
      },
    };

    export class Watchdog {
      private readonly name_: string;
      private readonly clock_: WatchdogScheduler;
      private nextArmId: number = 0;
      // One shared timer sweeps a deadline map instead of one
      // setTimeout+clearTimeout pair per bounded op — traced hot loops arm
      // hundreds of times a second and the install/clear overhead itself
      // showed in profiles. Disarm is a map delete; the timer tracks only
      // the earliest live deadline.
      private readonly armsById = new Map<
        number,
        {
          deadline: number;
          startedAt: number;
          timeoutMs: number;
          context: Option<Record<string, unknown>>;
        }
      >();
      private sweepTimer: Option<() => void> = null;
      private sweepDeadline = Infinity;

      constructor(opts: { name: string; clock?: WatchdogClock }) {
        this.name_ = opts.name;
        const clock = opts.clock;
        this.clock_ = clock == null ? systemWatchdogClock : {
          now: () => clock.now(),
          schedule: (fn, ms) => {
            const clear = clock.clearTimeout.bind(clock);
            const timer = clock.setTimeout(fn, ms);
            return () => clear(timer);
          },
        };
      }

      arm(
        timeoutMs: number,
        context: Option<Record<string, unknown>>,
      ): () => void {
        const armId = this.nextArmId++;
        const startedAt = this.clock_.now();
        const deadline = startedAt + timeoutMs;
        this.armsById.set(armId, { deadline, startedAt, timeoutMs, context });
        if (deadline < this.sweepDeadline) this.schedule(deadline);
        // Disarm-after-fire stays a safe no-op: the sweep deletes fired arms.
        return () => {
          this.armsById.delete(armId);
        };
      }

      private schedule(deadline: number) {
        if (this.sweepTimer != null) this.sweepTimer();
        this.sweepDeadline = deadline;
        this.sweepTimer = this.clock_.schedule(
          () => this.sweep(),
          Math.max(0, deadline - this.clock_.now()),
        );
      }

      private sweep() {
        this.sweepTimer = null;
        this.sweepDeadline = Infinity;
        const now = this.clock_.now();
        let next = Infinity;
        for (const [armId, a] of this.armsById) {
          if (a.deadline > now) {
            if (a.deadline < next) next = a.deadline;
            continue;
          }
          this.armsById.delete(armId);
          const elapsedMs = now - a.startedAt;
          // Error level — watchdog firing means the bounded op
          // hung; `auto_fail_on_errors` should catch it.
          span("witness/watchdog", (s) => {
            s.record("name", this.name_);
            s.record("armId", armId);
            s.record("timeoutMs", a.timeoutMs);
            s.record("elapsedMs", elapsedMs);
            if (a.context) {
              for (const [k, v] of Object.entries(a.context)) s.record(k, v);
            }
            setLevel("error");
          });
        }
        if (next < Infinity) this.schedule(next);
      }
    }

    /**
     * Counts iterations of a refinement loop. `iter(true)` resets the
     * counter; `iter(false)` increments. When `maxIterations`
     * consecutive `iter(false)` calls accumulate, returns "stuck" and
     * emits `Tracing.log("witness/stuck", …)`. Useful for retry /
     * backoff loops where "no progress" means an upstream is stuck.
     */
    export class StuckState {
      private readonly name_: string;
      private readonly maxIterations_: number;
      private zeroProgressCount: number = 0;

      constructor(opts: { name: string; maxIterations: number }) {
        this.name_ = opts.name;
        this.maxIterations_ = opts.maxIterations;
      }

      iter(
        progress: boolean,
        context: Option<Record<string, unknown>>,
      ): "ok" | "stuck" {
        if (progress) {
          this.zeroProgressCount = 0;
          return "ok";
        }
        this.zeroProgressCount++;
        if (this.zeroProgressCount < this.maxIterations_) return "ok";
        // Error level — stuck-state means an upstream is hung.
        span("witness/stuck", (s) => {
          s.record("name", this.name_);
          s.record("iterations", this.zeroProgressCount);
          s.record("maxIterations", this.maxIterations_);
          if (context) {
            for (const [k, v] of Object.entries(context)) s.record(k, v);
          }
          setLevel("error");
        });
        return "stuck";
      }

      reset(): void {
        this.zeroProgressCount = 0;
      }
    }
  }
}

Object.defineProperties(Tracing, {
  info: { get: () => Logger.info },
  warn: { get: () => Logger.warn },
  err: { get: () => Logger.err },
  dbg: { get: () => Logger.dbg },
  dev: { get: () => Logger.dbg },
  noop: { get: () => Logger.noop },
  admin: { get: () => Logger.admin },
});

/** Shorthand for Tracing.log. */
export const log = Tracing.log;

/** @deprecated Use `Tracing.log`; there is no special LLM-specific behavior. */
export const llm = Tracing.llm;
