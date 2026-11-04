import { Tracing } from "@tento-core/tracing";
import { FRAME_BUDGET, type UnitCost } from "./frame-budget.js";

/**
 * The page's one idle lane: work that must not
 * run in a frame (a parked calendar strip finishing its bind, a static text
 * cell mounting its editor) runs here, in idle periods, under one rule.
 *
 * - Still: no scroll event and no visible-range move for
 *   {@link IdleLane.QUIET_MS}, and no frame work queued (the
 *   frame budget's background debt, or the engine's queued binds). Not still:
 *   look again once the quiet interval can have passed.
 * - One slice: an idle period spends at most {@link IdleLane.SLICE_MS} on
 *   units, plus at most one unit's overrun. A unit runs only when the idle
 *   period has room for its worker's usual cost; after the first, only when
 *   the slice still fits that worker's usual AND recent peak cost.
 *   A gesture that starts right after the period finds the main thread free.
 * - Workers in registration order: each period runs the first worker with a
 *   runnable unit, then asks again from the top.
 * - No polling while nothing is runnable: the lane sleeps until a worker says
 *   it has new work (`wake`) or a visible range moves (a reattached column
 *   can make waiting work runnable).
 * - A page without `requestIdleCallback` gets a timer period of
 *   {@link IdleLane.FALLBACK_PERIOD_MS} every {@link IdleLane.FALLBACK_DELAY_MS}.
 */
export class IdleLane {
  /** How long input and the visible range must be still before idle work runs (ms). */
  static readonly QUIET_MS = 100;
  /** The most one idle period spends on units, before one unit's overrun (ms). */
  static readonly SLICE_MS = 4;
  /** The least idle time a unit starts in (ms), before its worker's cost is known. */
  static readonly MIN_MS = 1;
  /** Without `requestIdleCallback`: how long a timer period may run (one frame's worth) and how long it waits first (ms). */
  static readonly FALLBACK_PERIOD_MS = 16;
  static readonly FALLBACK_DELAY_MS = 50;
  readonly #workers: IdleLane.Worker[] = [];
  #armed = false;
  /** An idle period is running: a wake from inside it (a unit queued more work) is answered by the same loop. */
  #running = false;

  constructor(readonly scheduler: IdleLane.Scheduler) {}

  /** The page's lane: requestIdleCallback (a timer period without it), timers and the frame budget. */
  static forDocument(): IdleLane {
    const lane = new IdleLane({
      idle: (task) => {
        if (typeof globalThis.requestIdleCallback === "function") {
          globalThis.requestIdleCallback((deadline) => task(() => deadline.timeRemaining()));
        } else {
          setTimeout(() => {
            const end = performance.now() + IdleLane.FALLBACK_PERIOD_MS;
            task(() => end - performance.now());
          }, IdleLane.FALLBACK_DELAY_MS);
        }
      },
      later: (task, ms) => void setTimeout(task, ms),
      now: () => performance.now(),
      sinceInputMs: () => FRAME_BUDGET.sinceInputMs(),
      sinceMoveMs: () => FRAME_BUDGET.sinceViewportMoveMs(),
      frameWork: () => FRAME_BUDGET.hasFrameWork(),
    });
    FRAME_BUDGET.whenViewportMoves(() => lane.wake());
    return lane;
  }

