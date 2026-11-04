import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";
import { $$ } from "@tento-ui/fastdom";
import { Lazy } from "@tento-core/lazy";
import { MEDIA_CHROME_IMPORT } from "./media-chrome";

// See media-chrome.ts: the specifier stays in a binding so Deno's graph
// builder cannot follow this browser-only import into a network fetch.
const HLS_VIDEO_URL = "https://cdn.jsdelivr.net/npm/hls-video-element@1.1/+esm";

type HlsVideoImport = {};

interface HlsVideoElement extends HTMLElement {
  load(): Promise<void>;
}

@component({
  name: "std-hls-player",
})
export class HlsPlayer extends LonaWebComponent {
  private static import: Lazy<HlsVideoImport> = new Lazy(
    () => import(HLS_VIDEO_URL),
  );

  private $video: Option<HlsVideoElement>;
  private hydrated = false;

  async bind() {
    await this.initIfNecessary();
  }

  async initIfNecessary() {
    if (this.hydrated) return;
    await Promise.all([MEDIA_CHROME_IMPORT.get(), HlsPlayer.import.get()]);
    $$.mutate(() => {
      this.hydrate("media-controller");
      this.hydrate("control-bar");
      this.$video = this.hydrate<HlsVideoElement>("video");
      this.$video.load().then(() => {
        setTimeout(() => {
          $$.mutate(() => {
            this.$("root").style.opacity = "1";
          });
        }, 300);
      });
    });
    this.hydrated = true;
  }

  static $styles: Style.Compat[] = [
    css`
      #root {
        opacity: 0;
        transition: opacity 0.5s ease;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <media-controller id="media-controller">
        <hls-video
          id="video"
          src="https://stream.mux.com/O6LdRc0112FEJXH00bGsN9Q31yu5EIVHTgjTKRkKtEq1k.m3u8"
          poster="https://image.mux.com/O6LdRc0112FEJXH00bGsN9Q31yu5EIVHTgjTKRkKtEq1k/thumbnail.jpg?time=56"
          crossorigin
          playsinline
          slot="media"
          muted
          preload="none"
        >
          <track
            default
            kind="metadata"
            label="thumbnails"
            src="https://image.mux.com/O6LdRc0112FEJXH00bGsN9Q31yu5EIVHTgjTKRkKtEq1k/storyboard.vtt"
          />
        </hls-video>
        <media-control-bar id="control-bar">
          <media-play-button></media-play-button>
          <media-mute-button></media-mute-button>
          <media-volume-range></media-volume-range>
          <media-time-range></media-time-range>
        </media-control-bar>
      </media-controller>
    </std-col>
  `;
}

// <media-pip-button></media-pip-button>
// <media-fullscreen-button></media-fullscreen-button>
