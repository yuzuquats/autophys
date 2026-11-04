import { AnimatedPanel } from "./animated-panel";

export async function verifyAnimatedPanelLifecycle(): Promise<string[]> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const results: string[] = [];
  let panel = AnimatedPanel.make();
  document.body.append(panel);
  const content = () => document.createElement("div");
  const inner = () => panel.shadowRoot!.querySelector<HTMLElement>("#panel")!;
  const checkContent = (expected: HTMLElement, message: string) => {
    if (!panel.getIsRevealed() || inner().firstElementChild !== expected) throw new Error(message);
  };
  try {
    for (const operation of ["immediate", "reveal", "update", "disconnect"] as const) {
      panel.reveal(content());
      let settlements = 0;
      const pending = panel.dismiss();
      pending.then(() => settlements++);
      const replacement = content();
      if (operation === "immediate") panel.dismissImmediate();
      if (operation === "reveal") panel.reveal(replacement);
      if (operation === "update") panel.updateContent(replacement);
      if (operation === "disconnect") panel.remove();
      await Promise.resolve();
      if (settlements !== 1) throw new Error(`AnimatedPanel ${operation} left dismissal pending`);
      if (operation === "reveal" || operation === "update") {
        checkContent(replacement, `AnimatedPanel ${operation} lost successor content`);
      } else if (panel.getIsRevealed() || inner().childElementCount !== 0) {
        throw new Error(`AnimatedPanel ${operation} did not clear dismissed content`);
      }
      if (!panel.isConnected) document.body.append(panel);
      await wait(400);
      if (settlements !== 1) throw new Error(`AnimatedPanel ${operation} settled more than once`);
      if (operation === "reveal" || operation === "update") {
        checkContent(replacement, `AnimatedPanel old timeout erased ${operation} successor`);
      }
      results.push(`AnimatedPanel ${operation} settles and retires old dismissal`);
    }

    panel.reveal(content());
    let settlements = 0;
    const first = panel.dismiss();
    const second = panel.dismiss();
    if (first !== second) throw new Error("AnimatedPanel duplicate dismiss did not join pending operation");
    first.then(() => settlements++);
    second.then(() => settlements++);
    inner().firstElementChild!.dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }));
    inner().dispatchEvent(new TransitionEvent("transitionend", { propertyName: "color" }));
    await Promise.resolve();
    if (settlements !== 0 || !panel.getIsRevealed()) throw new Error("AnimatedPanel unrelated transition completed dismissal");
    inner().dispatchEvent(new TransitionEvent("transitionend", { propertyName: "transform" }));
    await Promise.resolve();
    if (Number(settlements) !== 2 || panel.getIsRevealed() || inner().childElementCount !== 0) {
      throw new Error("AnimatedPanel own transition did not settle duplicate callers and clear content");
    }
    results.push("AnimatedPanel duplicate dismiss joins operation and ignores unrelated transition events");

    // A detached panel has no CSS transition; the fallback must finish it.
    panel.remove();
    panel.reveal(content());
    let fallbackSettled = false;
    panel.dismiss().then(() => { fallbackSettled = true; });
    await wait(400);
    if (!fallbackSettled || panel.getIsRevealed() || inner().childElementCount !== 0) {
      throw new Error("AnimatedPanel missing transition did not finish through fallback");
    }
    results.push("AnimatedPanel dismissal fallback finishes without transition events");

    // Detached recycle exercises onRecycle independently of disconnectedCallback.
    panel.reveal(content());
    let recycledSettlements = 0;
    panel.dismiss().then(() => recycledSettlements++);
    const previous = panel;
    AnimatedPanel.recycle(panel);
    await frame();
    panel = AnimatedPanel.make();
    if (panel !== previous || recycledSettlements !== 1 || panel.getIsRevealed()) {
      throw new Error("AnimatedPanel actual pool reuse did not retire dismissal and reveal state");
    }
    const replacement = content();
    document.body.append(panel);
    panel.updateContent(replacement);
    await wait(400);
    checkContent(replacement, "AnimatedPanel recycled dismissal erased successor content");
    if (recycledSettlements !== 1) throw new Error("AnimatedPanel recycled dismissal settled more than once");
    results.push("AnimatedPanel actual pooled reuse cancels predecessor timer and preserves successor content");
  } finally {
    AnimatedPanel.recycle(panel);
    await frame();
  }
  return results;
}
