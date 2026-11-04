/** The Muse Code plugin heading's mascot. Hovering the heading slides the dancing Muse in from
 * the left to stand just right of the heading's text, and leaving slides it back. The SVG
 * animates itself (and stays still under reduced motion); it loads only when the heading comes
 * near, since it is 1.4 MB. Decorative: hidden from assistive tech and from the pointer, so it
 * never steals the hover that shows it. */

const SRC = "/muse-twerk.svg";
const HEADING = "Muse Code plugin";
const WIDTH = 64; // px; the figure stands about two heading lines tall

export const MUSE_PEEK_CSS = `
.ap-landing-docs { position: relative; overflow-x: clip; }
.ap-muse-peek {
  position: absolute; z-index: 1; top: 0; left: 0; width: ${WIDTH}px; height: auto;
  pointer-events: none; user-select: none;
  opacity: 0; transform: translateX(-56px) rotate(-8deg) scale(.85); transform-origin: 50% 100%;
  transition: transform 280ms cubic-bezier(.5, 0, .75, 0), opacity 220ms ease-in;
}
.ap-muse-peek[data-shown] {
  opacity: 1; transform: none;
  transition: transform 520ms cubic-bezier(.3, 1.4, .5, 1), opacity 160ms ease-out;
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

  /** Stand on the heading's baseline, just right of its text (not the full-width block). */
  const place = (): void => {
    const range = document.createRange();
    range.selectNodeContents(heading);
    const text = range.getBoundingClientRect(), box = host.getBoundingClientRect();
    const height = WIDTH * (1246 / 1262);
    img.style.left = `${text.right - box.left + 10}px`;
    img.style.top = `${text.bottom - box.top - height + 4}px`;
  };

  heading.addEventListener("pointerenter", () => { place(); img.toggleAttribute("data-shown", true); });
  heading.addEventListener("pointerleave", () => img.toggleAttribute("data-shown", false));
}
