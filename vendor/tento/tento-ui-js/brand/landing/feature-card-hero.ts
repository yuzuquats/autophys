import { LiveData } from "@tento-core/livedata";
import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { AppThemeTokens } from "./app-theme-tokens";
import { FeatureCardReviewState } from "./feature-card-review-state";

@component({ name: "std-feature-card-hero" })
export class FeatureCardHero extends LonaWebComponent {
  private $stage: HTMLElement = this.$("stage");
  private $debug: Option<HTMLElement>;
  private renderedItems: FeatureCardHero.RenderedItem[] = [];
  private frameObserver: Option<ResizeObserver>;
  private debugInsets = false;
  private assetScale = 1;
  private tileFormat: FeatureCardHero.TileFormat = "desktop";
  private lastSize: Option<Size>;
  private settleGeneration = 0;
  private settling = false;
  private settleScheduled = false;
  private settleStartedAt = 0;

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    this.lastSize = size;
    this.layoutItems(size);
    if (this.settling) this.scheduleSettle();
  };

  static makeWith(props: FeatureCardHero.Props): FeatureCardHero {
    return (FeatureCardHero.make() as FeatureCardHero).bind(props);
  }

  bind(props: FeatureCardHero.Props): this {
    this.beginSettling();
    DomUtils.clearChildren(this.$stage);
    this.renderedItems = [];
    this.assetScale = props.assetScale ?? 1;
    this.tileFormat = props.tileFormat ?? "desktop";

    const visibleItems = props.items.slice(0, FeatureCardHero.MAX_VISIBLE_ITEMS);
    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      const $frame = document.createElement("div");
      $frame.className = "hero-item-frame hero-item-pending";
      $frame.dataset.layout = item.layout;
      $frame.dataset.itemId = item.id;
      // No fixed size — the frame shrink-wraps the asset's intrinsic size
      // (CSS width:max-content); layoutItems measures it and tiles.

      const $viewport = item.render();
      $viewport.classList.add("hero-viewport");
      $frame.appendChild($viewport);
      this.$stage.appendChild($frame);
      this.renderedItems.push({
        item,
        $frame,
        frame: null,
        intrinsic: null,
        settleIntrinsic: null,
        stableSettleSamples: 0,
      });
    }

    // Re-tile when an asset's intrinsic size settles (e.g. async-bound flight).
    this.observeRenderedFrames();

    if (this.lastSize) this.layoutItems(this.lastSize);
    this.scheduleSettle();
    return this;
  }

  private observeRenderedFrames(): void {
    this.frameObserver?.disconnect();
    this.frameObserver = new ResizeObserver(() => {
      if (this.lastSize) this.layoutItems(this.lastSize);
      if (this.settling) this.scheduleSettle();
    });
    for (const rendered of this.renderedItems) {
      this.frameObserver.observe(rendered.$frame);
    }
  }

  private beginSettling(): void {
    this.settleGeneration++;
    this.settling = true;
    this.settleScheduled = false;
    this.settleStartedAt = performance.now();
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.renderedItems.length > 0) {
      this.observeRenderedFrames();
      if (this.settling) this.scheduleSettle();
    }
    // The /gtm review toolbar drives the safe-area/placement debug overlay (and
    // the `hero-layout` resize traces). Immediate trigger so a hero mounted
    // while the overlay is already on adopts it; off everywhere else by default.
    FeatureCardReviewState.showInsets.addListener(
      this,
      (show) => {
        this.debugInsets = show;
        if (this.lastSize) this.layoutItems(this.lastSize);
      },
      LiveData.TriggerImmediately,
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    FeatureCardReviewState.showInsets.removeListener(this);
    this.frameObserver?.disconnect();
    this.frameObserver = null;
    this.settleGeneration++;
    this.settleScheduled = false;
  }

  onRecycle(): void {
    super.onRecycle();
    this.frameObserver?.disconnect();
    this.frameObserver = null;
    this.settleGeneration++;
    this.settling = false;
    this.settleScheduled = false;
    this.settleStartedAt = 0;
    this.lastSize = null;
    this.renderedItems = [];
    DomUtils.clearChildren(this.$stage);
    this.removeDebug();
  }

  private scheduleSettle(): void {
    if (!this.settling || this.settleScheduled) return;
    const generation = this.settleGeneration;
    this.settleScheduled = true;
    $$.measure(() => this.measureSettle(generation));
  }

  private measureSettle(generation: number): void {
    if (!this.isActiveSettleGeneration(generation)) return;

    const stageSize = this.lastSize;
    if (stageSize == null) {
      this.settleScheduled = false;
      return;
    }
    const intrinsicSizes = this.measureIntrinsicSizes();
    const stable = this.updateSettleProgress(intrinsicSizes);
    const timedOut =
      performance.now() - this.settleStartedAt >= FeatureCardHero.SETTLE_TIMEOUT_MS;

    $$.mutate(() => {
      if (!this.isActiveSettleGeneration(generation)) return;
      this.settleScheduled = false;

      if (stageSize) {
        this.applyMeasuredLayout(stageSize, intrinsicSizes);
      }

      if (stageSize && (stable || timedOut)) {
        this.revealSettledItems(stageSize, intrinsicSizes);
        return;
      }

      this.scheduleSettle();
    });
  }

  private isActiveSettleGeneration(generation: number): boolean {
    return this.settling && generation === this.settleGeneration;
  }

  private updateSettleProgress(intrinsicSizes: Size[]): boolean {
    if (intrinsicSizes.length === 0) return false;

    let allStable = true;
    for (let i = 0; i < this.renderedItems.length; i++) {
      const rendered = this.renderedItems[i];
      const intrinsic = intrinsicSizes[i];
      if (!rendered || !intrinsic) {
        allStable = false;
        continue;
      }

      const previous = rendered.settleIntrinsic;
      if (
        previous &&
        FeatureCardHero.sizeMatches(previous, intrinsic)
      ) {
        rendered.stableSettleSamples += 1;
      } else {
        rendered.settleIntrinsic = intrinsic;
        rendered.stableSettleSamples = 1;
      }

      if (
        rendered.stableSettleSamples <
          FeatureCardHero.REQUIRED_STABLE_SETTLE_SAMPLES
      ) {
        allStable = false;
      }
    }
    return allStable;
  }

  private revealSettledItems(size: Size, intrinsicSizes: Size[]): void {
    this.settling = false;
    for (const rendered of this.renderedItems) {
      rendered.$frame.classList.remove("hero-item-pending");
      rendered.$frame.classList.add("hero-item");
      rendered.settleIntrinsic = null;
      rendered.stableSettleSamples = 0;
    }
    this.applyMeasuredLayout(size, intrinsicSizes);
  }

  private measureIntrinsicSizes(): Size[] {
    const intrinsicSizes: Size[] = [];
    for (const rendered of this.renderedItems) {
      intrinsicSizes.push({
        width: Math.max(1, rendered.$frame.offsetWidth),
        height: Math.max(1, rendered.$frame.offsetHeight),
      });
    }
    return intrinsicSizes;
  }

  private layoutItems(size: Size): void {
    if (size.width <= 0 || size.height <= 0) return;
    const intrinsicSizes = this.measureIntrinsicSizes();
    this.applyMeasuredLayout(size, intrinsicSizes);
  }

  private applyMeasuredLayout(size: Size, intrinsicSizes: Size[]): void {
    this.lastSize = size;

    for (let i = 0; i < this.renderedItems.length; i++) {
      const rendered = this.renderedItems[i];
      const intrinsic = intrinsicSizes[i];
      if (!rendered || !intrinsic) continue;
      rendered.intrinsic = intrinsic;
      const { frame, trace } = FeatureCardHero.frameFor(
        rendered.item,
        intrinsic,
        i,
        this.renderedItems.length,
        size,
        this.assetScale,
        this.tileFormat,
      );
      rendered.frame = frame;
      rendered.$frame.style.left = `${frame.left}px`;
      rendered.$frame.style.top = `${frame.top}px`;
      rendered.$frame.style.transform = `scale(${frame.scale})`;
      rendered.$frame.style.zIndex = `${frame.zIndex}`;
      rendered.$frame.style.opacity = this.settling ? "0" : `${frame.opacity}`;

      // The `i` debug toggle walks the layout math into the ux-test log so a
      // resize sweep shows exactly which edge/size the bleed rule resolved.
      if (this.debugInsets) Tracing.log("hero-layout", trace);
    }

    this.renderDebug(size);
  }

  private renderDebug(size: Size): void {
    this.toggleAttribute("debug-insets", this.debugInsets);
    if (!this.debugInsets) {
      this.removeDebug();
      return;
    }

    const $debug = this.ensureDebug();
    DomUtils.clearChildren($debug);

    const safe = FeatureCardHero.safeAreaFor(size);

    const $safe = document.createElement("div");
    $safe.className = "debug-safe";
    $safe.style.left = `${safe.left}px`;
    $safe.style.top = `${safe.top}px`;
    $safe.style.width = `${safe.width}px`;
    $safe.style.height = `${safe.height}px`;
    $debug.appendChild($safe);

    const $label = document.createElement("div");
    $label.className = "debug-label";
    $label.textContent = `inset ${Math.round(safe.left)}px`;
    $debug.appendChild($label);

    for (const r of this.renderedItems) {
      if (!r.frame || !r.intrinsic) continue;
      const $box = document.createElement("div");
      $box.className = "debug-box";
      $box.style.left = `${r.frame.left}px`;
      $box.style.top = `${r.frame.top}px`;
      $box.style.width = `${r.intrinsic.width * r.frame.scale}px`;
      $box.style.height = `${r.intrinsic.height * r.frame.scale}px`;
      $debug.appendChild($box);
    }
  }

  private ensureDebug(): HTMLElement {
    if (this.$debug != null) return this.$debug;
    const $debug = document.createElement("div");
    $debug.id = "debug";
    this.shadowRoot?.appendChild($debug);
    this.$debug = $debug;
    return $debug;
  }

  private removeDebug(): void {
    this.$debug?.remove();
    this.$debug = null;
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 100%;
        overflow: hidden;
        --feature-card-hero-bg: color-mix(
          in srgb,
          var(--bg) 88%,
          var(--text-pri) 12%
        );
        /* A soft background that complements the gradient splat behind the hero. Defaults to none;
           the consumer sets the soft-bg var (e.g. to a palette softBackground). Both the color and
           the (deliberately low) opacity are TUNEABLE. */
        --feature-card-hero-soft-bg: none;
        --feature-card-hero-soft-bg-opacity: 0.12;
        background: var(--feature-card-hero-bg);
      }

      /* Soft complementing tint over the wash, behind the asset. */
      :host::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background: var(--feature-card-hero-soft-bg);
        opacity: var(--feature-card-hero-soft-bg-opacity);
      }

      #stage {
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: hidden;
        /* Render the asset objects in the native app LIGHT theme: force the
           inherited global app design-system light-dark() tokens to resolve
           LIGHT. The card/section chrome around the hero keeps the page theme. */
        color-scheme: light;
      }

      .hero-item-frame {
        position: absolute;
        box-sizing: border-box;
        width: max-content;
        transform-origin: top left;
        filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.12));
        will-change: transform;
      }

      .hero-item-pending {
        opacity: 0;
        pointer-events: none;
      }

      .hero-viewport {
        display: block;
        box-sizing: border-box;
      }

      .hero-item-frame[data-layout="peek-secondary"] {
        filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.14));
      }

      #debug {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 10;
      }

      :host(:not([debug-insets])) #debug {
        display: none;
      }

      .debug-safe {
        position: absolute;
        box-sizing: border-box;
        border: 1px dashed color-mix(in srgb, magenta 75%, transparent);
      }

      .debug-box {
        position: absolute;
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, #00d0ff 85%, transparent);
      }

      .debug-label {
        position: absolute;
        top: 2px;
        left: 2px;
        font: 10px/1.2 ui-monospace, monospace;
        color: magenta;
        background: rgba(255, 255, 255, 0.75);
        padding: 1px 4px;
        border-radius: 3px;
      }
    `,
    // Re-establish the app palette on the asset stage (see AppThemeTokens) so a
    // brand surface (the landing's loaf DS) doesn't recolour the live preview.
    AppThemeTokens.stage,
  ];

  static $html = html`<div id="stage"></div>`;
}

export namespace FeatureCardHero {
  export const MAX_VISIBLE_ITEMS = 2;
  export const SETTLE_TIMEOUT_MS = 450;
  export const REQUIRED_STABLE_SETTLE_SAMPLES = 2;
  export const MIN_HEIGHT = 200;
  const SETTLE_SIZE_EPS = 0.5;
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 0.92;
  // Tiling: cap how far a small asset may be upscaled to fill a slot.
  const MAX_TILE_SCALE = 4;
  // Fixed safe-area inset (px), clamped for tiny slots.
  const TILE_INSET = 24;
  // Sub-pixel grace so an edge sitting exactly on the inset boundary (a
  // width-fill asset whose sides land on the safe edge) counts as clean instead
  // of float jitter flipping it into the forbidden band → spurious fallback.
  const EDGE_EPS = 0.5;
  const PEEK_COVER_PADDING = 24;
  // bottom-peek: a portrait card sized so a target FRACTION of it SHOWS inside
  // the slot (BOTTOM_PEEK_SHOWN); the remainder bleeds off the bottom. It is
  // pinned a gap (the inset) below the top so the header reads, centered with
  // clear side margins. Width is capped to the safe area so the sides never clip.
  // Sizing by amount-shown (not a fixed width) keeps a consistent "peek" across
  // slot heights — for a portrait card in a short landscape slot, width and
  // amount-shown trade off directly (see the ux-test learning), and the user
  // wants amount-shown held steady.
  const BOTTOM_PEEK_SHOWN = 0.65;
  // scaled-bottom: the asset is scaled so its WIDTH is this fraction of the slot
  // (centered → clear side margins), pinned a gap below the top, and — being a
  // portrait — runs off the BOTTOM (flush/bleed). A bottom-anchored presence that
  // scales with the slot. Capped at the safe width so the sides never go flush;
  // tune within ~0.55-0.8 (bigger = wider).
  const SCALED_BOTTOM_WIDTH = 0.6;
  // How far past the bottom edge scaled-bottom commits its bleed, as a fraction of
  // the slot height (drives the sizeY target = 1 + bleed - topGap).
  const SCALED_BOTTOM_BLEED = 0.12;
  // Top gap for scaled-bottom as a fraction of the slot height (scales with the
  // slot, floored at the inset). Bigger = more space above the asset (and, since
  // the asset is pinned lower, a bit more bleeds off the bottom).
  const SCALED_BOTTOM_TOP = 0.16;
  const TOP_CENTER_INSET_TOP = 0.16;
  const INSET_BLEED_SIZE = 1.18;
  const INSET_BLEED_LEFT = 0.1;
  const INSET_BLEED_TOP = 0.12;
  const ADAPTIVE_CENTER_HEIGHT_RATIO = 0.98;
  const MIN_LAYOUT_SIZE = 1;

  export type HeroKind = `hero/${string}`;

  export type TileFormat = "mobile" | "tablet" | "desktop";

  export type HeroRef = {
    kind: HeroKind;
  };

  export type Layout =
    | "contain-center"
    | "readable-start"
    | "cover-center"
    | "peek-secondary";

  // How an asset is tiled into a hero slot to maximize space.
  //  - "top-center":  fill the slot width, pin top-center, bleed off the bottom.
  //  - "top-center-inset": fill the slot width with a larger top gap.
  //  - "top-left":    cover the slot, pin top-left, bleed off right + bottom.
  //  - "top-right":   cover the slot, pin top-right, bleed off left + bottom.
  //  - "cover-center": cover the slot and center the asset, allowing symmetric
  //    bleed instead of pinning to one edge.
  //  - "center":      contain within the safe area, centered (the geometric
  //    result when an asset already fills the safe area).
  //  - "adaptive-center-bottom-right": center while the asset has enough height;
  //    when the slot is too short, keep the top-left safe inset visible and
  //    commit bottom/right bleed.
  //  - "bottom-peek": a portrait card kept at a comfortable size, centered with
  //    clear side margins and anchored LOW so its bottom is clipped past the slot
  //    edge — it peeks up from below. A deliberate bleed (exempt from the
  //    contain-fallback; clean by construction).
  //  - "scaled-bottom": scale a portrait asset so its WIDTH is a fraction
  //    (SCALED_BOTTOM_WIDTH) of the slot, centered (clear side margins), pinned a
  //    gap below the top, and bled off the BOTTOM. A larger, bottom-anchored
  //    presence that scales with the slot (deliberate bleed; clean by construction).
  //  - "inset-bottom-right-bleed": pin the asset down/right from an enlarged
  //    top-left inset and deliberately bleed the bottom and right edges.
  export type TileAnchor =
    | "top-center"
    | "top-center-inset"
    | "top-left"
    | "top-right"
    | "cover-center"
    | "center"
    | "adaptive-center-bottom-right"
    | "bottom-peek"
    | "scaled-bottom"
    | "inset-bottom-right-bleed";

  export type TileProfile =
    | TileAnchor
    | {
      mobile: TileAnchor;
      tablet: TileAnchor;
      desktop: TileAnchor;
    };

  // A tiling strategy expressed as data: CSS object-fit (a per-axis size target +
  // a min/max reduce) + object-position (a 0..1 anchor per axis), over the
  // safe-inset box, with bleed allowed. `resolveTile` turns this into a Frame; the
  // per-anchor declarations live in TILE_STRATEGIES. (bottom-peek + the multi-item
  // peek-secondary keep bespoke math — their specials don't reduce to these two
  // identities.)
  export type Tiling = {
    // Target extent per axis as a fraction of `ref`; omit an axis to drop its term.
    sizeX?: number;
    sizeY?: number;
    // How competing per-axis size targets collapse to one scale:
    // min = fit / cap (contain), max = cover / bleed-wins.
    reduce: "min" | "max";
    // Reference box the size fractions are relative to.
    ref: "safe" | "stage";
    // object-position: 0 = start edge, 0.5 = center, 1 = end edge. The same value
    // distributes any overflow (0 bleeds the far edge, 0.5 symmetric, 1 the near).
    anchorX: number;
    anchorY: number;
    // Raise the top inset to topGap * stage.height before anchoring (default inset).
    topGap?: number;
    // Raise the left inset to leftGap * stage.width before anchoring (default inset).
    leftGap?: number;
    // Enforce the clean-edge rule; fall back to containCentered on a flush sliver.
    // (Deliberate-bleed strategies omit this.)
    clean?: boolean;
    // cover-center only: nudge the scale up so a near-flush cover overflow commits a
    // real bleed instead of a sliver.
    antiFlush?: boolean;
    // X overflow goes entirely to the END edge: centered while it fits, but once it
    // overflows the width it pins the left edge at the inset and bleeds only the
    // RIGHT (instead of anchorX's symmetric split). Used by scaled-bottom.
    clampStartX?: boolean;
  };

  export type Item = {
    id: string;
    nativeSize: Size;
    layout: Layout;
    tile: TileProfile;
    render: () => HTMLElement;
  };

  export type Props = {
    items: Item[];
    assetScale?: Option<number>;
    tileFormat?: Option<TileFormat>;
  };

  export type Plugin = {
    kind: HeroKind;
    makeHero: () => Props;
  };

  export type Registry = {
    resolveHero: (ref: HeroRef) => Option<Props>;
  };

  export type RenderedItem = {
    item: Item;
    $frame: HTMLElement;
    frame: Option<Frame>;
    intrinsic: Option<Size>;
    settleIntrinsic: Option<Size>;
    stableSettleSamples: number;
  };

  export type Frame = {
    left: number;
    top: number;
    scale: number;
    zIndex: number;
    opacity: number;
  };

  // frameFor returns the chosen frame plus a diagnostic trace of the math.
  export type Placement = {
    frame: Frame;
    trace: LayoutTrace;
  };

  export type LayoutTrace = {
    itemId: string;
    anchor: string;
    stage: { w: number; h: number };
    safe: { w: number; h: number; inset: number };
    intrinsic: { w: number; h: number };
    scale: number;
    overhang: { left: number; right: number; top: number; bottom: number };
    clean: boolean;
    chosen: "anchor" | "contain-fallback";
  };

  type Rect = {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  type Overhangs = {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };

  export function registry(plugins: Plugin[]): Registry {
    const pluginsByKind = new Map<HeroKind, Plugin>();
    for (const plugin of plugins) {
      pluginsByKind.set(plugin.kind, plugin);
    }

    return {
      resolveHero(ref: HeroRef): Option<Props> {
        const plugin = pluginsByKind.get(ref.kind);
        if (!plugin) return null;
        return plugin.makeHero();
      },
    };
  }

  export function heroRefFromKind(kind: string): Option<HeroRef> {
    if (!kind.startsWith("hero/")) return null;
    return { kind: kind as HeroKind };
  }

  export function sizeMatches(a: Size, b: Size): boolean {
    return Math.abs(a.width - b.width) <= SETTLE_SIZE_EPS &&
      Math.abs(a.height - b.height) <= SETTLE_SIZE_EPS;
  }

  export function safeAreaFor(stage: Size): Rect {
    const inset = Math.min(TILE_INSET, Math.min(stage.width, stage.height) / 5);
    return {
      left: inset,
      top: inset,
      width: Math.max(MIN_LAYOUT_SIZE, stage.width - inset * 2),
      height: Math.max(MIN_LAYOUT_SIZE, stage.height - inset * 2),
    };
  }

  export function frameFor(
    item: Item,
    intrinsic: Size,
    index: number,
    count: number,
    stage: Size,
    assetScale: number,
    tileFormat: TileFormat,
  ): Placement {
    const safe = safeAreaFor(stage);
    const tile = tileForFormat(item.tile, tileFormat);

    // Multi-item overlap: the secondary card keeps its bespoke overlap placement.
    if (item.layout === "peek-secondary" || (count > 1 && index > 0)) {
      const frame = peekSecondaryFrame(intrinsic, stage, safe, assetScale);
      return {
        frame,
        trace: layoutTrace(item.id, "peek-secondary", stage, safe, intrinsic, frame, "anchor"),
      };
    }

    // bottom-peek keeps its bespoke math: show-height sizing + a bottom bleed of
    // `gap` + the top clamp don't reduce to the constraint identities, and it backs
    // the habit card, so it's preserved exactly rather than approximated.
    if (tile === "bottom-peek") {
      const frame = bottomPeek(intrinsic, stage, safe, assetScale);
      return {
        frame,
        trace: layoutTrace(item.id, "bottom-peek", stage, safe, intrinsic, frame, "anchor"),
      };
    }

    if (tile === "adaptive-center-bottom-right") {
      const { frame, chosen } = adaptiveCenterBottomRight(
        intrinsic,
        stage,
        safe,
        assetScale,
      );
      return {
        frame,
        trace: layoutTrace(item.id, tile, stage, safe, intrinsic, frame, chosen),
      };
    }

    // Everything else resolves from its declarative Tiling (object-fit + object-
    // position over the safe-inset box).
    const tiling = TILE_STRATEGIES[tile] ?? TILE_STRATEGIES.center!;
    const { frame, chosen } = resolveTileWithAssetScale(
      tiling,
      intrinsic,
      stage,
      safe,
      assetScale,
    );
    return {
      frame,
      trace: layoutTrace(item.id, tile, stage, safe, intrinsic, frame, chosen),
    };
  }

  export function tileForFormat(
    profile: TileProfile,
    format: TileFormat,
  ): TileAnchor {
    if (typeof profile === "string") return profile;
    return profile[format];
  }

  // Each single-item tile anchor as data. bottom-peek (bespoke) + peek-secondary
  // (multi-item) are handled in frameFor and intentionally absent here.
  const TILE_STRATEGIES: { [K in TileAnchor]?: Tiling } = {
    center: { sizeX: 1, sizeY: 1, reduce: "min", ref: "safe", anchorX: 0.5, anchorY: 0.5, clean: true },
    "top-center": { sizeX: 1, reduce: "min", ref: "safe", anchorX: 0.5, anchorY: 0, clean: true },
    "top-center-inset": {
      sizeX: 1,
      reduce: "min",
      ref: "safe",
      anchorX: 0.5,
      anchorY: 0,
      topGap: TOP_CENTER_INSET_TOP,
      clean: true,
    },
    "top-left": { sizeX: 1, sizeY: 1, reduce: "max", ref: "stage", anchorX: 0, anchorY: 0, clean: true },
    "top-right": { sizeX: 1, sizeY: 1, reduce: "max", ref: "stage", anchorX: 1, anchorY: 0, clean: true },
    "cover-center": { sizeX: 1, sizeY: 1, reduce: "max", ref: "safe", anchorX: 0.5, anchorY: 0.5, antiFlush: true },
    "scaled-bottom": {
      sizeX: SCALED_BOTTOM_WIDTH,
      // sizeY forces the height to fill + bleed: when it wins (a too-short asset),
      // the bottom lands SCALED_BOTTOM_BLEED of the slot past the edge. = 1 + bleed
      // - topGap, so bottom = gap + sizeY*stage.h = (1 + bleed) * stage.h.
      sizeY: 1 + SCALED_BOTTOM_BLEED - SCALED_BOTTOM_TOP,
      reduce: "max",
      ref: "stage",
      anchorX: 0.5,
      anchorY: 0,
      topGap: SCALED_BOTTOM_TOP,
      clampStartX: true,
    },
    "inset-bottom-right-bleed": {
      sizeX: INSET_BLEED_SIZE,
      sizeY: INSET_BLEED_SIZE,
      reduce: "max",
      ref: "stage",
      anchorX: 0,
      anchorY: 0,
      leftGap: INSET_BLEED_LEFT,
      topGap: INSET_BLEED_TOP,
    },
  };

  // Resolve a Tiling into a Frame: pick a scale from the per-axis size targets
  // (object-fit), then place it with the per-axis anchors (object-position) over
  // the safe-inset box (top edge lowered by topGap). `clean` strategies fall back
  // to containCentered if an edge lands in the forbidden flush band.
  export function resolveTile(
    t: Tiling,
    native: Size,
    stage: Size,
    safe: Rect,
  ): { frame: Frame; chosen: "anchor" | "contain-fallback" } {
    return resolveTileWithAssetScale(t, native, stage, safe, 1);
  }

  function resolveTileWithAssetScale(
    t: Tiling,
    native: Size,
    stage: Size,
    safe: Rect,
    assetScale: number,
  ): { frame: Frame; chosen: "anchor" | "contain-fallback" } {
    const inset = safe.left;
    const leftGap = t.leftGap != null
      ? Math.max(inset, t.leftGap * stage.width)
      : safe.left;
    const gap = t.topGap != null
      ? Math.max(inset, t.topGap * stage.height)
      : safe.top;
    const boxLeft = leftGap;
    const boxWidth = Math.max(
      MIN_LAYOUT_SIZE,
      safe.left + safe.width - boxLeft,
    );
    const boxTop = gap;
    const boxHeight = Math.max(MIN_LAYOUT_SIZE, safe.top + safe.height - gap);
    const refW = t.ref === "stage" ? stage.width : safe.width;
    const refH = t.ref === "stage" ? stage.height : safe.height;

    const candidates: number[] = [];
    if (t.sizeX != null) candidates.push((t.sizeX * refW) / native.width);
    if (t.sizeY != null) candidates.push((t.sizeY * refH) / native.height);
    let scale = t.reduce === "max" ? Math.max(...candidates) : Math.min(...candidates);

    if (t.antiFlush) {
      const iw = native.width * scale;
      const ih = native.height * scale;
      if (iw > safe.width + EDGE_EPS && (iw - stage.width) / 2 < inset) {
        scale = Math.max(scale, (stage.width + inset * 2) / native.width);
      }
      if (ih > safe.height + EDGE_EPS && (ih - stage.height) / 2 < inset) {
        scale = Math.max(scale, (stage.height + inset * 2) / native.height);
      }
    }
    scale = clampedTileScale(scale * assetScale);

    const scaledWidth = native.width * scale;
    const scaledHeight = native.height * scale;
    // clampStartX: clamp the available x-space to >= 0 so overflow goes entirely to
    // the END edge (pin left at the inset, bleed only the right) instead of the
    // anchor's symmetric split.
    const availWidth = t.clampStartX
      ? Math.max(0, boxWidth - scaledWidth)
      : boxWidth - scaledWidth;
    const frame: Frame = {
      left: boxLeft + t.anchorX * availWidth,
      top: boxTop + t.anchorY * (boxHeight - scaledHeight),
      scale,
      zIndex: 1,
      opacity: 1,
    };
    if (t.clean && !allEdgesClean(edgeOverhangs(frame, native, stage), inset)) {
      return {
        frame: containCentered(native, safe, assetScale),
        chosen: "contain-fallback",
      };
    }
    return { frame, chosen: "anchor" };
  }

  // Signed distance each asset edge sits PAST its stage edge (negative = inside).
  function edgeOverhangs(frame: Frame, native: Size, stage: Size): Overhangs {
    const scaledWidth = native.width * frame.scale;
    const scaledHeight = native.height * frame.scale;
    return {
      left: -frame.left,
      right: frame.left + scaledWidth - stage.width,
      top: -frame.top,
      bottom: frame.top + scaledHeight - stage.height,
    };
  }

  // An edge is clean when it respects the inset (>= i inside the frame) or
  // commits a real bleed (>= i past the edge). The forbidden band is (-i, i):
  // an edge within `i` of the frame boundary on either side reads as a flush
  // sliver — the flush-bottom bug.
  function edgeClean(overhang: number, inset: number): boolean {
    return overhang <= -inset + EDGE_EPS || overhang >= inset - EDGE_EPS;
  }

  function allEdgesClean(o: Overhangs, inset: number): boolean {
    return (
      edgeClean(o.left, inset) &&
      edgeClean(o.right, inset) &&
      edgeClean(o.top, inset) &&
      edgeClean(o.bottom, inset)
    );
  }

  function layoutTrace(
    itemId: string,
    anchor: string,
    stage: Size,
    safe: Rect,
    intrinsic: Size,
    frame: Frame,
    chosen: "anchor" | "contain-fallback",
  ): LayoutTrace {
    const inset = safe.left;
    const o = edgeOverhangs(frame, intrinsic, stage);
    return {
      itemId,
      anchor,
      stage: { w: round(stage.width), h: round(stage.height) },
      safe: { w: round(safe.width), h: round(safe.height), inset: round(inset) },
      intrinsic: { w: round(intrinsic.width), h: round(intrinsic.height) },
      scale: round2(frame.scale),
      overhang: {
        left: round(o.left),
        right: round(o.right),
        top: round(o.top),
        bottom: round(o.bottom),
      },
      clean: allEdgesClean(o, inset),
      chosen,
    };
  }

  function round(n: number): number {
    return Math.round(n);
  }

  function round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  function containCentered(
    native: Size,
    safe: Rect,
    assetScale: number,
  ): Frame {
    const scale = clampedTileScale(
      Math.min(safe.width / native.width, safe.height / native.height) *
        assetScale,
    );
    const scaledWidth = native.width * scale;
    const scaledHeight = native.height * scale;
    return {
      left: safe.left + (safe.width - scaledWidth) / 2,
      top: safe.top + (safe.height - scaledHeight) / 2,
      scale,
      zIndex: 1,
      opacity: 1,
    };
  }

  function clampedTileScale(scale: number): number {
    return Math.min(MAX_TILE_SCALE, Math.max(MIN_SCALE, scale));
  }

  function adaptiveCenterBottomRight(
    native: Size,
    stage: Size,
    safe: Rect,
    assetScale: number,
  ): { frame: Frame; chosen: "anchor" | "contain-fallback" } {
    const widthScale = safe.width / native.width;
    const heightScale = safe.height / native.height;
    if (heightScale >= widthScale * ADAPTIVE_CENTER_HEIGHT_RATIO) {
      return {
        frame: containCentered(native, safe, assetScale),
        chosen: "anchor",
      };
    }

    const scale = clampedTileScale(
      Math.max(stage.width / native.width, stage.height / native.height) *
        assetScale,
    );
    const frame: Frame = {
      left: safe.left,
      top: safe.top,
      scale,
      zIndex: 1,
      opacity: 1,
    };
    if (!allEdgesClean(edgeOverhangs(frame, native, stage), safe.left)) {
      return {
        frame: containCentered(native, safe, assetScale),
        chosen: "contain-fallback",
      };
    }
    return { frame, chosen: "anchor" };
  }

  // A portrait card kept at a comfortable size, centered horizontally with clear
  // side margins, anchored LOW so its bottom bleeds off the slot edge (peeks up
  // from below). The height fraction caps a tall card so it stays a peek; the
  // bottom bleed is >= inset so the bottom edge is a clean committed bleed.
  function bottomPeek(
    native: Size,
    stage: Size,
    safe: Rect,
    assetScale: number,
  ): Frame {
    const gap = safe.top;
    // Size so BOTTOM_PEEK_SHOWN of the card fills the visible height
    // (stage.height - gap); the rest bleeds off the bottom. Cap the width to the
    // safe area so the sides stay clean on a near-square slot.
    const showScale = (stage.height - gap) / (BOTTOM_PEEK_SHOWN * native.height);
    const scale = clampedTileScale(
      Math.min(showScale, safe.width / native.width) * assetScale,
    );
    const scaledWidth = native.width * scale;
    const scaledHeight = native.height * scale;
    // Pin the top a gap below the slot top (header visible, bottom bleeds). If the
    // card is short enough to fit, anchor it LOW so its bottom still bleeds by the
    // inset — a clean committed bleed either way.
    const top = Math.max(gap, stage.height + gap - scaledHeight);
    return {
      left: (stage.width - scaledWidth) / 2,
      top,
      scale,
      zIndex: 1,
      opacity: 1,
    };
  }

  function peekSecondaryFrame(
    native: Size,
    stage: Size,
    safe: Rect,
    assetScale: number,
  ): Frame {
    const targetWidth = safe.width * 0.58;
    const targetHeight = safe.height * 0.66;
    const scale =
      Math.min(targetWidth / native.width, targetHeight / native.height) *
      assetScale;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const scaledWidth = native.width * clamped;
    const scaledHeight = native.height * clamped;
    return {
      left: Math.max(
        safe.left + safe.width * 0.46,
        stage.width - scaledWidth * 0.78,
      ),
      top: Math.max(
        safe.top,
        stage.height + PEEK_COVER_PADDING - scaledHeight,
      ),
      scale: clamped,
      zIndex: 2,
      opacity: 0.94,
    };
  }
}
