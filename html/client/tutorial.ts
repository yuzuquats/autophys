/** Pure tour navigation and reversible session ownership; the host supplies enter/restore. */
export type TourPosition = { step: number; substep: number };
export class TourPager {
  position: TourPosition = { step: 0, substep: 0 };
  constructor(readonly parts: readonly number[]) {
    if (!parts.length || parts.some(n => n < 1 || !Number.isInteger(n))) throw new Error("Each tour step needs a part");
  }
  get last(): boolean { return this.position.step === this.parts.length - 1 && this.position.substep === this.parts.at(-1)! - 1; }
  get first(): boolean { return this.position.step === 0 && this.position.substep === 0; }
  get progress(): number { return (this.position.substep + 1) / this.parts[this.position.step]; }
  move(delta: 1 | -1): boolean {
    const { step, substep } = this.position;
    if (delta > 0) {
      if (this.last) return false;
      this.position = substep + 1 < this.parts[step] ? { step, substep: substep + 1 } : { step: step + 1, substep: 0 };
    } else {
      if (this.first) return false;
      this.position = substep ? { step, substep: substep - 1 } : { step: step - 1, substep: this.parts[step - 1] - 1 };
    }
    return true;
  }
}
export class TourSession<T> {
  readonly pager: TourPager;
  private saved: { value: T } | null = null;
  constructor(parts: readonly number[], private capture: () => T, private restore: (value: T) => void, private enter: (position: TourPosition) => void) {
    this.pager = new TourPager(parts);
  }
  get active(): boolean { return this.saved !== null; }
  start(): void {
    if (this.active) return;
    this.saved = { value: this.capture() };
    this.pager.position = { step: 0, substep: 0 };
    this.enter(this.pager.position);
  }
  move(delta: 1 | -1): boolean {
    if (!this.active || !this.pager.move(delta)) return false;
    this.enter(this.pager.position); // Back runs the same enter actions as Next.
    return true;
  }
  finish(): void {
    if (!this.saved) return;
    const saved = this.saved;
    this.saved = null;
    this.restore(saved.value);
  }
}
/** Demo decisions are read-only even when an intent bypasses a disabled button. */
export const demoWrite = (source: string, action: string): boolean =>
  source === "fixture" && /^(approve|reject|withdraw|restore|start-investigation|pair-(approve|deny):.*)$/.test(action);

import type { View } from "./derive/index.ts";
import type { Action } from "../ui/view-model.ts";
/** Demo data is read-only in every entry path, including outside a tour. */
export function demoView(view: View, source: string): View {
  if (source !== "fixture") return view;
  const disable = (a: Action): Action => demoWrite(source, a.name)
    ? { ...a, disabled:true, title:"Disabled on demo data" } : a;
  const pair = (actions: [Action, Action]): [Action, Action] => [disable(actions[0]), disable(actions[1])];
  return { ...view,
    main: { ...view.main, actions:view.main.actions.map(disable) },
    details: { ...view.details, decision:view.details.decision && pair(view.details.decision),
      actions:view.details.actions?.map(disable),
      sections:view.details.sections.map(s => ({ ...s, blocks:s.blocks.map(b => b.kind === "pairing" ? { ...b, decision:pair(b.decision) } : b) })) },
  };
}
