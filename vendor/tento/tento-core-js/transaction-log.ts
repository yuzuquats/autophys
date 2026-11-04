/**
 * The **in-memory transaction log** (WAL) core — slice **TX0** of the SDK-2.0
 * engine spec
 * (`lona/lona-console/projects/sdk-2.0-performance.project.docs/content/engine-spec.md`
 * §4, REQ-TXN / REQ-READ-2). A generic, append-only journal of `Op`s grouped
 * into transactions. It is the write-side spine the render/data pipeline is
 * being re-specced onto: every store mutation becomes one recorded `Op`; the
 * transactions it seals are the audit + replay substrate.
 *
 * ## Two transaction kinds (engine-spec §4)
 *
 * - **Implicit "frame" txn** — opened *lazily* on the first unscoped `record`
 *   and closed by an injected `Scheduler` (production passes the fastdom rAF
 *   mutate phase, mirroring `InvalidationTransaction.Factory`; the default is
 *   `queueMicrotask`; tests inject a manual flush). This is the per-rAF
 *   implicit transaction boundary the spec's operator law #3 mandates.
 * - **Explicit "scope" txn** — a labeled `scope(label, fn)` around a bulk write
 *   site. Nesting is **transparent** (the outermost label wins — the
 *   `withDeferredListeners` re-entrancy semantics, `sheet.ts` `withDeferredListeners`)
 *   so a caller already inside a scope does not fork a second txn. A scope
 *   commits in `finally`; **a throwing scope seals `outcome: "aborted"` with a
 *   bounded error tag (error *name* only, never a message body) and rethrows**
 *   (the REQ-TXN rollback-visibility / audit half).
 *
 * Opening a scope first seals any open frame txn, so commit order is
 * `frame → scope → frame …` — strictly the order transactions seal.
 *
 * ## Determinism (operator law #5)
 *
 * **No `Date.now` / `Math.random` anywhere.** Sequence (`seq`, per op) and
 * transaction id (`txId`, per seal) are logical monotonic counters. The same
 * script replayed twice produces deep-equal `transactions()` — the property the
 * TX0 battery asserts.
 *
 * ## Read mark τ (SQLite graft — engine-spec §4)
 *
 * `tau()` is the `txId` of the last **sealed** transaction (0 before any seal):
 * the point a mid-frame reader pins so "what does a reader see" is answered
 * O(1), no state copies. Dark in TX0 (nothing reads it to make a decision).
 *
 * ## Retention
 *
 * `retain` caps the committed list; the oldest sealed txns are dropped and
 * counted (`counters().dropped`). `retainOps` caps the ops the retained
 * txns hold together. The default `keep-newest` policy keeps an oversized newest
 * txn; opt-in `strict` evicts whole transactions including that newest txn.
 * One txn can hold thousands of ops (a hydrate), so a
 * txn count alone does not bound the memory a long-lived log keeps. The all-time counters (`committed` /
 * `aborted` / `ops`) are *not* rewound by retention — they remain a truthful
 * aggregate of everything the log ever sealed.
 *
 * In-memory only: nothing here is persisted (prior-round scope pin — the WAL is
 * an audit + test substrate, not durability). `intent` is the schema slot for
 * TX2's semantic ops: `null` for frames + store-write scopes, non-null only
 * when a gesture opened `scopeIntent` (TX2 frame-commit). An intent-stamped
 * scope is the durable-horizon anchor later control ops reference, so it always
 * seals even with zero ops — mirroring the aborted-always-seals audit rule.
 */

import { ArtifactFreeze } from "./artifact-freeze";

export class TransactionLog<Op> {
  private readonly scheduler: TransactionLog.Scheduler;
  private readonly retain: Option<number>;
  private readonly retainOps: Option<number>;
  private readonly retainOpsPolicy: "keep-newest" | "strict";
  private readonly onSeal: Option<(txn: TransactionLog.Transaction<Op>) => void>;

  /** Committed (+ aborted) transactions, in seal order, capped by `retain` / `retainOps`. */
  private readonly committed: TransactionLog.Transaction<Op>[] = [];
  /** Ops held by `committed`, summed. */
  private retainedOps = 0;

  /**
   * The single currently-open transaction (frame or explicit), or `null`. At
   * most one is open at a time: an explicit scope seals the frame before
   * opening, and nested scopes are transparent.
   */
  private current: Option<TransactionLog.Open<Op>> = null;

  /** Nesting depth of explicit scopes; >0 ⇒ a scope owns `current`. */
  private explicitDepth = 0;

  /** Dedup guard so one open frame schedules exactly one flush. */
  private flushScheduled = false;

  // ── Logical counters (no wall-clock, no randomness) ─────────────────────────
  private seq = 0; // op sequence — increments per recorded op
  private txId = 0; // transaction id — increments per SEALED txn (= tau)
  private committedCount = 0; // all-time committed-outcome seals
  private abortedCount = 0; // all-time aborted-outcome seals
  private droppedCount = 0; // all-time evictions by retention

