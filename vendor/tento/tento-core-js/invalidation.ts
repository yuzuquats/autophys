/**
 * Invalidation sink — generic infrastructure for domain-specific
 * "what changed" events. A `Sink` accepts `Invalidation` subclass
 * instances and fans them out to subscribers.
 *
 * Event subclasses live with their domain (e.g. `@tento-lona/sheets`
 * defines `RowHeightChanged`, `ColumnDataChanged`, …). The base
 * class here enforces the contract: every event carries an `actor`
 * (origin tag for suppressing optimistic-update echoes), a `path`
 * (REST-style resource identifier for pattern matching), and
 * `.eq()` (value-object identity for dedup).
 */

import { Actor } from "./changeset-key";

export { Actor } from "./changeset-key";

// ── Sink interface ─────────────────────────────────────────────────

/**
 * Where invalidations are emitted and subscribed to; build one with
 * `InvalidationSink.create()`.
 */
export interface InvalidationSink {
  emit(event: Invalidation): void;
  /** Subscribe to every event. Returns unsubscribe function. */
  subscribe(cb: (event: Invalidation) => void): () => void;
}

export namespace InvalidationSink {
  /** Carried by `NOOP` alone, so a seam that needs a live sink can refuse
   *  it in its type (`Live`). */
  export const NOOP_BRAND: unique symbol = Symbol("InvalidationSink.NOOP");

  /** Any sink but `NOOP` — what a consumer that subscribes to its own
   *  sink (e.g. `LonaSdk.Client`) requires. `NOOP` is a type error here. */
  export type Live = InvalidationSink & { readonly [NOOP_BRAND]?: never };

  /**
   * A sink's read face: subscribe to its events, never emit one. What a
   * read-only view hands out (a rows-side sheet's `sheetView`), so holding the
   * view cannot broadcast an invalidation.
   */
  export type Source = Pick<InvalidationSink, "subscribe">;

  /** Every subscribe-only face `sourceOf` built, keyed by its sink (one face per sink). */
  const sources = new WeakMap<InvalidationSink, Source>();

  /**
   * `sink`'s read face (`Source`): a frozen object whose `subscribe` forwards
   * to it, and nothing else — no cast reaches `emit`, `when` or `onEffect`.
   * What a read-only view hands out (`SheetModelReads.invalidationSink`);
   * built once per sink, the same object on every read.
   */
  export function sourceOf(sink: InvalidationSink): Source {
    const cached = sources.get(sink);
    if (cached != null) return cached;
    const face: Source = Object.freeze({
      subscribe: (cb: (event: Invalidation) => void) => sink.subscribe(cb),
    });
    sources.set(sink, face);
    return face;
  }

  /**
   * A routing sink: declare path rules with `when(pattern, ...effects)`,
   * look an event's effects up with `resolve`, route every emit through
   * `onEffect`, and `emit` / `subscribe` as any sink. `E` is the effect type
   * the rules carry (`never` for a sink that only fans events out). What
   * `create()` returns; type a field that holds one as `Routing<E>`.
   */
  export interface Routing<E> extends InvalidationSink {
    /** Declare: when an event's path matches `pattern`, these effects apply. */
    when(pattern: string, ...effects: E[]): this;
    /** The declared effects whose pattern matches `event`'s path. */
    resolve(event: Invalidation): E[];
    /** Register the handler every `emit()` calls synchronously. */
    onEffect(handler: (event: Invalidation) => void): this;
  }

  /** A new routing sink (see `Routing`). */
  export function create<E = never>(): Routing<E> {
    return new InvalidationSinkImpl<E>();
  }

  /** No-op sink for tests and contexts that don't need invalidation. */
  export const NOOP: InvalidationSink & { readonly [NOOP_BRAND]: true } = Object.freeze({
    [NOOP_BRAND]: true as const,
    emit() {},
    subscribe() {
      return () => {};
    },
  });
}

// ── Event base ─────────────────────────────────────────────────────

/**
 * Base class for invalidation events. Events describe what changed
 * in domain terms using a resource path that mirrors the REST API
 * hierarchy.
 *
 * Subclasses carry typed payloads (e.g. rowId, column). `.eq()`
 * defines identity for dedup; subclasses must override.
 */
export abstract class Invalidation {
  constructor(
    readonly actor: Actor,
    readonly path: string,
  ) {}
  abstract eq(other: Invalidation): boolean;
}

export namespace Invalidation {
  /** Does this event's path match the given prefix? */
  export function matches(event: Invalidation, prefix: string): boolean {
    return event.path === prefix || event.path.startsWith(prefix + ".");
  }
}

// ── coalesce ───────────────────────────────────────────────────────

/**
 * Deduplicate events by `.eq()`. Returns a new array with duplicates
 * removed. Does NOT handle effect-level subsumption — that's the
 * consumer's responsibility.
 */
export function coalesce(events: Invalidation[]): Invalidation[] {
  const result: Invalidation[] = [];
  for (const event of events) {
    if (!result.some((e) => e.eq(event))) {
      result.push(event);
    }
  }
  return result;
}

