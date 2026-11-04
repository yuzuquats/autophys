/**
 * One frame's script budget, shared by the scroll engine's bind drain and the
 * background work that must not escape it (calendar strip construction).
 *
 * Fastdom opens a new frame at the start of every flush (one flush per
 * animation frame). Whoever does budgeted work in that frame charges what it
 * spent; deferred work runs only against what is left (`remainingMs`), with
 * at least one unit per frame for forward progress. The budget is never
 * raised: it is the scroll engine's own per-frame drain budget.
 *
 * It also carries cross-cutting facts that are not calendar specific:
 * - background debt: owners with queued work. The engine counts it as pending
 *   binds, so its settle (`hasPendingBinds`, `onBatchComplete`, `whenSettled`)
 *   does not report "bound" while strips are still being built, and it
 *   re-checks when the debt drains (`whenBackgroundIdle`).
 * - motion: when the last scroll event ran and when a visible range last
 *   moved (`inMotion`), which the engine's content deadline reads.
 *
 * How each policy was measured and chosen is in the lona-dom project docs
 * (perf-policy-history.md).
 */
export class FrameBudget {
  /** The per-frame script budget, equal to `ScrollEngine.DRAIN_BUDGET_MS`. */
  static readonly FRAME_MS = 8;
  /** One display refresh at 60 Hz. */
  static readonly VSYNC_MS = 1000 / 60;
  /** The most the content deadline is trimmed after frames that ran content to it and still missed a vsync. */
  static readonly TRIM_MAX_MS = 3;

  #frame = -1;
  /** When this frame's flush opened (monotonic ms), for the content deadline. */
  #openedAt = 0;
  /** This frame's content deadline in ms after `#openedAt`; null = ledger only. */
  #contentMs: number | null = null;
  /**
   * Taken off the content deadline: content work causes style, layout and
   * paint after it, which the deadline does not see. A frame that ran content
   * to its deadline and still took two vsyncs trims 1 ms (up to
   * `TRIM_MAX_MS`); a frame inside one vsync gives 0.5 ms back, and so does
   * every vsync of a still gap after a frame whose content fit (no frame
   * opened, no scroll event): the trim is evidence about consecutive frames,
   * and a fling after a pause must not start on the last fling's trim.
   */
  #trimMs = 0;
  /** Whether content asked for time this frame after the deadline had none left. */
  #saturated = false;
  #spent = 0;
  /** Whether a budgeted queue already ran its unconditional unit this frame. */
  #firstUnitTaken = false;
  /** When input (a scroll event) opened the frame before its flush; null = the flush opens it. */
  #inputAt: number | null = null;
  /** When the last scroll event ran (monotonic ms); -Infinity before any. */
  #lastInputAt = Number.NEGATIVE_INFINITY;
  /** When a scroll engine's visible range last moved (monotonic ms); -Infinity before any. */
  #lastMoveAt = Number.NEGATIVE_INFINITY;
  readonly #moveListeners = new Set<() => void>();
  /** Owners with frame work queued outside the background debt (the engine's binds), and since when they said so. */
  readonly #frameWork = new Map<object, number>();
  readonly #debt = new Set<object>();
  #idleWaiters: (() => void)[] = [];
  /** Per-frame pace records while recording (`recordPace`), oldest first; null = not recording. */
  #pace: FramePace[] | null = null;
  /** Columns the engine reconciled into its rendered range since the last frame opened. */
  #reconciledSinceOpen = 0;

