/** `h("div", "class", child, ...)` with optional attributes as the third argument. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  attrs: Record<string, string> | null = null,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One easing for every surface move, so the pieces read as one motion. */
export const ease = "cubic-bezier(.22,.61,.36,1)";

export function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"));
}

/** Fade new content in place: short, small rise, no layout change. */
export function settleIn(el: Element): void {
  if (reducedMotion()) return;
  el.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
    duration: 220,
    easing: ease,
  });
}
