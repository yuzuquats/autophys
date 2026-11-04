import { DomUtils } from "../dom";
import { GESTURE_MANAGER, GestureManager } from "../gesture-manager";

export function $jsx<K extends keyof HTMLElementTagNameMap | string>(
  name: K,
  config?: Optional<{
    className: string;
    style: CSSStyleWithVariables;
    pointerEvents: GestureManager.PointerEvents;
    slot: string;
    attributes: Record<string, string>;
    id: string;
  }>,
  content?: Option<string | Node | HTMLElement | (Node | HTMLElement)[]>,
): K extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[K]
  : HTMLElement {
  const $c = document.createElement(name);
  if (config?.className) {
    $c.classList.add(...config.className.split(" "));
  }
  if (config?.style) {
    $c.assignStyles(config.style);
  }
  if (config?.pointerEvents) {
    GESTURE_MANAGER.addPointerEvent($c, config.pointerEvents);
  }
  if (config?.slot) {
    $c.slot = config.slot;
  }
  if (config?.attributes) {
    DomUtils.assignAttributes($c, config.attributes);
  }
  if (config?.id) {
    $c.id = config.id;
  }
  if (content) {
    if (typeof content === "string") {
      $c.textContent = content;
    } else if (Array.isArray(content)) {
      $c.replaceChildren(...content);
    } else {
      $c.appendChild(content);
    }
  }
  return $c as any;
}