  /**
   * Start frame `frame` (a fastdom flush number); a repeat open of the same
   * frame is a no-op. The frame starts at the scroll event that opened it when
   * one ran within the last vsync, else now. A content deadline the previous
   * frame carried stays armed until the engine sets this frame's, so a frame
   * whose bind drain does not run still has one.
   */
  open(frame: number, now: number = performance.now()): void {
    if (frame === this.#frame) return;
    const inputAt = this.#inputAt;
    this.#inputAt = null;
    const previousOpenedAt = this.#frame === -1 ? null : this.#openedAt;
    this.#frame = frame;
    this.#openedAt = inputAt != null && now - inputAt <= FrameBudget.VSYNC_MS ? inputAt : now;
    if (previousOpenedAt != null && this.#contentMs != null) {
      // `inputAt` is the first scroll event since the previous frame opened: the
      // gap was still unless one ran before the vsync that opens this frame.
      const still = inputAt == null || now - inputAt <= FrameBudget.VSYNC_MS;
      this.#retrim(this.#openedAt - previousOpenedAt, this.#saturated, still);
    }
    this.#saturated = false;
    this.#spent = 0;
    this.#firstUnitTaken = false;
    const pace = this.#pace;
    if (pace != null) {
      if (pace.length >= FrameBudget.PACE_FRAMES) pace.shift();
      pace.push(FramePace.empty(frame, this.#openedAt, this.#contentMs, this.#trimMs, this.#reconciledSinceOpen));
    }
    this.#reconciledSinceOpen = 0;
  }

  /** How many frames of pace records are kept while recording. */
  static readonly PACE_FRAMES = 600;

  /**
   * Start or stop keeping per-frame pace records (the `scroll/bind-pace`
   * trace): what each budgeted queue wanted, ran and deferred,
   * and how many columns the engine reconciled. Off, nothing is recorded.
   */
  recordPace(on: boolean): void {
    this.#pace = on ? (this.#pace ?? []) : null;
  }

  /** The pace records of frames opened at or after `since` (monotonic ms), oldest first; empty when not recording. */
  paceSince(since: number): readonly FramePace[] {
    return this.#pace?.filter((record) => record.openedAt >= since) ?? [];
  }

  /** The current frame's pace record, when recording. */
  #currentPace(): FramePace | null {
    const record = this.#pace?.[this.#pace.length - 1];
    return record != null && record.frame === this.#frame ? record : null;
  }

  /**
   * One drain of `queue` this frame: it had `wanted` units queued, ran `ran`
   * and left `deferred` queued for a later frame. Counted only while recording.
   */
  notePace(queue: FramePace.Queue, wanted: number, ran: number, deferred: number): void {
    const record = this.#currentPace();
    if (record == null) return;
    const count = record[queue];
    count.drains++;
    count.wanted += wanted;
    count.ran += ran;
    count.deferred += deferred;
  }

  /**
   * How long after the last scroll event or visible-range move the page is
   * still in motion (ms); the scroll engine reads it too, to pick its motion
   * content deadline.
   */
  static readonly MOTION_QUIET_MS = 100;

  /** Whether a scroll event ran or a visible range moved within {@link MOTION_QUIET_MS}. */
  inMotion(now: number = performance.now()): boolean {
    return Math.min(this.sinceInputMs(now), this.sinceViewportMoveMs(now)) < FrameBudget.MOTION_QUIET_MS;
  }

  /** The engine reconciled `columns` new columns into its rendered range (counted into the frame that opens next). */
  noteReconciled(columns: number): void {
    if (this.#pace != null && columns > 0) this.#reconciledSinceOpen += columns;
  }

  /**
   * Adjust the trim from the frame that just ended: how long until this one
   * opened, whether content ran out of deadline, and whether the page was
   * `still` across the gap (no scroll event before the vsync that opens this
   * frame). A gap over 2.5 vsyncs after content that fit, with the page still,
   * is a pause: each of its vsyncs ran no content and made its vsync, so each
   * gives 0.5 ms back, as a one-vsync frame does. A gap of 1.25-2.5 vsyncs is
   * read as one slow frame (the band the saturated rule uses), so a still one
   * gives nothing back and the first gap past 2.5 gives a whole 1 ms at once
   * (`frame-deadline-trim.deno.test.ts` pins both sides); a continuous ramp
   * across that band would be a measured perf change, not part of this rule.
   */
  #retrim(intervalMs: number, saturated: boolean, still: boolean): void {
    const vsync = FrameBudget.VSYNC_MS;
    if (intervalMs <= vsync * 1.25) this.#trimMs = Math.max(0, this.#trimMs - 0.5);
    else if (saturated && intervalMs <= vsync * 2.5) this.#trimMs = Math.min(FrameBudget.TRIM_MAX_MS, this.#trimMs + 1);
    else if (!saturated && still && intervalMs > vsync * 2.5) {
      this.#trimMs = Math.max(0, this.#trimMs - 0.5 * Math.floor(intervalMs / vsync));
    }
  }

  /** What the content deadline is trimmed by now (ms). */
  trimMs(): number {
    return this.#trimMs;
  }

  /** A scroll event ran: the coming frame's budget counts from here, not from its flush. */
  noteInput(now: number = performance.now()): void {
    this.#inputAt ??= now;
    this.#lastInputAt = now;
  }

  /** How long ago the last scroll event ran (ms); Infinity when none has. */
  sinceInputMs(now: number = performance.now()): number {
    return now - this.#lastInputAt;
  }

  /** A scroll engine's visible range moved (by input or by a programmatic scroll); move listeners run. */
  noteViewportMoved(now: number = performance.now()): void {
    this.#lastMoveAt = now;
    for (const listener of this.#moveListeners) listener();
  }

  /** How long ago a visible range last moved (ms); Infinity when none has. */
  sinceViewportMoveMs(now: number = performance.now()): number {
    return now - this.#lastMoveAt;
  }

  /** Run `listener` on every visible-range move until the returned function removes it. */
  whenViewportMoves(listener: () => void): () => void {
    this.#moveListeners.add(listener);
    return () => void this.#moveListeners.delete(listener);
  }

  /** How long a frame-work mark counts without being renewed (ms): an owner that stops draining never blocks idle work for good. */
  static readonly FRAME_WORK_STALE_MS = 500;

  /** `owner` has (or no longer has) frame work queued that is not background debt, e.g. the engine's queued binds. */
  noteFrameWork(owner: object, pending: boolean, now: number = performance.now()): void {
    if (pending) this.#frameWork.set(owner, now);
    else this.#frameWork.delete(owner);
  }

  /** Whether any frame work is queued: background debt, or a frame-work mark renewed within {@link FRAME_WORK_STALE_MS}. */
  hasFrameWork(now: number = performance.now()): boolean {
    if (this.#debt.size > 0) return true;
    for (const at of this.#frameWork.values()) if (now - at < FrameBudget.FRAME_WORK_STALE_MS) return true;
    return false;
  }

  /**
   * Whether a budgeted queue may run its next unit. `ranThisDrain` is how many
   * the caller already ran in this drain. Ledger mode (no content deadline):
   * every drain's first unit runs, as before. Deadline mode: ONE first unit per
   * frame across all queues runs unconditionally (forward progress); every
   * other unit, including another queue's first, only while the deadline holds.
   * With a `cost`, "holds" means the deadline has room for the queue's usual
   * unit, not merely a sliver: a 5 ms unit admitted with 0.1 ms left spends the
   * next vsync.
   * What does not run continues next frame; nothing waits for settle.
   */
  mayRunUnit(ranThisDrain: number, now: number = performance.now(), cost?: UnitCost): boolean {
    const first = !this.#firstUnitTaken;
    this.#firstUnitTaken = true;
    if (ranThisDrain === 0 && (this.#contentMs == null || first)) return true;
    const remaining = this.remainingMs(now);
    if (cost == null || this.#contentMs == null) return this.#noteRefusal(remaining > 0, remaining);
    const admitted = remaining > 0 && remaining >= cost.expectedMs;
    if (!admitted) this.#saturated = true;
    return this.#noteRefusal(admitted, remaining);
  }

  /** Record in the pace trace how much deadline was left when a unit was refused (budget left on the table). */
  #noteRefusal(admitted: boolean, remaining: number): boolean {
    if (!admitted) {
      const record = this.#currentPace();
      if (record != null) {
        record.refusals++;
        record.refusedWithMs = Math.max(record.refusedWithMs, remaining);
      }
    }
    return admitted;
  }

  /** The bind drain ran this frame's unconditional unit (position never lags). */
  takeFirstUnit(): void {
    this.#firstUnitTaken = true;
  }

  /** The frame the ledger currently accounts. */
  get frame(): number {
    return this.#frame;
  }

  /** Charge `ms` of budgeted work to the current frame. */
  charge(ms: number): void {
    if (ms > 0) this.#spent += ms;
  }

  /** What this frame has left (never negative). */
  remainingMs(now: number = performance.now()): number {
    const ledger = FrameBudget.FRAME_MS - this.#spent;
    if (this.#contentMs == null) return Math.max(0, ledger);
    // Deadline mode: everything the frame already did (unbudgeted work
    // included) shrinks what content may still spend.
    const remaining = Math.min(ledger, this.#openedAt + this.#contentMs - this.#trimMs - now);
    if (remaining <= 0) this.#saturated = true;
    return Math.max(0, remaining);
  }

  /**
   * Bound this frame's content work by wall clock: content may run until
   * `contentMs` after the flush opened (`scroll-frame-deadline`; the engine
   * sets it per frame, smaller during motion). Expires with the frame.
   */
  setContentDeadline(contentMs: number): void {
    this.#contentMs = contentMs;
    const record = this.#currentPace();
    if (record != null) record.contentMs = contentMs;
  }

  /** What this frame has spent so far. */
  spentMs(): number {
    return this.#spent;
  }

  /** `owner` has queued background work. */
  addDebt(owner: object): void {
    this.#debt.add(owner);
  }

  /** `owner`'s queued background work is done or cancelled. */
  clearDebt(owner: object): void {
    if (!this.#debt.delete(owner) || this.#debt.size > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Whether any owner still has queued background work. */
  hasBackgroundDebt(): boolean {
    return this.#debt.size > 0;
  }

  /** Run `waiter` once when the background debt next drains (immediately-pending callers re-check). */
  whenBackgroundIdle(waiter: () => void): void {
    if (this.#debt.size === 0) {
      waiter();
      return;
    }
    if (!this.#idleWaiters.includes(waiter)) this.#idleWaiters.push(waiter);
  }
}

/**
 * One frame's budgeted work, as the `scroll/bind-pace` trace records it
 * (`FrameBudget.recordPace`): per queue, the units it had queued when it
 * drained (`wanted`), ran, and left for a later frame (`deferred`).
 */
export type FramePace = {
  readonly frame: number;
  /** When the frame opened (monotonic ms). */
  readonly openedAt: number;
  /** The content deadline set this frame (ms after it opened), or null (ledger only). */
  contentMs: number | null;
  /** The deadline trim in force when the frame opened. */
  readonly trimMs: number;
  /** Columns the engine reconciled into its rendered range for this frame (each needs a bind). */
  readonly reconciled: number;
  /** The engine's full column binds. */
  readonly binds: FramePace.Count;
  /** Calendar strip units (one step of one day of a strip). */
  readonly strips: FramePace.Count;
  /** Per-row fixed-children and viewport-columns units. */
  readonly fixed: FramePace.Count;
  /** Units refused for the budget this frame, and the most deadline left at a refusal (ms; > 0 = a unit did not fit what was left). */
  refusals: number;
  refusedWithMs: number;
};

/** Types and helpers that go with `FramePace`. */
export namespace FramePace {
  /** The budgeted queues a frame's pace record counts. */
  export type Queue = "binds" | "strips" | "fixed";
  /** One queue's work in a frame: how many drains ran, and the units they had, ran and left. */
  export type Count = { drains: number; wanted: number; ran: number; deferred: number };

  /** A frame's record before any queue drained. */
  export function empty(
    frame: number,
    openedAt: number,
    contentMs: number | null,
    trimMs: number,
    reconciled: number,
  ): FramePace {
    const count = (): Count => ({ drains: 0, wanted: 0, ran: 0, deferred: 0 });
    return {
      frame, openedAt, contentMs, trimMs, reconciled,
      binds: count(), strips: count(), fixed: count(), refusals: 0, refusedWithMs: 0,
    };
  }

  /**
   * `record` as one trace row: [opened at, content deadline (-1 = none), trim,
   * columns reconciled, binds wanted, ran, deferred, strip units wanted, ran,
   * deferred, fixed units wanted, ran, deferred, refusals, most deadline left
   * at a refusal (0.1 ms)].
   */
  export function row(record: FramePace): number[] {
    const f = record;
    return [
      f.openedAt, f.contentMs ?? -1, f.trimMs, f.reconciled,
      f.binds.wanted, f.binds.ran, f.binds.deferred,
      f.strips.wanted, f.strips.ran, f.strips.deferred,
      f.fixed.wanted, f.fixed.ran, f.fixed.deferred,
      f.refusals, Math.round(f.refusedWithMs * 10) / 10,
    ];
  }
}

/**
 * What one budgeted queue's units usually cost, so `FrameBudget.mayRunUnit` admits a unit only when it
 * fits the frame's content deadline. Each queue owns one.
 */
export class UnitCost {
  /** Smoothed wall-clock cost of one unit in ms; 0 until a unit has run. */
  expectedMs = 0;
  /** The recent peak cost of one unit in ms (the largest, decaying by a fifth per unit run since). */
  peakMs = 0;

  /** Record that one unit took `ms`. */
  note(ms: number): void {
    this.expectedMs = this.expectedMs === 0 ? ms : this.expectedMs * 0.7 + ms * 0.3;
    this.peakMs = Math.max(ms, this.peakMs * 0.8);
  }
}

/** The document's frame budget (fastdom is per document, so is this). */
export const FRAME_BUDGET = new FrameBudget();
