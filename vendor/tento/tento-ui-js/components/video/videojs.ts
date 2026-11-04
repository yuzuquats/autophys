import { Lazy } from "@tento-core/lazy";

/**
 * Lazy-loads Video.js v10 (`@videojs/html`) — the exact player shipped on
 * videojs.org, as vanilla Web Components (no React). Loading the CDN modules
 * registers the custom elements as a side effect:
 *
 *   - `cdn/video.js`             → <video-player>, <video-skin> (the DEFAULT
 *                                   skin — videojs.org's homepage look),
 *                                   self-injects its skin CSS.
 *   - `cdn/media/hlsjs-video.js` → <hlsjs-video> media element (hls.js MSE).
 *
 * Same containment as the media-chrome wrapper: it's a remote ESM import, so it
 * code-splits and loads only where it's awaited. Markup:
 *
 *   <video-player>
 *     <video-skin poster="…">
 *       <hlsjs-video src="…m3u8" crossorigin playsinline></hlsjs-video>
 *     </video-skin>
 *   </video-player>
 *
 * Application code should create the HLS element with makeHlsVideo() after
 * this import resolves so all players use the same subtitle defaults.
 */
// Load ORDER MATTERS: the player/skin bundle must define + upgrade
// <video-player> (which creates the player store) BEFORE the media element
// upgrades, so <hlsjs-video> can attach itself as the store's media target.
// Importing them in parallel races the media element ahead of the store and
// produces `StoreError: NO_TARGET` when the controls try to drive playback.
export const VIDEOJS_IMPORT: Lazy<unknown> = new Lazy(async () => {
  await import(
    // @ts-ignore — remote ESM, resolved at runtime
    "https://cdn.jsdelivr.net/npm/@videojs/html@10.0.0-beta.25/cdn/video.js"
  );
  return import(
    // @ts-ignore — remote ESM, resolved at runtime
    "https://cdn.jsdelivr.net/npm/@videojs/html@10.0.0-beta.25/cdn/media/hlsjs-video.js"
  );
});

/** Create after VIDEOJS_IMPORT resolves. English captions start enabled when
 * available; the player's captions menu can still select another track or Off.
 */
export function makeHlsVideo(hlsOptions: Record<string, unknown> = {}): HTMLElement {
  const media = document.createElement("hlsjs-video");
  (media as HTMLElement & { config: unknown }).config = {
    hlsJs: {
      subtitlePreference: { lang: "en" },
      renderTextTracksNatively: true,
      ...hlsOptions,
    },
  };
  return media;
}