// ── Path matching ─────────────────────────────────────────────────

/**
 * Match an event path against a pattern. Patterns use `*` to match
 * any single segment. A pattern also matches child paths (parent
 * subsumption): `rows.*` matches `rows.abc.label`.
 */
export function pathMatches(eventPath: string, pattern: string): boolean {
  return partsMatch(eventPath.split("."), pattern.split("."));
}

/**
 * Compile a pattern once into a matcher for many paths. Same grammar and
 * result as `pathMatches(path, pattern)`, without the per-call `split`
 * allocations: the pattern's segments are split at compile time and the
 * path is walked segment-by-segment with `indexOf`. Use it wherever one
 * pattern is tested against a stream of events (a structural storm emits
 * tens of thousands of events into one frame, and every subscriber that
 * filters by pattern pays the match per event).
 */
export function compilePathPattern(pattern: string): (eventPath: string) => boolean {
  const pParts = pattern.split(".");
  return (eventPath: string): boolean => segmentsMatch(eventPath, pParts);
}

/**
 * `pathMatches(eventPath, parts.join("."))` without splitting `eventPath`:
 * the path is walked segment by segment with `indexOf` and each segment is
 * compared in place.
 */
function segmentsMatch(eventPath: string, pParts: readonly string[]): boolean {
  let start = 0;
  for (let i = 0; i < pParts.length; i++) {
    if (start > eventPath.length) return false; // fewer segments than the pattern
    let end = eventPath.indexOf(".", start);
    if (end === -1) end = eventPath.length;
    const p = pParts[i]!;
    // Compare the segment in place: same length, then same bytes.
    if (p !== "*" && (end - start !== p.length || !eventPath.startsWith(p, start))) {
      return false;
    }
    start = end + 1;
  }
  return true;
}

function partsMatch(eParts: string[], pParts: string[]): boolean {
  if (pParts.length > eParts.length) return false;
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i] === "*") continue;
    if (pParts[i] !== eParts[i]) return false;
  }
  return true;
}

// ── Sink implementation ────────────────────────────────────────────

/**
 * Invalidation sink with path-based effect mapping (`InvalidationSink.Routing`).
 * Build one with `InvalidationSink.create()`; the class is exported from this
 * module only for a subclass that refines `resolve` (sheets-ui's sheet sink),
 * and is on no `@tento-lona` barrel.
 *
 * Rules are declared via `.when(pathPattern, ...effects)` where the
 * pattern uses `*` for wildcard segments.
 *
 * The sink is stateless — `emit()` calls subscribers synchronously.
 * Handlers are responsible for batching, dedup, and execution.
 *
 * Generic over the effect type so consumers define their own.
 */
export class InvalidationSinkImpl<E> implements InvalidationSink.Routing<E> {
  readonly #rules: Array<{ pattern: string; parts: string[]; effects: E[] }> =
    [];
  #handler: Option<(event: Invalidation) => void> = null;
  readonly #subscribers = new Set<(event: Invalidation) => void>();
  /**
   * The subscribers as `emit` dispatches them, rebuilt after a subscribe or an
   * unsubscribe (`null` until then): an emit reads the array current when it
   * starts, so a re-entrant subscribe or unsubscribe changes the next emit,
   * not this one — without a copy of the set per emit.
   */
  #snapshot: Option<readonly ((event: Invalidation) => void)[]> = null;

  /** Declare: when an event's path matches this pattern, these effects apply. */
  when(pattern: string, ...effects: E[]): this {
    // Patterns are split once at registration: resolve() runs per emit, and
    // a structural-storm frame emits tens of thousands of events — the
    // per-call split allocations were hot enough to show in profiles.
    this.#rules.push({ pattern, parts: pattern.split("."), effects });
    return this;
  }

  /** Look up declared effects for an event by matching its path. */
  resolve(event: Invalidation): E[] {
    // Every rule is matched against the path in place: resolve runs per emit,
    // and splitting each event's path was one array and a string per segment
    // for every cell a data arrival installs.
    const path = event.path;
    const result: E[] = [];
    for (const rule of this.#rules) {
      if (segmentsMatch(path, rule.parts)) {
        for (const effect of rule.effects) result.push(effect);
      }
    }
    return result;
  }

  /** Register the handler. Called synchronously on every `emit()`. */
  onEffect(handler: (event: Invalidation) => void): this {
    this.#handler = handler;
    return this;
  }

  subscribe(cb: (event: Invalidation) => void): () => void {
    this.#subscribers.add(cb);
    this.#snapshot = null;
    return () => {
      this.#subscribers.delete(cb);
      this.#snapshot = null;
    };
  }

  /** Emit an event. Calls the handler and all subscribers synchronously. */
  emit(event: Invalidation): void {
    this.#handler?.(event);
    // The subscribers as of this dispatch (`#snapshot`), so re-entrant
    // subscribe/unsubscribe during handler execution is safe.
    const snapshot = this.#snapshot ??= Array.from(this.#subscribers);
    for (const cb of snapshot) cb(event);
  }
}
