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
    .ck-header .ap-docs-link { display: inline-flex; align-items: center; min-height: 44px;
      color: var(--ck-ink); text-decoration: none; white-space: nowrap; }
    .ck-header .ap-docs-link:hover { text-decoration: underline; text-underline-offset: 4px; }
    .ck-header .ap-docs-link:focus-visible { outline: 2px solid var(--ck-ink); outline-offset: 3px; }
    .ck-header .ck-brand { padding-left: 28px; }
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
    const docs = document.createElement("a");
    docs.className = "ap-docs-link";
    docs.href = "/#docs";
    docs.textContent = "Docs";
    docs.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const section = document.getElementById("docs");
      if (!section) return;
      const fromApp = document.documentElement.dataset.ckStage !== "landing";
      if (fromApp) {
        const home = document.querySelector<HTMLAnchorElement>(".ck-header .ck-brand");
        if (!home) return; // Keep the ordinary link if the shell is unavailable.
        event.preventDefault();
        // Use the shell's normal close path so it restores the document and
        // disposes the workbench. Docs is a page switch: settle the cover and
        // header now, before scrolling, rather than playing the drawer return.
        home.click();
        history.replaceState(history.state, "", docs.href);
        for (const element of document.querySelectorAll(".ck-landing, .ck-header .ck-wordmark")) {
          for (const animation of element.getAnimations()) animation.finish();
        }
        section.scrollIntoView({ block: "start", behavior: "instant" });
        // The shell restores its trigger's focus when close finishes. Run
        // after that cleanup, before the next paint.
        requestAnimationFrame(() => {
          // Closing starts panel/toggle exit transitions in the completion
          // microtask. Settle those too so no workbench controls linger on Docs.
          for (const animation of document.querySelector(".ck-app")?.getAnimations({ subtree: true }) ?? []) {
            animation.finish();
          }
          section.tabIndex = -1;
          section.focus({ preventScroll: true });
        });
        return;
      }
      event.preventDefault();
      if (location.hash !== "#docs") {
        const url = new URL(location.href);
        url.hash = "docs";
        history.pushState(history.state, "", url);
      }
      section.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    });
    tryNow.after(docs);
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
