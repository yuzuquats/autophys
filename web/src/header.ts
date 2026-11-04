import { ease, h, reducedMotion } from "./dom.ts";

export type Header = {
  readonly el: HTMLElement;
  readonly brand: HTMLAnchorElement;
  setAppState(open: boolean): void;
  setCrumb(text: string): void;
};

/** The site header. On the landing it is a transparent bar with the wordmark
 * and an "Open app" link; in the app a white menubar fades in behind it, a
 * back arrow slides in before the wordmark, the link fades and the breadcrumb
 * names the open item. `onHome` runs when the wordmark is pressed. */
export function createHeader(onHome: () => void): Header {
  const el = h("header", "site-header");
  el.innerHTML = `<nav class="site-nav" aria-label="Site">
    <span class="menubar-surface" aria-hidden="true"></span>
    <div class="nav-start">
      <a class="brand" href="/" aria-label="autophys home"><svg class="brand-back" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H4m5.5-5.5L4 10l5.5 5.5"/></svg><span class="wordmark">autophys</span></a>
      <div class="crumbs" aria-label="Breadcrumb"><span class="crumb-divider" aria-hidden="true">/</span><span class="crumb-current" aria-current="page"></span></div>
    </div>
    <div class="nav-links"><a class="open-link" href="/app">Open app</a></div>
  </nav>`;
  const brand = el.querySelector<HTMLAnchorElement>(".brand")!;
  const wordmark = el.querySelector<HTMLElement>(".wordmark")!;
  const crumb = el.querySelector<HTMLElement>(".crumb-current")!;
  const link = el.querySelector<HTMLAnchorElement>(".open-link")!;
  let motion: Animation | undefined;

  brand.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onHome();
  });

  return {
    el,
    brand,
    setAppState(open) {
      if (el.hasAttribute("data-app") === open) return;
      // First: include any in-flight transform so a reversal never snaps.
      const first = wordmark.getBoundingClientRect();
      motion?.cancel();
      el.toggleAttribute("data-app", open);
      // Last: the back arrow now reserves its layout space.
      const last = wordmark.getBoundingClientRect();
      if (!reducedMotion()) {
        motion = wordmark.animate([
          { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)` },
          { transform: "none" },
        ], { duration: 700, easing: ease });
      }
      brand.setAttribute("aria-label", open ? "Back to the deck" : "autophys home");
      link.inert = open;
    },
    setCrumb(text) {
      crumb.textContent = text;
    },
  };
}
