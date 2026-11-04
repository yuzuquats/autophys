import { Badge } from "./badge";
import { IconButton } from "./icon-button";

export async function verifyReplacementProps(): Promise<string[]> {
  const badge = Badge.makeWith({ content: 0 });
  if (badge.textContent !== "0") throw new Error("Badge discarded numeric zero");
  badge.bind({ content: "old" }); badge.bind({});
  if (badge.childElementCount !== 0) throw new Error("Badge absent replacement retained content");
  badge.bind({ content: "old" }); badge.bind({ content: null });
  if (badge.childElementCount !== 0) throw new Error("Badge null replacement retained content");
  const icon = IconButton.makeWith({ squarish: true, ariaLabel: "Old" });
  icon.bind({ squarish: false, ariaLabel: "New" });
  if (icon.hasAttribute("squarish") || icon.getAttribute("aria-label") !== "New") throw new Error("IconButton replacement shape/name");
  icon.bind({});
  if (icon.hasAttribute("aria-label")) throw new Error("IconButton retained omitted accessible name");
  Badge.recycle(badge); IconButton.recycle(icon);
  await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const b = Badge.makeWith({ content: 0 }), i = IconButton.makeWith({});
  if (b !== badge || i !== icon || b.textContent !== "0" || i.hasAttribute("squarish") || i.hasAttribute("aria-label")) throw new Error("Pooled replacement Props retain prior occupant");
  Badge.recycle(b); IconButton.recycle(i);
  return ["Badge zero/absent and IconButton replacement reset through actual pool reuse"];
}