  constructor(opts: TransactionLog.Options<Op>) {
    this.scheduler = opts.scheduler;
    this.retain = opts.retain ?? null;
    this.retainOps = opts.retainOps ?? null;
    this.retainOpsPolicy = opts.retainOpsPolicy ?? "keep-newest";
    this.onSeal = opts.onSeal ?? null;
  }

  /**
   * Append `op` to the innermost open transaction. When none is open, lazily
   * opens the implicit frame txn and schedules its close via the injected
   * scheduler. O(1).
   *
   * The op is pushed **before** the flush is scheduled so that a *synchronous*
   * scheduler (which fires `flush` inline) seals a frame that already carries
   * this op instead of an empty one — the frame then simply does not batch.
   * The production `queueMicrotask` / rAF schedulers fire after the synchronous
   * run, so they still coalesce every op of the frame.
   */
  record(op: Op): void {
    // Dev-hardening (ART battery): freeze the op itself here, once, so a
    // caller cannot mutate it after it has entered the log. `seal` freezes
    // the txn envelope (including the `{ seq, op }` entry wrapper) — this is
    // the one-freeze-per-object split.
    ArtifactFreeze.deep(op);
    let txn = this.current;
    const isNewFrame = txn == null;
    if (txn == null) {
      txn = { origin: "frame", explicit: false, intent: null, ops: [] };
      this.current = txn;
    }
    this.seq += 1;
    txn.ops.push({ seq: this.seq, op });
    if (isNewFrame && !this.flushScheduled) {
      this.flushScheduled = true;
      this.scheduler(() => this.flush());
    }
  }

  /**
   * Run `fn` inside an explicit labeled transaction. Transparent when a scope
   * is already open (outermost label wins — the re-entrancy contract). Commits
   * in `finally`; a throw seals `outcome: "aborted"` with a bounded error tag
   * and rethrows. Returns `fn`'s result. The sealed txn carries no intent.
   */
  scope<T>(label: string, fn: () => T): T {
    return this.runScope(label, null, fn);
  }

  /**
   * Like {@link scope}, but stamps the sealed txn with a semantic `intent` — the
   * TX2 gesture frame-commit. The intent survives to `seal` (visible on the
   * sealed `Transaction`) and makes the scope the durable-horizon anchor `F`
   * that later control ops reference, so an intent scope always seals even with
   * zero ops. Transparent nesting still applies: the OUTERMOST open scope owns
   * the txn, so its label AND its intent win; a nested `scopeIntent` inside an
   * outer scope contributes neither. An aborted intent scope still seals
   * `outcome:"aborted"` carrying both the error tag and this intent.
   */
  scopeIntent<T>(label: string, intent: string, fn: () => T): T {
    return this.runScope(label, intent, fn);
  }

  private runScope<T>(label: string, intent: Option<string>, fn: () => T): T {
    // Transparent nesting — already inside an explicit scope, so records land
    // in the outer txn and the outer scope owns the commit (its label + intent).
    if (this.explicitDepth > 0) return fn();

    // Seal any open implicit frame first so seal order stays frame→scope.
    if (this.current != null && !this.current.explicit) this.seal(this.current, "committed", null);

    const txn: TransactionLog.Open<Op> = { origin: label, explicit: true, intent, ops: [] };
    this.current = txn;
    this.explicitDepth = 1;
    try {
      const result = fn();
      this.seal(txn, "committed", null);
      return result;
    } catch (err) {
      this.seal(txn, "aborted", TransactionLog.errorTag(err));
      throw err;
    } finally {
      this.explicitDepth = 0;
      // `seal` clears `current` when it sealed `txn`; guard the rethrow path
      // where a non-recording aborted scope may still be current.
      if (this.current === txn) this.current = null;
    }
  }

  /** Committed (+ aborted) transactions in seal order (retained window). */
  transactions(): readonly TransactionLog.Transaction<Op>[] {
    return this.committed;
  }

  /** The read mark τ — the `txId` of the last sealed txn; 0 before any seal. */
  tau(): number {
    return this.txId;
  }

