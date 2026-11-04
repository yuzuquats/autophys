import { AppBar } from "./app-bar";

/** Run in the maintained native-browser component harness. */
export async function verifyAppBar(): Promise<string[]> {
  const checkLabels = ($element: AppBar, title: string, meta: string): void => {
    if ($element.$title.textContent !== title || $element.$meta.textContent !== meta) {
      throw new Error(`Expected title ${title} and status ${meta}`);
    }
  };
  const $bar = AppBar.makeWith({ title: "Previous", meta: "Old status" });
  document.body.append($bar);
  const $start = document.createElement("button");
  $start.slot = "start";
  $start.textContent = "Menu";
  const nextSlotChange = (): Promise<void> => new Promise((resolve) => {
    const $slot = $bar.shadowRoot?.querySelector('slot[name="start"]');
    if (!($slot instanceof HTMLSlotElement)) throw new Error("Missing start slot");
    $slot.addEventListener("slotchange", () => resolve(), { once: true });
  });
  try {
    const added = nextSlotChange();
    $bar.append($start);
    await added;
    if (!$bar.hasAttribute("has-start")) throw new Error("Start slot must expose its separator");
    const removed = nextSlotChange();
    $start.remove();
    await removed;
    if ($bar.hasAttribute("has-start")) throw new Error("Empty start slot must hide its separator");
    $bar.bind({ title: "Current", meta: null });
    checkLabels($bar, "Current", "");
    $bar.bind({ title: "Previous", meta: "Old status" });
    $bar.setAttribute("has-start", "");
    $bar.onRecycle();
    checkLabels($bar, "", "");
    if ($bar.hasAttribute("has-start")) {
      throw new Error("Recycling must clear shadow labels and the separator state");
    }
    $bar.bind({ title: "Reused", meta: "Fresh status" });
    checkLabels($bar, "Reused", "Fresh status");
    return ["start slot tracks its separator", "bind replaces both labels", "recycle clears shadow state", "rebind restores labels"];
  } finally {
    $bar.remove();
  }
}
