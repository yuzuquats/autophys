import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";

const LANDING_LCP_READY_EVENT = "lona:landing-lcp-ready";
const LANDING_LCP_READY_MARK = "lona:landing-lcp-ready";
const LANDING_LCP_READY_FALLBACK_MS = 3500;
const LANDING_LCP_READY_POLL_MS = 50;

function afterNextMutationFlush(): Promise<void> {
  return new Promise((resolve) => $$.mutate(() => resolve()));
}

function canObserveLcp(): boolean {
  return typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint");
}

@component({ name: "std-landing-browser-demo" })
export class LandingBrowserDemo extends LonaWebComponent {
  private $image: HTMLImageElement = this.$("image") as HTMLImageElement;
  private paintGeneration = 0;
  private lcpReadyGeneration: Option<number> = null;
  private lcpObserver: Option<PerformanceObserver> = null;
  private lcpFallbackTimer: Option<number> = null;
  private lcpPollTimer: Option<number> = null;

  static makeWith(props: LandingBrowserDemo.Props): LandingBrowserDemo {
    return (LandingBrowserDemo.make() as LandingBrowserDemo).bind(props);
  }

  bind(props: LandingBrowserDemo.Props): this {
    const generation = this.paintGeneration + 1;
    this.paintGeneration = generation;
    this.$image.alt = props.alt ?? "";
    // When the intrinsic size is known, reserve the box up-front (set the
    // width/height attributes + an explicit aspect-ratio) so the frame doesn't
    // reflow when the image finishes decoding — no layout shift. The image
    // still lays out at `width:100%`, so the frame stays fully responsive.
    if (props.width != null && props.height != null) {
      this.$image.width = props.width;
      this.$image.height = props.height;
      this.$image.style.aspectRatio = `${props.width} / ${props.height}`;
    }
    this.$image.decoding = "async";
    if (props.fetchPriority != null) {
      this.$image.setAttribute("fetchpriority", props.fetchPriority);
      if (props.fetchPriority === "high") {
        this.$image.loading = "eager";
      } else {
        this.$image.removeAttribute("loading");
      }
    } else {
      this.$image.removeAttribute("fetchpriority");
      this.$image.removeAttribute("loading");
    }
    this.$image.src = props.src;
    if (props.fetchPriority === "high") {
      this.notifyLandingLcpReady(generation);
    } else {
      this.cancelLandingLcpReady();
    }
    return this;
  }

  private notifyLandingLcpReady(generation: number): void {
    this.cancelLandingLcpReady();
    if (this.observeLandingLcp(generation)) {
      this.pollLandingLcpEntry(generation, performance.now());
    } else {
      this.notifyAfterImageReady(generation);
    }
  }

