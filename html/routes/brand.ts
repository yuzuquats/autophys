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
  // The cookbook changes fixed/document positioning and FLIPs only the wordmark.
  // Keep the deck in flow and reserve the arrow so docs and the logo never jump.
  // This app-owned override survives regeneration of vendor/tento.
  const navigationStyle = document.createElement("style");
  navigationStyle.textContent = `
    .ck-landing[data-lowered] { position: relative; inset: auto; }
    .ck-landing { transition: none; }
    .ck-header { --ck-gutter: 28px; }
    .ck-header .ck-brand { padding-left: 28px; }
  `;
  document.head.append(navigationStyle);

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
