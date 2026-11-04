import { Tracing } from "@tento-core/tracing";

// Drives a paged feed off a sentinel element: pulls one page when the sentinel
// scrolls into the prefetch band, and keeps pulling while the loaded content is
// still too short to reach it. Owns the page cursor, the in-flight guard, and
// the "is there more" flag — the three pieces of state a hand-rolled feed
// invariably gets subtly wrong.
//
// It owns NO DOM: the consumer appends rows in `loadPage` and reports the new
// content height by calling `contentChanged()`. That split matters for a
// masonry, where height is only real AFTER the layout pass — measuring straight
// after an append reads a zero-height container, concludes the viewport is not
// filled, and pulls the entire library in one burst.
export class InfiniteFeed {
  private readonly config: InfiniteFeed.Config;
  private nextPage: number;
  private loading = false;
  private more = true;

  private readonly sentinelObserver: IntersectionObserver;

  constructor(config: InfiniteFeed.Config) {
    this.config = config;
    this.nextPage = config.firstPage;
    this.sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void this.pump();
      },
      { rootMargin: `${config.prefetchMarginPx}px 0px` },
    );
    this.sentinelObserver.observe(config.$sentinel);
  }

  get isLoading(): boolean {
    return this.loading;
  }

  get hasMore(): boolean {
    return this.more;
  }

  // Back to page one. The consumer clears its own rows first; this only resets
  // the cursor and kicks the first load.
  restart(): void {
    this.nextPage = this.config.firstPage;
    this.more = true;
    void this.pump();
  }

  // Call after the feed's rendered height may have changed (a layout pass, an
  // image settling, a row expanding). Pulls another page only if the sentinel
  // is still inside the prefetch band.
  contentChanged(): void {
    if (this.loading || !this.more) return;
    const sentinelTop = this.config.$sentinel.getBoundingClientRect().top;
    const withinBand =
      sentinelTop <= window.innerHeight + this.config.prefetchMarginPx;
    Tracing.log(`${this.config.label}/fill`, {
      page: this.nextPage,
      sentinelTop: Math.round(sentinelTop),
      innerHeight: window.innerHeight,
      withinBand,
    });
    if (withinBand) void this.pump();
  }

  // Stops watching. The feed is inert afterwards — build a new one to restart.
  disconnect(): void {
    this.sentinelObserver.disconnect();
    this.more = false;
  }

  // Exactly one page per call: `contentChanged` and the sentinel decide when to
  // call again. A load that throws ends the feed rather than retrying into a
  // loop against a server that is already failing.
  private async pump(): Promise<void> {
    if (this.loading || !this.more) return;
    this.loading = true;
    const page = this.nextPage;
    try {
      this.more = await this.config.loadPage(page);
      this.nextPage = page + 1;
    } catch (error) {
      Tracing.err("ui")(`${this.config.label}/load`, error);
      this.more = false;
      this.config.onError(error);
    } finally {
      this.loading = false;
    }
  }
}

export namespace InfiniteFeed {
  export interface Config {
    // Watched for the prefetch band; sits directly below the feed's content.
    $sentinel: HTMLElement;
    // Distance below the viewport at which the next page is pulled.
    prefetchMarginPx: number;
    // Page number the feed starts at (APIs differ on 0- vs 1-based).
    firstPage: number;
    // Loads and renders one page. Resolves `true` when more pages remain.
    loadPage: (page: number) => Promise<boolean>;
    onError: (error: unknown) => void;
    // Tracing prefix, e.g. "market-research" → "market-research/fill".
    label: string;
  }
}
