import { Anchor } from "./anchor";

/** Run in a focused Chromium document with the normal Fastdom/DOM initialization. */
export async function verifyAnchorRetirement(): Promise<string[]> {
  const results: string[] = [];
  const $anchor = document.createElement("button");
  document.body.append($anchor);
  try {
    for (const escapeContainer of [true, false]) {
      const $content = document.createElement("div");
      let dismissals = 0;
      const h = Anchor.reveal({ $anchor, $content, escapeContainer,
        onDismiss: () => dismissals++ });
      h.dismiss(); h.dismiss(); h.updatePosition();
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if ($content.isConnected || dismissals !== 1) {
        throw new Error(`Anchor retired append: escape=${escapeContainer}, connected=${$content.isConnected}, dismissals=${dismissals}`);
      }
      results.push(`Anchor ${escapeContainer ? "queued" : "immediate"} reveal retires exactly once`);
    }
    const before = document.body.childElementCount;
    const $content = document.createElement("div"); let calls = 0;
    const h = Anchor.revealAtPoint({ point: { x: 20, y: 20 }, $content, onDismiss: () => calls++ });
    if ($content.style.left !== "20px" || $content.style.top !== "20px") {
      throw new Error(`Point reveal placed content at ${$content.style.left}, ${$content.style.top}`);
    }
    results.push("Anchor point reveal places content at the point");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    h.dismiss();
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    if (calls !== 1 || document.body.childElementCount !== before) throw new Error("Point reveal retained its ephemeral anchor on Escape");
    results.push("Anchor point Escape retires ephemeral anchor exactly once");
  } finally { $anchor.remove(); }
  return results;
}
