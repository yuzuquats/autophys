import { Popover } from "./popover";
import { Focus } from "../../ui/focus";

export async function verifyPopoverLifecycle(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const results: string[] = [];
  const $invoker = document.createElement("button"), $other = document.createElement("button");
  document.body.append($invoker, $other);
  try {
    for (const kind of ["native", "shadow", "slot", "fallback"]) {
      $invoker.focus();
      let dismissals = 0;
      const $content = document.createElement("div");
      const $disabled = document.createElement("button"); $disabled.disabled = true;
      $content.append($disabled);
      const $action = document.createElement("button"); $action.textContent = "Action";
      if (kind === "native") $content.append($action);
      if (kind === "shadow") $content.attachShadow({ mode: "open" }).append($action);
      if (kind === "slot") {
        $content.attachShadow({ mode: "open" }).append(document.createElement("slot"));
        $content.append($action);
      }
      const h = Popover.show({ $anchor: $invoker, $content: () => $content, role: "dialog",
        label: "Actions", placement: null, arrow: false, onDismiss: () => dismissals++ });
      try {
        await frame();
        const expected = kind === "fallback" ? h.$popover : $action;
        if (Focus.activeDeep() !== expected) throw new Error(`Popover ${kind} entry did not focus live usable content`);
        h.dismiss(); h.dismiss();
        if (dismissals !== 1 || Focus.activeDeep() !== $invoker || h.$popover.isConnected) {
          throw new Error(`Popover ${kind} dismissal did not restore owned focus exactly once`);
        }
        results.push(`Popover ${kind} entry and dismissal`);
      } finally { h.dismiss(); }
    }
    $invoker.focus();
    const h = Popover.show({ $anchor: $invoker, $content: () => document.createElement("button"),
      role: "dialog", label: "Retired", placement: null, arrow: false, onDismiss: null });
    h.dismiss(); $other.focus(); await frame();
    if (Focus.activeDeep() !== $other || h.$popover.isConnected) throw new Error("Dismiss-before-mount stole caller focus or appended");
    results.push("Popover dismiss-before-mount preserves caller focus");
    $invoker.focus();
    const live = Popover.show({ $anchor: $invoker, $content: () => document.createElement("button"),
      role: "dialog", label: "Moved", placement: null, arrow: false, onDismiss: null });
    await frame(); $other.focus(); live.dismiss();
    if (Focus.activeDeep() !== $other) throw new Error("Popover dismissal overwrote deliberate caller focus");
    results.push("Popover preserves deliberate caller focus move");
    for (const mode of ["rebind", "recycle"]) {
      $invoker.focus(); let calls = 0;
      const props: Popover.Props = { $content: () => document.createElement("button"), role: "dialog", label: "Old", arrow: false, placement: null, onDismiss: () => calls++ };
      const pending = Popover.show({ ...props, $anchor: $invoker });
      if (mode === "rebind") pending.$popover.bind({ ...props, label: "New" });
      else Popover.recycle(pending.$popover);
      $other.focus(); await frame(); pending.dismiss();
      if (calls !== 1 || pending.$popover.isConnected || Focus.activeDeep() !== $other) throw new Error(`Popover ${mode} before attachment did not retire focus/handle`);
      if (mode === "rebind") Popover.recycle(pending.$popover);
      await frame(); const reused = Popover.makeWith({ ...props, label: "Current" });
      if (reused !== pending.$popover || reused.getAttribute("aria-label") !== "Current") throw new Error("Popover actual pooled reuse missing");
      pending.dismiss();
      if (reused.getAttribute("aria-label") !== "Current" || calls !== 1) throw new Error("Old Popover handle affected its successor");
      Popover.recycle(reused); await frame(); results.push(`Popover ${mode} before mount and actual pooled replacement`);
    }
  } finally { $invoker.remove(); $other.remove(); }
  return results;
}
