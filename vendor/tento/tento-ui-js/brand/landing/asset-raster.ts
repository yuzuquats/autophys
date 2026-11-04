// Rasterize a live asset composition to a PNG and download it — the generic
// counterpart to `AssetPreview` / `Lightbox`.
//
// Brand assets built for the studio (productionized ad creatives, launch heroes,
// feature-card heroes) are live DOM trees, not `<img>`/SVG we can just link: their
// look depends on design tokens (`var(--…)`), web fonts, and shadow-DOM components.
// SnapDOM captures the *computed* result — tokens resolved, fonts embedded, shadow
// DOM walked, same-origin images inlined — which is what these compositions need.
//
// We build a FRESH instance offscreen at native size (the on-page preview is
// `transform:scale`-d DOWN, so capturing it would be soft), rasterize at `scale`,
// then trigger a browser download.

import { Tracing } from "@tento-core/tracing";

import { SnapdomImport } from "./snapdom-import";

export namespace AssetRaster {
  export type DownloadOptions = {
    // Download filename, e.g. "creative-fine-six-layers-shot.png".
    name: string;
    // Native pixel size the content is authored at. We render at this size so the
    // capture is full-fidelity (not the scaled-down preview).
    size: Size;
    // Output pixel multiplier (2 = @2x, so 928×1152 → 1856×2304 crisp PNG).
    scale: number;
  };

  // Build a fresh composition, rasterize it to a PNG, and download it. `makeContent`
  // must return a self-contained, natively-sized node. Resolves once the download has
  // been triggered; rejects if the capture failed.
  export async function downloadPng(
    makeContent: () => HTMLElement,
    options: AssetRaster.DownloadOptions,
  ): Promise<void> {
    const { snapdom } = await SnapdomImport.get();
    const $content = makeContent();

    // Mount OFFSCREEN but RENDERED — snapdom reads getComputedStyle, so the node must
    // be laid out. `display:none` would zero its geometry; instead pin it off-screen
    // and invisible at its native size.
    const $host = document.createElement("div");
    $host.setAttribute("aria-hidden", "true");
    $host.style.cssText = [
      "position:fixed",
      "left:-99999px",
      "top:0",
      `width:${options.size.width}px`,
      `height:${options.size.height}px`,
      "opacity:0",
      "pointer-events:none",
      "z-index:-1",
    ].join(";");
    $host.appendChild($content);
    document.body.appendChild($host);

    try {
      // Web fonts must be loaded before capture or text rasterizes in a fallback
      // face. Already-loaded fonts resolve this immediately.
      await document.fonts.ready;

      // Rasterize to a canvas, then encode with the browser's native PNG encoder.
      // (snapdom's own toBlob passes options through and can yield its intermediate
      // SVG — going through the canvas guarantees a real PNG.) All resources are
      // inlined as data URIs, so the canvas is untainted.
      const canvas = await snapdom.toCanvas($content, {
        scale: options.scale,
        embedFonts: true,
      });
      const blob = await canvasToPngBlob(canvas);
      triggerDownload(blob, options.name);
      Tracing.log("asset-raster-download", { name: options.name, bytes: blob.size });
    } finally {
      $host.remove();
    }
  }

  // Encode a canvas as a real PNG Blob via the browser's native encoder.
  function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob != null
            ? resolve(blob)
            : reject(new Error("canvas.toBlob returned null")),
        "image/png",
      );
    });
  }

  // Save a Blob to disk via a transient anchor.
  function triggerDownload(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const $a = document.createElement("a");
    $a.href = url;
    $a.download = name;
    document.body.appendChild($a);
    $a.click();
    $a.remove();
    // Revoke after the click has consumed the URL so the download isn't cancelled.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
