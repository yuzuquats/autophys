/** The Muse Code plugin heading's mascot. Hovering the heading slides the dancing Muse in from
 * beyond the page's left edge to stand just left of the heading, centred on the heading's text,
 * and leaving slides it back off the page. The SVG
 * animates itself (and stays still under reduced motion); it loads only when the heading comes
 * near. Decorative: hidden from assistive tech and from the pointer, so it
 * never steals the hover that shows it. */

const SRC = "/muse-twerk.svg";
const HEADING = "Muse Code plugin";
const WIDTH = 64; // px; the figure stands about two heading lines tall
const GAP = 12; // px between the figure and the heading's text

export const MUSE_PEEK_CSS = `
.ap-landing-docs { position: relative; overflow-x: clip; }
.ap-muse-peek {
  position: absolute; z-index: 1; top: 0; left: 0; width: ${WIDTH}px; height: auto;
  pointer-events: none; user-select: none;
  opacity: 0; transform: translateX(var(--ap-peek-off, -100vw)); transform-origin: 50% 100%;
  transition: transform 420ms cubic-bezier(.5, 0, .75, 0), opacity 0ms linear 420ms;
}
.ap-muse-peek[data-shown] {
  opacity: 1; transform: none;
  transition: transform 640ms cubic-bezier(.3, 1.25, .5, 1), opacity 0ms;
}
@media (prefers-reduced-motion: reduce) {
  .ap-muse-peek, .ap-muse-peek[data-shown] { transform: none; transition: opacity 200ms linear; }
}
`;

/** Wires the mascot to the heading once std-documentation has drawn it. */
export function museSectionPeek(host: HTMLElement, doc: HTMLElement): void {
  const root = doc.shadowRoot;
  if (!root) return;
  const find = (): HTMLElement | null =>
    [...root.querySelectorAll<HTMLElement>("h2")].find((h) => h.textContent?.trim() === HEADING) ?? null;
  const heading = find();
  if (heading) return wire(host, heading);
  const watch = new MutationObserver(() => {
    const h = find();
    if (h) { watch.disconnect(); wire(host, h); }
  });
  watch.observe(root, { childList: true, subtree: true });
}

function wire(host: HTMLElement, heading: HTMLElement): void {
  const img = document.createElement("img");
  img.className = "ap-muse-peek";
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.decoding = "async";
  img.draggable = false;
  host.append(img);

  new IntersectionObserver((entries, io) => {
    if (entries.some((e) => e.isIntersecting)) { img.src = SRC; io.disconnect(); }
  }, { rootMargin: "800px 0px" }).observe(heading);

  /** Just left of the heading's text, with the figure's centre line on the text's centre line;
   * hidden, it waits just past the page's left edge. */
  const place = (): void => {
    const range = document.createRange();
    range.selectNodeContents(heading);
    // Absolute positions start inside the host's border (the docs section has a 1px top rule).
    const text = range.getBoundingClientRect(), r = host.getBoundingClientRect();
    const box = { left: r.left + host.clientLeft, top: r.top + host.clientTop };
    const height = WIDTH * (1246 / 1262), left = text.left - box.left - GAP - WIDTH;
    img.style.left = `${left}px`;
    img.style.top = `${(text.top + text.bottom) / 2 - box.top - height / 2}px`;
    img.style.setProperty("--ap-peek-off", `${-(box.left + left + WIDTH + 8)}px`);
  };

  heading.addEventListener("pointerenter", () => { place(); img.toggleAttribute("data-shown", true); });
  heading.addEventListener("pointerleave", () => img.toggleAttribute("data-shown", false));
}
