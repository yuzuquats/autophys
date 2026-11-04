/** Placeholder workspace items. The product decides what lives here later. */
export type Item = { readonly id: string; readonly title: string };

export const items: readonly Item[] = [
  { id: "untitled-1", title: "Untitled 1" },
  { id: "untitled-2", title: "Untitled 2" },
  { id: "untitled-3", title: "Untitled 3" },
];

export function findItem(id: string | null): Item {
  return items.find((item) => item.id === id) ?? items[0];
}

/** Which panels show. Desktop keeps two independent flags; at phone width
 * one pane fills the screen at a time. */
export type Pane = "main" | "sidebar" | "details";
export type PanelState = { readonly sidebar: boolean; readonly details: boolean; readonly mobile: Pane };

export const initialPanels: PanelState = { sidebar: true, details: true, mobile: "main" };

export function togglePanel(state: PanelState, which: "sidebar" | "details", narrow: boolean): PanelState {
  if (narrow) return { ...state, mobile: state.mobile === which ? "main" : which };
  return { ...state, [which]: !state[which] };
}

export function closePanel(state: PanelState, which: "sidebar" | "details", narrow: boolean): PanelState {
  if (narrow) return { ...state, mobile: "main" };
  return { ...state, [which]: false };
}

export function visiblePanels(state: PanelState, narrow: boolean): { sidebar: boolean; details: boolean } {
  return narrow
    ? { sidebar: state.mobile === "sidebar", details: state.mobile === "details" }
    : { sidebar: state.sidebar, details: state.details };
}

/**
 * The drawer has three stops, top to bottom:
 *
 *   landing   the deck fills the screen
 *   tour      the app is open; the deck surface is lowered to a peek that
 *             carries the tutorial
 *   app       the peek is out of the way; the app has the whole screen
 *
 * Down moves one stop lower, Up one stop higher.
 */
export type Stage = "landing" | "tour" | "app";

export function arrowStage(stage: Stage, key: "ArrowDown" | "ArrowUp"): Stage | null {
  const order: Stage[] = ["landing", "tour", "app"];
  const next = order.indexOf(stage) + (key === "ArrowDown" ? 1 : -1);
  return next < 0 || next >= order.length ? null : order[next];
}

/** A tutorial position over a list of steps. */
export class Stepper<T> {
  private position = 0;
  constructor(private steps: readonly T[]) {
    if (!steps.length) throw new Error("a tutorial needs at least one step");
  }
  get index(): number {
    return this.position;
  }
  get count(): number {
    return this.steps.length;
  }
  get step(): T {
    return this.steps[this.position];
  }
  get last(): boolean {
    return this.position === this.steps.length - 1;
  }
  /** Move to the next step; false when already on the last one. */
  advance(): boolean {
    if (this.last) return false;
    this.position++;
    return true;
  }
  restart(): void {
    this.position = 0;
  }
}
