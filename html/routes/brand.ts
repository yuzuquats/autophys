import { installSurfaceFinish, surfaceFinishStyles } from "./surface-finish.ts";

/** App-owned header branding; the first slide starts directly with its title.
 * The shell mounts synchronously after this module's import. One microtask
 * applies branding before the first paint; drawer navigation keeps these nodes.
 */
function mark(size: number): HTMLImageElement {
  const image = document.createElement("img");
  image.src = "/brand.svg";
  image.alt = "";
  image.width = size;
  image.height = size;
  image.setAttribute("aria-hidden", "true");
  image.dataset.autophysMark = "";
  image.style.cssText = "display:block;flex:none;object-fit:contain";
  return image;
}

queueMicrotask(() => {
  // The drawer saves/restores the landing offset. Native history restoration
  // runs after popstate and would overwrite it (often scrolling into the docs).
  history.scrollRestoration = "manual";

  // The cookbook changes fixed/document positioning and FLIPs only the wordmark.
  // Keep the deck in flow and reserve the arrow so docs and the logo never jump.
  // This app-owned override survives regeneration of vendor/tento.
  const navigationStyle = document.createElement("style");
  navigationStyle.textContent = `
    .ck-landing[data-lowered] { position: relative; inset: auto; }
    ${surfaceFinishStyles}
    .ck-header { --ck-gutter: 28px; }
    .ck-header .ck-nav-links { gap: 16px; }
    .ck-header :is(.ap-section-link, .ap-github-link) { display: inline-flex; align-items: center;
      min-height: 44px; color: var(--ck-ink); text-decoration: none; white-space: nowrap; }
    .ck-header .ap-section-link:hover { text-decoration: underline; text-underline-offset: 4px; }
    .ck-header .ap-github-link { justify-content: center; width: 32px; }
    .ck-header .ap-github-link svg { display: block; flex: none; }
    .ck-header .ap-github-link:hover { color: var(--ck-secondary); }
    .ck-header :is(.ap-section-link, .ap-github-link):focus-visible { outline: 2px solid var(--ck-ink); outline-offset: 3px; }
    .ck-header .ck-brand { padding-left: 28px; }
    /* GitHub is a landing link. Opening the app fades it out while its width
       (and the gap before it) closes, so Docs slides over beside the profile;
       closing reverses it. A transition, not a FLIP, so reversals never snap. */
    .ck-header .ap-github-link { max-width: 32px; overflow: hidden;
      transition: opacity 240ms ease 200ms, visibility 0s, max-width 700ms var(--ck-ease),
        margin-left 700ms var(--ck-ease); }
    .ck-header[data-app] .ap-github-link { max-width: 0; margin-left: -16px; opacity: 0;
      visibility: hidden; pointer-events: none;
      transition: opacity 180ms ease, visibility 0s linear 180ms, max-width 700ms var(--ck-ease),
        margin-left 700ms var(--ck-ease); }
    /* Phones keep Try now and Docs; the wordmark needs the room. */
    @media (max-width: 479px) { .ck-header .ap-github-link { display: none; } }
    @media (max-width: 359px) {
      .ck-header, .ck-header[data-app] { --ck-gutter: 16px; }
      .ck-header .ck-nav { gap: 12px; }
    }
  `;
  document.head.append(navigationStyle);
  const landing = document.querySelector<HTMLElement>(".ck-landing");
  if (landing) installSurfaceFinish(landing);

  const tryNow = document.querySelector<HTMLAnchorElement>(".ck-header .ck-open-link");
  if (tryNow) {
    tryNow.textContent = "Try now";
    // Docs and Studies are landing sections. From the landing a click scrolls
    // there; from the app it closes the workbench first and lands on the section.
    const sectionLink = (id: string, label: string): HTMLAnchorElement => {
      const link = document.createElement("a");
      link.className = "ap-section-link";
      link.href = `/#${id}`;
      link.textContent = label;
      link.addEventListener("click", event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const section = document.getElementById(id);
        if (!section) return;
        const fromApp = document.documentElement.dataset.ckStage !== "landing";
        if (fromApp) {
          const home = document.querySelector<HTMLAnchorElement>(".ck-header .ck-brand");
          if (!home) return; // Keep the ordinary link if the shell is unavailable.
          event.preventDefault();
          // Use the shell's normal close path so it restores the document and
          // disposes the workbench. A section link is a page switch: settle the cover and
          // header now, before scrolling, rather than playing the drawer return.
          home.click();
          history.replaceState(history.state, "", link.href);
          for (const element of document.querySelectorAll(".ck-landing, .ck-header .ck-wordmark, .ck-header .ap-github-link")) {
            for (const animation of element.getAnimations()) animation.finish();
          }
          section.scrollIntoView({ block: "start", behavior: "instant" });
          // The shell restores its trigger's focus when close finishes. Run
          // after that cleanup, before the next paint.
          requestAnimationFrame(() => {
            // Closing starts panel/toggle exit transitions in the completion
            // microtask. Settle those too so no workbench controls linger on the section.
            for (const animation of document.querySelector(".ck-app")?.getAnimations({ subtree: true }) ?? []) {
              animation.finish();
            }
            section.tabIndex = -1;
            section.focus({ preventScroll: true });
          });
          return;
        }
        event.preventDefault();
        if (location.hash !== `#${id}`) {
          const url = new URL(location.href);
          url.hash = id;
          history.pushState(history.state, "", url);
        }
        section.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        });
      });
      return link;
    };
    const docs = sectionLink("docs", "Docs");
    const studies = sectionLink("studies", "Studies");
    tryNow.after(docs, studies);

    const github = document.createElement("a");
    github.className = "ap-github-link";
    github.href = "https://github.com/yuzuquats/autophys";
    github.setAttribute("aria-label", "Autophys on GitHub");
    github.title = "Autophys on GitHub";
    github.innerHTML = `<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.2 0 .87-.01 1.57-.01 2.13 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
    studies.after(github);
  }

  const wordmark = document.querySelector(".ck-brand .ck-wordmark");
  if (
    wordmark && !wordmark.parentElement?.querySelector("[data-autophys-mark]")
  ) {
    const image = mark(32);
    image.style.marginRight = "4px";
    wordmark.before(image);
  }
  for (
    const eyebrow of document.querySelectorAll(".ck-hook .ck-slide-eyebrow")
  ) {
    eyebrow.remove();
  }
});
