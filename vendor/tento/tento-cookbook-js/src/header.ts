import { ease, h, reducedMotion } from "./dom.ts";

export type Header = {
  readonly el: HTMLElement;
  readonly brand: HTMLAnchorElement;
  setAppState(open: boolean): void;
  setCrumb(text: string): void;
};

/** The shell header. On the landing it is a transparent bar with the
 * wordmark and an "Open app" link; in the app a white menubar fades in behind
 * it, a back arrow slides in before the wordmark (FLIP), the link gives way
 * to Export, and the breadcrumb shows when the app sets one. */
export function createHeader(options: {
  title: string;
  appPath: string;
  onHome(): void;
  onExport(): void;
}): Header {
  const el = h("header", "ck-header");
  el.innerHTML = `<nav class="ck-nav" aria-label="Site">
    <span class="ck-menubar" aria-hidden="true"></span>
    <div class="ck-nav-start">
      <a class="ck-brand" href="/"><svg class="ck-brand-back" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H4m5.5-5.5L4 10l5.5 5.5"/></svg><span class="ck-wordmark"></span></a>
      <div class="ck-crumbs" aria-label="Breadcrumb"><span class="ck-crumb-divider" aria-hidden="true">/</span><span class="ck-crumb-current" aria-current="page"></span></div>
    </div>
    <div class="ck-nav-links"><a class="ck-open-link">Open app</a><button type="button" class="ck-export">Export</button></div>
  </nav>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const brand = q<HTMLAnchorElement>(".ck-brand");
  const wordmark = q<HTMLElement>(".ck-wordmark");
  const crumbs = q<HTMLElement>(".ck-crumbs");
  const crumb = q<HTMLElement>(".ck-crumb-current");
  const link = q<HTMLAnchorElement>(".ck-open-link");
  const exportButton = q<HTMLButtonElement>(".ck-export");
  wordmark.textContent = options.title;
  brand.setAttribute("aria-label", `${options.title} home`);
  link.href = options.appPath;
  exportButton.inert = true;
  crumbs.hidden = true;
  let motion: Animation | undefined;

  brand.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    options.onHome();
  });
  exportButton.addEventListener("click", () => options.onExport());

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
      brand.setAttribute("aria-label", open ? "Back to the deck" : `${options.title} home`);
      link.inert = open;
      exportButton.inert = !open;
    },
    setCrumb(text) {
      crumb.textContent = text;
      crumbs.hidden = !text;
    },
  };
}
