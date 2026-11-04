import { InstanceUrl } from "@tento-core/instance-url";
import { Lazy } from "@tento-core/lazy";
import { Tracing } from "@tento-core/tracing";

import { DevModeUtils } from "../../dev-mode";

// Type surface for the vendored SnapDOM module (MIT — https://github.com/zumerlab/snapdom).
// SnapDOM rasterizes a live DOM node to an image: it clones the subtree, inlines
// *computed* styles (so CSS custom-property tokens resolve to concrete values), embeds
// web fonts, walks shadow DOM, and inlines same-origin images. Only the capture surface
// we use is typed here.
export interface SnapdomOptions {
  scale?: number;
  embedFonts?: boolean;
  backgroundColor?: string;
  format?: "png" | "jpeg" | "webp" | "svg";
  quality?: number;
}

export interface SnapdomCapture {
  toCanvas(): Promise<HTMLCanvasElement>;
  toBlob(): Promise<Blob>;
  toPng(): Promise<HTMLImageElement>;
}

export interface Snapdom {
  (el: Element, options?: SnapdomOptions): Promise<SnapdomCapture>;
  toCanvas(el: Element, options?: SnapdomOptions): Promise<HTMLCanvasElement>;
  toBlob(el: Element, options?: SnapdomOptions): Promise<Blob>;
  toPng(el: Element, options?: SnapdomOptions): Promise<HTMLImageElement>;
}

export interface SnapdomModule {
  snapdom: Snapdom;
}

export namespace SnapdomImport {
  // SnapDOM is a heavy (~120 KB) rasterizer only needed on demand, so it is NOT
  // bundled: it ships as a static asset (`so.lona.static/.../js/snapdom.min.js`) and
  // is loaded lazily via a runtime-URL dynamic import esbuild leaves external — the
  // same vendored-lib idiom as `prosemirror-import` / `codemirror`. One Lazy shares
  // the load across callers.
  const snapdomModule: Lazy<SnapdomModule> = new Lazy(async () => {
    const startedAt = performance.now();
    Tracing.info("ui")("snapdom/init-start", {});
    const loaded = await import(
      `${InstanceUrl.staticUrl("/js/snapdom.min.js")}?${DevModeUtils.queryParam}`
    );
    Tracing.info("ui")("snapdom/init-ready", {
      durationMs: Math.round(performance.now() - startedAt),
    });
    return loaded as SnapdomModule;
  });

  export async function get(): Promise<SnapdomModule> {
    return await snapdomModule.get();
  }
}