  /**
   * Add `worker` after the workers already registered. The owner must call
   * the returned unregister function when it retires.
   */
  register(worker: IdleLane.Worker): () => void {
    if (!this.#workers.includes(worker)) this.#workers.push(worker);
    return () => {
      const index = this.#workers.indexOf(worker);
      if (index >= 0) this.#workers.splice(index, 1);
    };
  }

  /** Whether the page is still enough for idle work (see the class comment). */
  still(): boolean {
    const s = this.scheduler;
    return s.sinceInputMs() >= IdleLane.QUIET_MS && s.sinceMoveMs() >= IdleLane.QUIET_MS && !s.frameWork();
  }

  /** A worker may have runnable work: look in the next idle period. */
  wake(): void {
    if (!this.#running) this.#arm(0);
  }

  #arm(delayMs: number): void {
    if (this.#armed) return;
    this.#armed = true;
    const idle = () => this.scheduler.idle((timeRemaining) => this.#run(timeRemaining));
    if (delayMs > 0) this.scheduler.later(idle, delayMs);
    else idle();
  }

  /** How long until the quiet interval can have passed (at least one frame). */
  #recheckMs(): number {
    const s = this.scheduler;
    const quietIn = IdleLane.QUIET_MS - Math.min(s.sinceInputMs(), s.sinceMoveMs());
    return Math.max(16, Math.ceil(quietIn));
  }

  /** One idle period. */
  #run(timeRemaining: () => number): void {
    this.#armed = false;
    if (!this.still()) {
      if (this.#workers.some((worker) => worker.pending())) this.#arm(this.#recheckMs());
      return;
    }
    let roomLeft = true;
    this.#running = true;
    try {
      roomLeft = this.#runUnits(timeRemaining);
    } finally {
      this.#running = false;
    }
    for (const worker of this.#workers) worker.periodEnded?.(!roomLeft);
    if (!roomLeft) this.#arm(0);
  }

  /** Run units in registration order while the period and the slice have room; returns false when work was left for lack of room. */
  #runUnits(timeRemaining: () => number): boolean {
    const start = this.scheduler.now();
    let ran = 0;
    pick: while (true) {
      for (const worker of this.#workers) {
        if (!worker.pending()) continue;
        const usual = Math.max(IdleLane.MIN_MS, worker.cost.expectedMs);
        const elapsed = this.scheduler.now() - start;
        // Every unit needs the idle period to have room for its usual cost (a unit never runs into the next frame
        // on purpose); after the first, the slice must also fit its usual and recent peak cost.
        const fits = timeRemaining() >= usual &&
          (ran === 0 || elapsed + Math.max(usual, worker.cost.peakMs) <= IdleLane.SLICE_MS);
        if (!fits) return false;
        const unit = worker.take();
        if (unit == null) continue;
        const unitStart = this.scheduler.now();
        try {
          unit();
        } catch (error) {
          Tracing.err("ui")("idle unit failed", { error: String(error) });
        } finally {
          worker.cost.note(this.scheduler.now() - unitStart);
          ran++;
        }
        continue pick;
      }
      return true;
    }
  }
}

/** Types that go with `IdleLane`. */
export namespace IdleLane {
  /** One kind of idle work (a queue); the lane asks it for units one at a time. */
  export type Worker = {
    /** What its units usually cost (the lane notes each run). */
    readonly cost: UnitCost;
    /** Whether it may have a unit to run now (cheap; `take` may still find none). */
    pending(): boolean;
    /** Remove and return the next unit to run now, or null when none is runnable now. */
    take(): (() => void) | null;
    /** The idle period ended; `moreLater`: it ran out of room with work left. */
    periodEnded?(moreLater: boolean): void;
  };

  /** How the lane reaches the page (requestIdleCallback, timers and the frame budget in production, fakes in tests). */
  export type Scheduler = {
    /** Run `task` in the next idle period, with how many ms of it are left. */
    readonly idle: (task: (timeRemaining: () => number) => void) => void;
    /** Run `task` after `ms`. */
    readonly later: (task: () => void, ms: number) => void;
    readonly now: () => number;
    /** How long ago the last scroll event ran (ms). */
    readonly sinceInputMs: () => number;
    /** How long ago a visible range last moved (ms). */
    readonly sinceMoveMs: () => number;
    /** Whether frame work is queued (it runs first). */
    readonly frameWork: () => boolean;
  };
}

/** The document's idle lane (one per document, like the frame budget). */
export const IDLE_LANE = IdleLane.forDocument();
