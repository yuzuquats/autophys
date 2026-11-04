import { GridLayout } from "./grid-layout";

export async function verifyGridRetirement(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const g = GridLayout.make(); g.style.width = "800px"; g.style.display = "block";
  for (let i = 0; i < 20; i++) { const child = document.createElement("div"); child.style.height = "20px"; g.append(child); }
  g.bind(GridLayout.DEFAULT_CONFIG); document.body.append(g); g.remove(); await frame();
  if ([...g.children].some(c => c.hasAttribute("dbg-height"))) throw new Error("Grid queued detached layout changed geometry");
  document.body.append(g); await frame(); await frame();
  if (g.height <= 0 || ![...g.children].every(c => c.hasAttribute("dbg-height"))) throw new Error("Grid reconnect did not lay out children");
  g.style.width = "420px"; await frame(); await frame();
  if (g.height < 400) throw new Error("Grid reconnect/resize did not recompute columns");
  GridLayout.recycle(g); await frame();
  return ["Grid retires queued detached geometry and reconnects with current size"];
}
