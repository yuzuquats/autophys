import { Tracing } from "@tento-core/tracing";
import { DomFlags } from "../../dom-flags.js";
import { UnitCost } from "../../frame-budget.js";
import { IDLE_LANE, type IdleLane } from "../../idle-lane.js";

/**
 * Lazy editor mount (`calendar-lazy-editor-mount`): a text cell
 * binds its text as static markup (the markup its editor would show, painted
 * in the bind's frame like before) and builds the live editor only when
 * someone reaches for it (focus, pointer-down, hover) or in the page's idle
 * lane (`IdleLane`): once the page is still, one mount per unit,
 * within the lane's slice. A fling that reveals fresh columns then mounts no
 * editor in its frames; the mounts land after the settle, a few per idle
 * period. Cells in parked columns wait without polling: the lane looks again
 * when a visible range moves (a reattach) or a cell is added. On by default
 * since the operator's flip of 2026-10-12; the lona row turns
 * it off.
 */
export class LazyEditorMount implements IdleLane.Worker {
  /** The `DomFlags` flag (on by default; read once per page). */
  static readonly FLAG = "calendar-lazy-editor-mount";

  static enabled(): boolean {
    return DomFlags.read(LazyEditorMount.FLAG, true);
  }

  readonly #waiting = new Set<LazyEditorMount.Target>();
  readonly cost = new UnitCost();
  /** Mounts this idle period, for the `sheet/lazy-editor-mount` trace. */
  #mounted = 0;

  constructor(readonly lane: Pick<IdleLane, "register" | "wake" | "still">) {
    lane.register(this);
  }

  /** How many cells wait for their editor. */
  get size(): number {
    return this.#waiting.size;
  }

  /** Whether the page is still (the idle lane's rule): hover mounts only then. */
  still(): boolean {
    return this.lane.still();
  }

  /** `target` painted static: mount its editor once the page is still. */
  add(target: LazyEditorMount.Target): void {
    this.#waiting.add(target);
    this.lane.wake();
  }

  /** `target` mounted on its own (reached for) or was recycled: forget it. */
  delete(target: LazyEditorMount.Target): void {
    this.#waiting.delete(target);
  }

  pending(): boolean {
    return this.#waiting.size > 0;
  }

  /** The next shown waiting cell's mount; gone cells are forgotten, hidden (parked) ones wait. */
  take(): (() => void) | null {
    for (const target of this.#waiting) {
      const state = target.mountState();
      if (state === "gone") {
        this.#waiting.delete(target);
        continue;
      }
      if (state === "hidden") continue;
      this.#waiting.delete(target);
      return () => {
        this.#mounted++;
        target.mount();
      };
    }
    return null;
  }

  periodEnded(): void {
    if (this.#mounted === 0) return;
    // Trace hook `sheet/lazy-editor-mount`: mounts this idle period and what still waits.
    Tracing.log("sheet/lazy-editor-mount", { mounted: this.#mounted, waiting: this.#waiting.size });
    this.#mounted = 0;
  }
}

export namespace LazyEditorMount {
  /** A text cell painted static, waiting for its editor. */
  export type Target = {
    /** "ready": shown, mount it; "hidden": parked off-screen, wait; "gone": no longer static or connected, forget it. */
    mountState(): "ready" | "hidden" | "gone";
    /** Build the live editor now (no focus move). */
    mount(): void;
  };
}

/** The document's lazy editor mounts (one per document, like the frame budget), on the document's idle lane. */
export const LAZY_EDITOR_MOUNTS = new LazyEditorMount(IDLE_LANE);
