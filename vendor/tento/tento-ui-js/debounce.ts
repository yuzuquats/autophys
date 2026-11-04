import { ServiceWorkerVersion } from "./service-worker-version";
import { Tracing } from "@tento-core/tracing";

/**
 * Keyed trailing-edge debounce with a per-EXECUTION completion.
 *
 * `debounce(key, fn)` queues `fn` under `key`; calls made before the key's
 * timer fires coalesce — only the last `fn` runs — and all of them resolve
 * when that one execution finishes. The contract a durable write settles on
 * (`EventOps.updateDurable`): the promise a call returns resolves when the
 * execution that CARRIED it finishes, never an earlier or later one.
 *
 * - A call's completion is taken out of `completions` the moment its
 *   execution starts (timer fire or `Debounce.flush*`), and handed to that
 *   execution alone. A call made while an execution for the key is already
 *   running finds no completion, creates a new one, and joins the NEXT
 *   execution — so it cannot resolve on the running execution's outcome.
 * - An executor that reports a refusal from inside `fn` (the executors'
 *   `DebouncedRequests.report`) does so before the completion resolves, so
 *   every call the execution carried observes the refusal before its promise
 *   settles.
 * - `fn` throwing is traced and still resolves the completion; an executor
 *   that wants a failure observed reports it before throwing.
 */
const debouncedFns: Map<string, () => Promise<any>> = new Map();
const timeouts: Map<string, Timeout> = new Map();
type Completion = {
  promise: Promise<void>;
  resolve: () => void;
};
/** The completion of the calls queued for each key's NEXT execution. */
const completions: Map<string, Completion> = new Map();

/** Hand the queued calls' completion to the execution starting now for
 *  `key` — a call made from here on awaits the next execution. */
function takeCompletion(key: string): Option<Completion> {
  const completion = completions.get(key) ?? null;
  completions.delete(key);
  return completion;
}

const category = () => (ServiceWorkerVersion.isServiceWorker ? "sw" : "?");

let currentDbn = 0;
type DebounceRun = {
  keys: readonly string[];
  promise: Promise<void>;
};

let currentDebounce: Map<number, DebounceRun> = new Map();

function trackDebounceRun(
  keys: readonly string[],
  run: Promise<void>,
): Promise<void> {
  const idx = currentDbn += 1;
  const tracked = run.finally(() => {
    currentDebounce.delete(idx);
  });
  currentDebounce.set(idx, { keys, promise: tracked });
  return tracked;
}

/** Run one execution and resolve the completion of the calls it carried
 *  (taken when it started — `takeCompletion`), never the map's current one. */
async function runEntry(
  fn: () => Promise<any>,
  completion: Option<Completion>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    Tracing.err(category())(`debounce/run/error`, e);
  } finally {
    completion?.resolve();
  }
}

export function debounce(
  key: any,
  fn: () => Promise<any>,
  durationMs: number = 2_000,
): Promise<void> {
  const serKey = JSON.stringify(key);
  let completion = completions.get(serKey);
  if (!completion) {
    let resolveCompletion: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    completion = { promise, resolve: resolveCompletion };
    completions.set(serKey, completion);
  }
  debouncedFns.set(serKey, fn);
  const existing = timeouts.get(serKey);
  if (existing !== undefined) clearTimeout(existing);
  else Tracing.info(category())(`debounce/queue [prev=${debouncedFns.size}]`);

  timeouts.set(
    serKey,
    setTimeout(async () => {
      const fn = debouncedFns.get(serKey);
      debouncedFns.delete(serKey);
      timeouts.delete(serKey);
      if (fn) {
        const carried = takeCompletion(serKey);
        await trackDebounceRun([serKey], runEntry(fn, carried));
      }
    }, durationMs),
  );
  return completion.promise;
}

export class Debounce {}

export namespace Debounce {
  const FLUSH_TIMEOUT_MS = 10_000;
  const MAX_REPORTED_KEYS = 12;

  export type FlushWaitResult = "ok" | "timeout";

  export type FlushWaitReport = {
    keys: readonly string[];
    durationMs: number;
    result: FlushWaitResult;
  };

  export type FlushReport = {
    queuedStart: number;
    activeStart: number;
    queuedExecuted: number;
    queuedKeys: readonly string[];
    activeWaits: readonly FlushWaitReport[];
    activeWaitMs: number;
    execMs: number;
    durationMs: number;
  };