  /** Pull-based aggregate counters (all-time; retention does not rewind them). */
  counters(): TransactionLog.Counters {
    return {
      committed: this.committedCount,
      aborted: this.abortedCount,
      ops: this.seq,
      dropped: this.droppedCount,
      tau: this.txId,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Close the open frame txn. Idempotent + re-entrancy-safe: only seals when the
   * current txn is an (unsealed) frame — a scheduled flush that fires after an
   * explicit scope already drained the frame is a clean no-op.
   */
  private flush(): void {
    this.flushScheduled = false;
    const cur = this.current;
    if (cur != null && !cur.explicit) this.seal(cur, "committed", null);
  }

  /** Evict the oldest retained txn (retention). */
  private dropOldest(): void {
    const dropped = this.committed.shift();
    if (dropped == null) return;
    this.retainedOps -= dropped.ops.length;
    this.droppedCount += 1;
  }

  /**
   * Seal `txn` at a fresh `txId`. Empty *committed* txns are dropped (no txId,
   * no noise) so "empty flush = no txn" and empty scopes stay silent — EXCEPT an
   * intent-stamped scope, which always seals (its intent is the durable-horizon
   * anchor `F` later control ops reference, so it needs an identity even with no
   * ops). An `aborted` txn is always recorded (the audit signal), even with no
   * ops.
   */
  private seal(
    txn: TransactionLog.Open<Op>,
    outcome: TransactionLog.Outcome,
    error: Option<string>,
  ): void {
    if (this.current === txn) this.current = null;
    if (txn.ops.length === 0 && outcome === "committed" && txn.intent == null) return;

    this.txId += 1;
    if (outcome === "aborted") this.abortedCount += 1;
    else this.committedCount += 1;

    const sealed: TransactionLog.Transaction<Op> = {
      txId: this.txId,
      origin: txn.origin,
      outcome,
      // `intent` is the TX2 semantic slot — null unless a gesture opened
      // `scopeIntent` (TX2); the outermost open scope's intent wins.
      intent: txn.intent,
      error,
      ops: txn.ops,
    };
    // Dev-hardening (ART battery): deep-freeze the sealed envelope — its
    // `ops` array and each `{ seq, op }` entry — before it becomes visible
    // via `transactions()`/`onSeal`. `op` itself was already frozen once in
    // `record`; re-visiting an already-frozen object here is a cheap no-op.
    ArtifactFreeze.deep(sealed);
    this.committed.push(sealed);
    this.retainedOps += sealed.ops.length;

    if (this.retain != null) {
      while (this.committed.length > this.retain) this.dropOldest();
    }
    if (this.retainOps != null) {
      const minimumRetained = this.retainOpsPolicy === "strict" ? 0 : 1;
      while (this.committed.length > minimumRetained && this.retainedOps > this.retainOps) this.dropOldest();
    }

    this.onSeal?.(sealed);
  }
}

export namespace TransactionLog {
  /**
   * Schedules the implicit frame txn's close. Production passes the fastdom
   * mutate phase (`(flush) => $$.mutate(flush)`); the default is
   * `queueMicrotask`; headless tests inject a manual flush. The
   * `InvalidationTransaction.Factory` precedent
   * (`sheets-ui/src/invalidation-transaction.ts`).
   */
  export type Scheduler = (flush: () => void) => void;

  export interface Options<Op> {
    readonly scheduler: Scheduler;
    /** Cap on the committed list; oldest sealed txns are dropped + counted. */
    readonly retain?: Option<number>;
    /**
     * Cap on the ops the retained txns hold together; the oldest sealed txns
     * are dropped + counted until they fit, subject to `retainOpsPolicy`.
     */
    readonly retainOps?: Option<number>;
    /** Default `keep-newest` permits an oversized newest txn; `strict` evicts it whole. */
    readonly retainOpsPolicy?: Option<"keep-newest" | "strict">;
    /** Observe each seal (for downstream counters / batched breadcrumbs). */
    readonly onSeal?: Option<(txn: Transaction<Op>) => void>;
  }

  export type Outcome = "committed" | "aborted";

  /** One recorded op with its logical sequence number. */
  export interface Entry<Op> {
    readonly seq: number;
    readonly op: Op;
  }

  /** A sealed transaction — the committed audit/replay unit. */
  export interface Transaction<Op> {
    readonly txId: number;
    /** `"frame"` for the implicit per-rAF txn, else the explicit scope label. */
    readonly origin: string;
    readonly outcome: Outcome;
    /** TX2 semantic slot — null unless a gesture opened `scopeIntent` (TX2). */
    readonly intent: Option<string>;
    /** Bounded error tag (error name only) when `outcome === "aborted"`. */
    readonly error: Option<string>;
    readonly ops: readonly Entry<Op>[];
  }

  export interface Counters {
    readonly committed: number;
    readonly aborted: number;
    readonly ops: number;
    readonly dropped: number;
    readonly tau: number;
  }

  /** An open (unsealed) transaction accumulating ops. */
  export interface Open<Op> {
    readonly origin: string;
    readonly explicit: boolean;
    /** TX2 semantic intent — null for frames + null-intent scopes. */
    readonly intent: Option<string>;
    readonly ops: Entry<Op>[];
  }

  /**
   * A bounded, deterministic error tag: the error's *name* only, never its
   * message (which may carry unbounded / sensitive detail). Non-Error throws
   * degrade to a fixed `"non-error"` tag.
   */
  export function errorTag(err: unknown): string {
    return err instanceof Error ? err.name : "non-error";
  }
}