  private observeLandingLcp(generation: number): boolean {
    if (!canObserveLcp()) return false;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const lcp = entry as LargestContentfulPaint;
        if (!this.shouldUseLcpEntry(lcp)) continue;
        this.cancelLandingLcpReady();
        $$.mutate(() => this.markLandingLcpReady(generation));
        return;
      }
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
    this.lcpObserver = observer;
    this.lcpFallbackTimer = window.setTimeout(() => {
      this.cancelLandingLcpReady();
      this.notifyAfterImageReady(generation);
    }, LANDING_LCP_READY_FALLBACK_MS);
    return true;
  }

  private pollLandingLcpEntry(generation: number, startedAt: number): void {
    if (generation !== this.paintGeneration) return;
    if (this.lcpReadyGeneration === generation) return;

    if (this.hasLandingLcpEntry()) {
      this.cancelLandingLcpReady();
      $$.mutate(() => this.markLandingLcpReady(generation));
      return;
    }

    if (performance.now() - startedAt >= LANDING_LCP_READY_FALLBACK_MS) {
      this.cancelLandingLcpReady();
      this.notifyAfterImageReady(generation);
      return;
    }

    this.lcpPollTimer = window.setTimeout(() => {
      this.lcpPollTimer = null;
      this.pollLandingLcpEntry(generation, startedAt);
    }, LANDING_LCP_READY_POLL_MS);
  }

  private hasLandingLcpEntry(): boolean {
    const entries = performance.getEntriesByType(
      "largest-contentful-paint",
    ) as LargestContentfulPaint[];
    for (const entry of entries) {
      if (this.shouldUseLcpEntry(entry)) return true;
    }
    return false;
  }

  private shouldUseLcpEntry(entry: LargestContentfulPaint): boolean {
    return this.isLandingLcpEntry(entry);
  }

  private isLandingLcpEntry(entry: LargestContentfulPaint): boolean {
    if (entry.element === this.$image) return true;
    const currentSrc = this.$image.currentSrc;
    return (currentSrc.length > 0 && entry.url === currentSrc) ||
      entry.url === this.$image.src;
  }

  private notifyAfterImageReady(generation: number): void {
    const imageReady = this.$image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        const cleanup = () => {
          this.$image.removeEventListener("load", onDone);
          this.$image.removeEventListener("error", onDone);
        };
        const onDone = () => {
          cleanup();
          resolve();
        };
        this.$image.addEventListener("load", onDone, { once: true });
        this.$image.addEventListener("error", onDone, { once: true });
      });

    void imageReady
      .then(() => this.$image.decode().catch(() => {}))
      .then(afterNextMutationFlush)
      .then(afterNextMutationFlush)
      .then(() => this.markLandingLcpReady(generation));
  }

  private markLandingLcpReady(generation: number): void {
    if (generation !== this.paintGeneration) return;
    if (this.lcpReadyGeneration === generation) return;
    if (performance.getEntriesByName(LANDING_LCP_READY_MARK).length > 0) {
      this.lcpReadyGeneration = generation;
      this.cancelLandingLcpReady();
      return;
    }
    this.lcpReadyGeneration = generation;
    this.cancelLandingLcpReady();
    performance.mark(LANDING_LCP_READY_MARK);
    window.dispatchEvent(new Event(LANDING_LCP_READY_EVENT));
  }

  private cancelLandingLcpReady(): void {
    this.lcpObserver?.disconnect();
    this.lcpObserver = null;
    if (this.lcpFallbackTimer != null) {
      window.clearTimeout(this.lcpFallbackTimer);
      this.lcpFallbackTimer = null;
    }
    if (this.lcpPollTimer != null) {
      window.clearTimeout(this.lcpPollTimer);
      this.lcpPollTimer = null;
    }
  }

  disconnectedCallback(): void {
    this.cancelLandingLcpReady();
    super.disconnectedCallback();
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      /* Dark backdrop panel the browser window sits in. Padding (relative to
         width) gives the window an even inset on every screen size, so the whole
         demo scales fluidly instead of snapping at hardcoded breakpoints. */
      #demo-section {
        box-sizing: border-box;
        width: 100%;
        padding: 2.4%;
        border-radius: 20px;
        background-color: #2d3642;
      }

      /* The browser window. No fixed aspect-ratio — its height is driven by the
         image (#image is width:100% / height:auto), so ANY screenshot aspect
         (3:2, 4:3, …) renders uncropped and the frame stays responsive. */
      #demo-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        overflow: hidden;
        border-radius: 8px;
        background-color: light-dark(white, #262d39);
        box-shadow: 0px 4px 30px 8px rgba(19, 22, 27, 0.55);
      }

      #iframe-navbar {
        display: flex;
        flex-direction: row;
        align-items: center;
        flex-shrink: 0;
        width: 100%;
        box-sizing: border-box;
        height: 28px;
        padding-left: 8px;
        padding-right: 8px;
        background-color: light-dark(#e8eaed, #3c4043);
      }

      .navbar-button {
        width: 10px;
        height: 10px;
        margin-right: 4px;
        border-radius: 10px;
        background-color: #fe5f57;
      }

      .navbar-button:nth-child(2) {
        background-color: #fdbc30;
      }

      .navbar-button:nth-child(3) {
        background-color: #26c940;
      }

      /* Responsive: the image keeps its natural aspect ratio and the frame
         wraps it, so no letterboxing or cropping regardless of screenshot size. */
      #image {
        display: block;
        width: 100%;
        height: auto;
      }

      /* On narrow screens, tighten the backdrop inset + radius. */
      @media (max-width: 640px) {
        #demo-section {
          padding: 1.6%;
          border-radius: 14px;
        }
      }
    `,
  ];

  static $html = html`
    <div id="demo-section">
      <std-col id="demo-container">
        <div id="iframe-navbar">
          <div class="navbar-button"></div>
          <div class="navbar-button"></div>
          <div class="navbar-button"></div>
        </div>
        <img id="image">
      </std-col>
    </div>
  `;
}

export namespace LandingBrowserDemo {
  export type Props = {
    src: string;
    alt: Option<string>;
    /**
     * Intrinsic pixel size of the source image. When both are provided the
     * frame reserves the matching aspect-ratio box before the image loads, so
     * there's no layout shift. Pass `null` to fall back to natural sizing.
     */
    width: Option<number>;
    height: Option<number>;
    fetchPriority: Option<"high" | "low" | "auto">;
  };
}