  function elapsedMs(startMs: number): number {
    return Math.round((performance.now() - startMs) * 10) / 10;
  }

  function matchesEntry(
    entry: DebounceRun,
    shouldFlush: (key: string) => boolean,
  ): boolean {
    return entry.keys.some((key) => shouldFlush(key));
  }

  async function flushByPredicate(
    shouldFlush: (key: string) => boolean,
  ): Promise<FlushReport> {
    // if (globalThis["is-sw"]) {
    //   Tracing.dev("SW FLUSHING", debouncedFns.size);
    // }
    const flushStartMs = performance.now();
    const activeWaits: FlushWaitReport[] = [];
    let activeWaitMs = 0;
    let execMs = 0;
    const queuedStart = debouncedFns.size;
    const activeStart = currentDebounce.size;
    Tracing.info(category())(
      `debounce/flush [# = ${debouncedFns.size}] [active = ${currentDebounce.size}]`,
    );
    while (
      [...currentDebounce.values()].some((entry) =>
        matchesEntry(entry, shouldFlush)
      )
    ) {
      const next = [...currentDebounce.entries()].find(([, entry]) =>
        matchesEntry(entry, shouldFlush)
      );
      if (next === undefined) break;
      const [idx, entry] = next;
      Tracing.info(category())(
        `WAITING FOR DBN idx=${idx} cnt=${currentDebounce.size}`,
      );

      const waitStartMs = performance.now();
      let timeout: Option<ReturnType<typeof setTimeout>> = null;
      const result = await Promise.race([
        entry.promise.then(() => "ok" as const),
        new Promise<"timeout">((r) =>
          timeout = setTimeout(() => r("timeout"), FLUSH_TIMEOUT_MS)
        ),
      ]);
      if (timeout !== null) clearTimeout(timeout);
      const waitMs = elapsedMs(waitStartMs);
      activeWaitMs += waitMs;
      activeWaits.push({
        keys: entry.keys.slice(0, MAX_REPORTED_KEYS),
        durationMs: waitMs,
        result,
      });

      if (result === "timeout") {
        Tracing.err(category())(
          `debounce/flush/TIMEOUT idx=${idx} after ${FLUSH_TIMEOUT_MS}ms - force clearing`,
        );
        currentDebounce.delete(idx);
      }
      Tracing.info(category())(`WAITED FOR DBN id=${idx} result=${result}`);
    }
    const entries = [...debouncedFns.entries()].filter(([key]) =>
      shouldFlush(key)
    );
    const queuedKeys = entries.slice(0, MAX_REPORTED_KEYS).map(([key]) => key);
    if (entries.length === 0) {
      return {
        queuedStart,
        activeStart,
        queuedExecuted: 0,
        queuedKeys,
        activeWaits,
        activeWaitMs,
        execMs,
        durationMs: elapsedMs(flushStartMs),
      };
    }
    const carried = new Map<string, Option<Completion>>();
    for (const [key] of entries) {
      const timeout = timeouts.get(key);
      if (timeout !== undefined) clearTimeout(timeout);
      timeouts.delete(key);
      debouncedFns.delete(key);
      carried.set(key, takeCompletion(key));
    }
    Tracing.info(category())(`debounce/flush/exec [# = ${entries.length}]`);
    try {
      const execStartMs = performance.now();
      await trackDebounceRun(
        entries.map(([key]) => key),
        Promise.all(
          entries.map(([key, fn]) => runEntry(fn, carried.get(key) ?? null)),
        ).then(
          () => {},
        ),
      );
      execMs = elapsedMs(execStartMs);
    } catch (e) {
      Tracing.err(category())(
        `debounce/flush/error [# = ${entries.length}]`,
        e,
      );
    }
    return {
      queuedStart,
      activeStart,
      queuedExecuted: entries.length,
      queuedKeys,
      activeWaits,
      activeWaitMs,
      execMs,
      durationMs: elapsedMs(flushStartMs),
    };
  }

  export async function flush(): Promise<void> {
    await flushByPredicate(() => true);
  }

  export async function flushReport(): Promise<FlushReport> {
    return await flushByPredicate(() => true);
  }

  export async function flushMatching(
    shouldFlush: (key: string) => boolean,
  ): Promise<void> {
    await flushByPredicate(shouldFlush);
  }

  export async function flushMatchingReport(
    shouldFlush: (key: string) => boolean,
  ): Promise<FlushReport> {
    return await flushByPredicate(shouldFlush);
  }
}
