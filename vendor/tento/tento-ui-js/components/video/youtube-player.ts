import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { Lazy } from "@tento-core/lazy";
import { AsyncStateManager } from "@tento-core/async-state-manager";
import { nonnull } from "@tento-core/assert";
import { YoutubeUrl } from "./youtube-url";

type MediaChromeImport = {};
type YoutubeVideoImport = {};

interface YoutubeVideoElement extends HTMLMediaElement {}

// See media-chrome.ts: both specifiers stay in bindings so Deno's graph
// builder cannot follow these browser-only imports into a network fetch.
//
// Both need jsDelivr's `/+esm` endpoint, as hls-player.ts and media-chrome.ts
// use. The bare package URL serves the package's own dist file, and that file
// imports its dependencies by bare specifier
// (`from "media-played-ranges-mixin"`), which a browser cannot resolve without
// an import map. The import then rejects, `<youtube-video>` never upgrades,
// and the player region paints black. `/+esm` rewrites those imports to
// absolute `/npm/…/+esm` URLs.
const MEDIA_CHROME_URL = "https://cdn.jsdelivr.net/npm/media-chrome@4/+esm";
const YOUTUBE_VIDEO_URL =
  "https://cdn.jsdelivr.net/npm/youtube-video-element@1/+esm";

const MEDIA_CHROME_IMPORT: Lazy<MediaChromeImport> = new Lazy(
  () => import(MEDIA_CHROME_URL),
);

interface BindProps {
  url: Option<string>;
  widthPx: number;
}

@component({
  name: "std-youtube-player",
})
export class YoutubePlayer extends LonaWebComponent {
  private static import: Lazy<YoutubeVideoImport> = new Lazy(
    () => import(YOUTUBE_VIDEO_URL),
  );

  private _$video: Option<YoutubeVideoElement>;
  private hydrated = false;
  private stateManager = new AsyncStateManager<YoutubePlayer, BindProps>();

  private get $video(): YoutubeVideoElement {
    return nonnull(this._$video);
  }

  private bindPromise: Option<Promise<void>>;
  private playPromise: Option<Promise<void>>;

  bind(url: Option<string>, widthPx: number): this {
    const props: BindProps = { url, widthPx };
    const stillValid = this.stateManager.bind(this, props);

    this.bindPromise = this.init().then(() => {
      if (!stillValid(props)) return;

      const aspectRatioInv = 9 / 16;
      if (url == null) {
        this.$video.style.display = "none";
        this.$video.src = "";
        this.$("media-controller").style.display = "none";
        return;
      }

      const normalizedUrl = YoutubeUrl.normalize(url);
      this.$video.src = normalizedUrl;
      this.$video.style.display = "block";
      this.$video.style.height = widthPx * aspectRatioInv + "px";
      this.$("media-controller").style.display = "block";
      this.$video.load();
    });

    return this;
  }

  async init(): Promise<this> {
    if (this.hydrated) return this;
    await Promise.all([MEDIA_CHROME_IMPORT.get(), YoutubePlayer.import.get()]);
    await new Promise<void>((resolve) => {
      $$.mutate(() => {
        this.hydrate("media-controller");
        this.hydrate("control-bar");
        this._$video = this.hydrate<YoutubeVideoElement>("video");
        this.hydrated = true;
        resolve();
      });
    });
    return this;
  }

  async play(): Promise<void> {
    if (this.playPromise) {
      return this.playPromise;
    }

    const bindPromiseAtStart = this.bindPromise;

    this.playPromise = (async () => {
      await this.init();

      if (bindPromiseAtStart) {
        await bindPromiseAtStart;
      }

      if (this.bindPromise !== bindPromiseAtStart) {
        await this.bindPromise;
      }

      this.$video.muted = false;
      await this.$video.play();
    })();

    return this.playPromise;
  }

  pause(): void {
    if (!this.hydrated || !this._$video) return;
    this.$video.pause();
  }

  static $styles: Style.Compat[] = [
    css`
      #control-bar {
        opacity: 0;
        transition: opacity 0.2s ease;
      }

      #control-bar:hover,
      #control-bar:focus-within {
        opacity: 1;
      }

      /* Ensure controls are visible when any part of the player has keyboard focus */
      #media-controller:focus-within #control-bar {
        opacity: 1;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <media-controller id="media-controller">
        <youtube-video
          id="video"
          crossorigin
          playsinline
          slot="media"
          muted
          preload="none"
        >
        </youtube-video>
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
