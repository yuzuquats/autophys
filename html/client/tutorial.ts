/** Keeps the user's state while a tour runs: start() takes it once, finish()
 * puts it back once. The cookbook tutorial pages the steps; the host swaps data. */
export class TourSnapshot<T> {
  private saved: { value: T } | null = null;
  constructor(private capture: () => T, private restore: (value: T) => void) {}
  get active(): boolean { return this.saved !== null; }
  start(): void {
    if (!this.saved) this.saved = { value: this.capture() };
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
