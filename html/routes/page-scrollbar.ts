/**
 * An overlay scrollbar for the landing page.
 *
 * The cookbook hides the page's native scrollbar (html { scrollbar-width: none })
 * because a classic scrollbar takes width and would shift the full-width deck.
 * Without one, the long docs below the deck are hard to move through. This draws
 * a scrollbar over the page instead: it takes no layout width, stays hidden at
 * the top of the deck, appears once the page has scrolled, and its thumb can be
 * dragged or its track clicked.
 *
 * It mounts only on Lona's hosted sites (SCROLLBAR_HOSTS: autophys.lona.so
 * and its dev-- preview), not in a clone or on a local daemon, and runs only
 * on the landing stage, not in the tour or the app.
 */
export const SCROLLBAR_HOSTS: ReadonlySet<string> = new Set(["autophys.lona.so", "dev--autophys.lona.so"]);

export function pageScrollbarEnabled(hostname: string): boolean {
  return SCROLLBAR_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

/** Thumb length and offset (px) for a track of `track` px over a page of `scrollHeight` px. */
export function thumbGeometry(
  track: number, viewport: number, scrollHeight: number, scrollTop: number, minThumb = 32,
): { length: number; offset: number } | null {
  const range = scrollHeight - viewport;
  if (range <= 0 || track <= 0) return null;
  const length = Math.min(track, Math.max(minThumb, Math.round(track * viewport / scrollHeight)));
  const progress = Math.min(1, Math.max(0, scrollTop / range));
  return { length, offset: Math.round((track - length) * progress) };
}

const INSET = 6; // track inset from the viewport's top and bottom edges

const CSS = `
.ap-page-scrollbar { position: fixed; top: ${INSET}px; bottom: ${INSET}px; right: 2px; width: 14px; z-index: 14;
  opacity: 0; pointer-events: none; transition: opacity 200ms ease; touch-action: none; }
.ap-page-scrollbar[data-visible] { opacity: 1; pointer-events: auto; }
.ap-page-scrollbar-thumb { position: absolute; top: 0; right: 3px; width: 6px; border-radius: 6px;
  background: rgb(20 20 20 / 0.28); transition: width 120ms ease, background-color 120ms ease; cursor: default; }
.ap-page-scrollbar:hover .ap-page-scrollbar-thumb, .ap-page-scrollbar[data-dragging] .ap-page-scrollbar-thumb {
  width: 9px; background: rgb(20 20 20 / 0.45); }
html:not([data-ck-stage="landing"]) .ap-page-scrollbar { display: none; }
/* Touch screens: an indicator only. A swipe that starts at the right edge
   must scroll the page, not land on the track and jump a viewport. */
@media (pointer: coarse) { .ap-page-scrollbar[data-visible] { pointer-events: none; } }
`;

export function mountPageScrollbar(hostname: string): (() => void) | null {
  if (!pageScrollbarEnabled(hostname)) return null;
  const style = document.createElement("style");
  style.textContent = CSS;
  const bar = document.createElement("div");
  bar.className = "ap-page-scrollbar";
  bar.setAttribute("aria-hidden", "true"); // the page itself stays keyboard and wheel scrollable
  const thumb = document.createElement("div");
  thumb.className = "ap-page-scrollbar-thumb";
  bar.append(thumb);
  document.head.append(style);
  document.body.append(bar);

  const root = document.scrollingElement ?? document.documentElement;
  let frame = 0;
  let geometry: { length: number; offset: number } | null = null;
  const draw = () => {
    frame = 0;
    const track = bar.clientHeight;
    geometry = thumbGeometry(track, innerHeight, root.scrollHeight, root.scrollTop);
    const show = geometry != null && root.scrollTop > 8;
    bar.toggleAttribute("data-visible", show || bar.hasAttribute("data-dragging"));
    if (geometry) {
      thumb.style.height = `${geometry.length}px`;
      thumb.style.transform = `translateY(${geometry.offset}px)`;
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  // Drag the thumb: map pointer travel on the track to page scroll.
  let drag: { pointer: number; startY: number; startTop: number } | null = null;
  const scrollPerPixel = () => {
    const track = bar.clientHeight;
    return geometry ? (root.scrollHeight - innerHeight) / Math.max(1, track - geometry.length) : 0;
  };
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault(); event.stopPropagation();
    drag = { pointer: event.pointerId, startY: event.clientY, startTop: root.scrollTop };
    thumb.setPointerCapture(event.pointerId);
    bar.toggleAttribute("data-dragging", true);
  });
  thumb.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    root.scrollTop = drag.startTop + (event.clientY - drag.startY) * scrollPerPixel();
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null; bar.toggleAttribute("data-dragging", false); schedule();
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
  // Click the track: page up or down by one viewport, like a native track.
  bar.addEventListener("pointerdown", (event) => {
    if (event.target !== bar || !geometry) return;
    event.preventDefault(); event.stopPropagation();
    const y = event.clientY - bar.getBoundingClientRect().top;
    const page = innerHeight * 0.9;
    root.scrollBy({ top: y < geometry.offset ? -page : page, behavior: "smooth" });
  });

  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  const sizes = new ResizeObserver(schedule);
  sizes.observe(document.body);
  const stage = new MutationObserver(schedule);
  stage.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ck-stage"] });
  schedule();
  return () => {
    removeEventListener("scroll", schedule); removeEventListener("resize", schedule);
    sizes.disconnect(); stage.disconnect(); if (frame) cancelAnimationFrame(frame);
    bar.remove(); style.remove();
  };
}
