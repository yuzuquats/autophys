/** The Muse Code plugin section's mascot. Hovering the section (its band of the page, heading to
 * the next heading) slides the dancing Muse out from beyond the page's right edge into the margin
 * beside it, and leaving slides it back. Narrow pages have no margin, so Muse peeks in beside the
 * heading instead. The SVG animates itself (and stays still under reduced motion); it loads only
 * when the section comes near, since it is 1.4 MB. Decorative: hidden from assistive tech and
 * from the pointer, so it never steals the hover that shows it. */

const SRC = "/muse-twerk.svg";
const HEADING = "Muse Code plugin";
const COLUMN = 800; // std-documentation's max-width in the docs section (docs.ts CSS)

export const MUSE_PEEK_CSS = `
.ap-landing-docs { position: relative; overflow-x: clip; }
.ap-muse-peek {
  position: absolute; z-index: 1; height: auto; pointer-events: none; user-select: none;
  opacity: 0; transform: translateX(var(--ap-peek-off, 110vw)) rotate(10deg);
  transition: transform 320ms cubic-bezier(.5, 0, .75, 0), opacity 320ms ease-in;
}
.ap-muse-peek[data-shown] {
  opacity: 1; transform: none;
  transition: transform 560ms cubic-bezier(.3, 1.35, .5, 1), opacity 160ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .ap-muse-peek, .ap-muse-peek[data-shown] { transform: none; transition: opacity 200ms linear; }
}
`;

/** Wires the mascot to the section once std-documentation has drawn its headings. */
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

  /** The section's band: from its heading to the next heading, or the end of the docs. */
  const band = (): { top: number; bottom: number } => {
    let next = heading.nextElementSibling;
    while (next && next.tagName !== "H2") next = next.nextElementSibling;
    const top = heading.getBoundingClientRect().top;
    const bottom = next ? next.getBoundingClientRect().top : host.getBoundingClientRect().bottom;
    return { top: top - 12, bottom: bottom - 12 };
  };

  const place = (): void => {
    const box = host.getBoundingClientRect(), h = heading.getBoundingClientRect();
    const column = Math.min(COLUMN, box.width - 40), colRight = (box.width + column) / 2;
    const gutter = box.width - colRight;
    let left: number, top: number, width: number;
    if (gutter >= 200) {
      width = Math.min(260, gutter - 48);
      left = colRight + 24;
      top = h.top - box.top - width * 0.15;
    } else {
      width = 104;
      left = colRight - width;
      top = h.top - box.top - width * 0.55;
    }
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    img.style.width = `${width}px`;
    img.style.setProperty("--ap-peek-off", `${box.width - left + 24}px`);
  };

  let shown = false, frame = 0, pointerY: number | null = null;
  const set = (on: boolean): void => {
    if (on === shown) return;
    shown = on;
    if (on) place();
    img.toggleAttribute("data-shown", on);
  };
  const check = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const b = band();
      set(pointerY !== null && pointerY >= b.top && pointerY < b.bottom);
    });
  };
  host.addEventListener("pointermove", (e) => { pointerY = e.clientY; check(); });
  host.addEventListener("pointerleave", () => { pointerY = null; set(false); });
  // Scrolling under a still pointer moves the section in or out from under it.
  addEventListener("scroll", () => { if (pointerY !== null) check(); }, { passive: true });
}
