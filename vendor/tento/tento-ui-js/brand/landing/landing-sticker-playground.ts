import { Tracing } from "@tento-core/tracing";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DragDrop } from "../../drag-drop";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { SimpleKeyframe } from "../../keyframe";
import { IconButton } from "../../components/icon-button";
import { MiniWindow } from "../../components/mini-window";
import { ModalCloseButton } from "../../components/modal-close-button/modal-close-button";
import { StickerArtCatalog } from "../../components/sticker/sticker-art-catalog";
import { StickerCutoutPreview } from "../../components/sticker/sticker-cutout-preview";
import { StickerDrag } from "../../components/sticker/sticker-drag";
import { StickerDragChip } from "../../components/sticker/sticker-drag-chip";
import type { StickerEffect } from "../../components/sticker/sticker-effect";
import type { StickerMaterialVariant } from "../../components/sticker/sticker-material-variant";
import { StickerSheet } from "../../components/sticker/sticker-sheet";
import { LonaIcons, XIcon } from "../../ui/icons";
import { CuratedWashes } from "./curated-washes";
import { GradientSplat } from "./gradient-splat";

type LandingStickerVisual = {
  stickerId: string;
  effect: StickerEffect.Id;
  effectVariant: Option<StickerMaterialVariant.Id>;
};

type PlacedSticker = LandingStickerVisual & {
  id: string;
  $el: StickerCutoutPreview;
  x: number;
  y: number;
  z: number;
  chip: Option<StickerDragChip>;
};

type PreviewSticker = {
  key: string;
  $el: StickerCutoutPreview;
};

type RootPositionPatch = {
  $root: HTMLElement;
  inlinePosition: string;
};

type DockFrame = {
  left: number;
  top: number;
  scale: number;
};

type DockSettleMeasurement = {
  frame: Option<DockFrame>;
  key: string;
  tileCount: number;
  previewReadyCount: number;
};

namespace LandingStickerMoveDrag {
  export type Payload = { id: string };
  export const KIND = new DragDrop.Kind<Payload>("landing-sticker-move");
}

const STICKER_WINDOW_ESCAPE_ID = "landing-sticker-window";
// The docked sheet renders at this fixed native width; with the pinned tile size
// below it lays out ~4 columns → a portrait-ish, tall sheet. layoutDockedSheet
// then scales it (height-anchored) into the slot so it bleeds off the bottom.
const STICKER_NATIVE_WIDTH = 400;
// Pinned tile size (px) for the docked sheet — gives deterministic 4-col geometry
// and bigger tiles than the asset-driven default.
const STICKER_DOCK_TILE_SIZE = 84;
// The docked sheet is clipped in the bento card, so render only the visible
// preview rows after LCP; the popped sheet binds without this limit.
const STICKER_DOCK_PREVIEW_LIMIT = 16;
// Docked bento layout: the sheet keeps its fixed native width and the whole card
// is uniformly scaled as one object. Prefer an anchored top-left frame that
// deliberately bleeds off the bottom/right of the asset container; if the slot is
// too small to maintain that inset and bleed, bias to the far edge on that axis
// instead. Cap the upscale so a wide media slot does not turn the sticker sheet
// into the dominant card.
const STICKER_DOCK_INSET = 36;
const STICKER_DOCK_BLEED_FRACTION = 0.08;
const STICKER_DOCK_MAX_SCALE = 1;
// Tile size (px) for the popped one-row bar. Must be >= the sticker preview's
// display size (~72px) so the preview sits inside the tile with margin — otherwise
// the bar's overflow-x scroller (which forces overflow-y to clip) cuts the
// overhang. 84 matches the docked card's proven tile size.
const STICKER_BAR_TILE_SIZE = 84;
// Desktop popped window: pin the tile geometry so async cutout sizing cannot
// resize the card after the reveal animation starts.
const STICKER_WINDOW_TILE_SIZE = 91;
// On a narrower page the popped bar shrinks ONLY THE STICKERS — each sticker is
// re-rendered at a smaller display size (StickerSheet `displayScale`) and the tile
// pin tracks it (84 × scale, keeping the margin) — so the bar, which wraps the
// stickers, gets shorter while still bleeding full-width edge to edge. No CSS
// transform (that would scale the bar's width too, not bleed). Full size at >=
// _FULL_WIDTH, down to _MIN_SCALE at <= _MIN_WIDTH (the bar only shows on mobile,
// <= 768). The scale is quantized so a resize re-renders at discrete steps, not
// every pixel.
const STICKER_BAR_FULL_WIDTH = 768;
const STICKER_BAR_MIN_WIDTH = 360;
const STICKER_BAR_MIN_SCALE = 0.6;
const LANDING_LCP_READY_EVENT = "lona:landing-lcp-ready";
const LANDING_LCP_READY_MARK = "lona:landing-lcp-ready";
const STICKER_POST_LCP_FALLBACK_MS = 2800;
const STICKER_DOCK_SETTLE_FRAMES = 2;
const STICKER_DOCK_MAX_SETTLE_FRAMES = 180;

function stickerBarScaleFor(viewportWidth: number): number {
  let s: number;
  if (viewportWidth >= STICKER_BAR_FULL_WIDTH) s = 1;
  else if (viewportWidth <= STICKER_BAR_MIN_WIDTH) s = STICKER_BAR_MIN_SCALE;
  else {
    const t = (viewportWidth - STICKER_BAR_MIN_WIDTH) /
      (STICKER_BAR_FULL_WIDTH - STICKER_BAR_MIN_WIDTH);
    s = STICKER_BAR_MIN_SCALE + t * (1 - STICKER_BAR_MIN_SCALE);
  }
  return Math.round(s * 20) / 20; // quantize to 0.05 steps
}
// The header band is a real color from the atoms palette (the `coral` curated-wash
// family — a soft peach) blended toward the paper so it reads as a light band, not
// a full-strength color. solidColorOf gives a concrete rgb that we mix with the
// stable --brand-page-bg paper, so the header stays identical docked vs popped.
// Lower STICKER_HEADER_STRENGTH for a lighter band; swap the id for another family
// — "sunset-1" (golden), "meadow-1" (teal), "reef-1" (cyan), "dusk-1" (pink).
const STICKER_HEADER_STRENGTH = 50; // % of the atom color; the rest is the paper
const STICKER_HEADER_COLOR = `color-mix(in srgb, ${
  GradientSplat.solidColorOf(
    CuratedWashes.byIdOr("coral-1", CuratedWashes.ALL[0]).colors[0],
  )
} ${STICKER_HEADER_STRENGTH}%, var(--brand-page-bg, var(--bg)))`;

// The gradient wash is no longer part of the playground — it lives as a separate
// layer in `StickerBentoHero` (behind this asset), so the sheet can scale without
// touching the gradient.

// A tiny bidirectional handle bridging the out-of-tree detach control and the
// playground, which live in DIFFERENT shadow trees (the accessory is in the
// card's text column, the playground in the media slot) and can't reach each
// other via the DOM. The playground registers its pop-out/pop-in fns and reports
// its popped state here; the accessory toggles via the handle and subscribes to
// the state so it can flip its affordance (detach ⇄ close).
export class StickerPopHandle {
  private popOutFn: Option<() => void> = null;
  private popInFn: Option<() => void> = null;
  private stateListener: Option<(popped: boolean) => void> = null;
  private popped = false;

  // The playground registers both directions.
  register(fns: { popOut: () => void; popIn: () => void }): void {
    this.popOutFn = fns.popOut;
    this.popInFn = fns.popIn;
  }

  // The detach accessory subscribes to mirror the popped state. Called back
  // immediately with the current state, so wiring order doesn't matter.
  onStateChange(listener: (popped: boolean) => void): void {
    this.stateListener = listener;
    listener(this.popped);
  }

  // Accessory click: pop out when docked, pop back in (close) when popped.
  toggle(): void {
    if (this.popped) this.popInFn?.();
    else this.popOutFn?.();
  }

  // The playground reports its current state; drives the accessory's affordance.
  setPopped(popped: boolean): void {
    if (this.popped === popped) return;
    this.popped = popped;
    this.stateListener?.(popped);
  }
}

@component({ name: "std-landing-sticker-playground" })
export class LandingStickerPlayground extends LonaWebComponent {
  private readonly $sheetShell: HTMLElement = this.$("sheet-shell");
  private readonly controller = new DragDrop.Controller();
  private $sheet: Option<StickerSheet> = null;
  private $dropRoot: Option<HTMLElement> = null;
  private $stickerLayer: Option<HTMLElement> = null;
  private $previewLayer: Option<HTMLElement> = null;
  private rootPositionPatch: Option<RootPositionPatch> = null;
  private preview: Option<PreviewSticker> = null;
  private readonly placedStickers: PlacedSticker[] = [];
  private nextStickerId = 1;
  private nextZIndex = 1;
  private bindGeneration = 0;
  private disconnectGeneration = 0;
  private mode: "docked" | "popped" = "docked";
  // The popped sheet has two representations, picked by viewport: a one-row
  // sticker bar pinned to the page bottom (mobile, ≤768px) or a chromeless
  // floating MiniWindow that snaps to corners (desktop). Only one exists at a
  // time; `poppedKind` says which. They switch in place when the viewport crosses
  // the breakpoint while popped.
  private $bottomBar: Option<HTMLElement> = null;
  private $miniWindow: Option<MiniWindow> = null;
  private $floatingSheet: Option<StickerSheet> = null;
  private poppedKind: Option<"bar" | "window"> = null;
  private popRevealGeneration = 0;
  private popWired = false;
  private activeSetId: StickerArtCatalog.SetId =
    StickerArtCatalog.DEFAULT_SET_ID;
  private lastSlotSize: Option<Size> = null;
  // Re-lay-out the docked sheet when its height settles (tiles populate async).
  private sheetObserver: Option<ResizeObserver> = null;
  // Matches mobile viewports; a `change` listener swaps the popped representation
  // in place when the breakpoint is crossed.
  private mql: Option<MediaQueryList> = null;
  private onViewportChange: Option<() => void> = null;
  private onBarResize: Option<() => void> = null;
  // The sticker display scale last applied to the popped bar; re-bind only when a
  // resize moves it to a new quantized step (see maybeRescaleBar).
  private lastBarDisplayScale = 1;
  // The bridge to the out-of-tree detach accessory; popOut/popIn report state to
  // it so the accessory can flip its detach ⇄ close affordance.
  private popHandle: Option<StickerPopHandle> = null;
  private hydrated = false;
  private onLcpReady: Option<() => void> = null;
  private hydrateTimer: Option<number> = null;
  private hydrateTask: Option<EmptyFunction> = null;
  private dockSettleGeneration = 0;
  private dockSettleScheduled = false;
  private dockSettleFrameCount = 0;
  private dockStableFrames = 0;
  private dockPreviousSettleKey = "";

  // Re-scale the docked (in-bento) card whenever the slot resizes.
  onSizeChange: Option<(s: Size) => void> = (size) =>
    this.layoutDockedSheet(size);

  static makeWith(
    props: LandingStickerPlayground.Props,
  ): LandingStickerPlayground {
    return (LandingStickerPlayground.make() as LandingStickerPlayground).bind(
      props,
    );
  }

  bind(props: LandingStickerPlayground.Props): this {
    const generation = this.bindGeneration + 1;
    this.bindGeneration = generation;
    this.popHandle = props.popHandle ?? null;
    this.popHandle?.register({
      popOut: () => this.popOut(),
      popIn: () => this.popIn(),
    });
    this.wirePopTrigger();
    if (!this.hydrated) {
      this.scheduleHydration(generation);
    }
    return this;
  }

  private scheduleHydration(generation: number): void {
    this.cancelHydrationSchedule();
    if (this.hydrated || generation !== this.bindGeneration) return;

    if (performance.getEntriesByName(LANDING_LCP_READY_MARK).length > 0) {
      this.queueHydration(generation, 0);
      return;
    }

    const onReady = () => {
      this.cancelHydrationSchedule();
      this.queueHydration(generation, 0);
    };
    this.onLcpReady = onReady;
    window.addEventListener(LANDING_LCP_READY_EVENT, onReady, { once: true });
    this.hydrateTimer = window.setTimeout(() => {
      this.hydrateTimer = null;
      this.hydrateStickers(generation);
    }, STICKER_POST_LCP_FALLBACK_MS);
  }

  private queueHydration(generation: number, delayMs: number): void {
    if (
      this.hydrated ||
      generation !== this.bindGeneration ||
      this.hydrateTimer != null ||
      this.hydrateTask != null
    ) {
      return;
    }
    if (delayMs <= 0) {
      let task: EmptyFunction = () => {};
      task = $$.mutate(() => {
        if (this.hydrateTask !== task) return;
        this.hydrateTask = null;
        this.hydrateStickers(generation);
      });
      this.hydrateTask = task;
      return;
    }
    this.hydrateTimer = window.setTimeout(() => {
      this.hydrateTimer = null;
      this.hydrateStickers(generation);
    }, delayMs);
  }

  private cancelHydrationSchedule(): void {
    if (this.onLcpReady) {
      window.removeEventListener(LANDING_LCP_READY_EVENT, this.onLcpReady);
      this.onLcpReady = null;
    }
    if (this.hydrateTimer != null) {
      window.clearTimeout(this.hydrateTimer);
      this.hydrateTimer = null;
    }
    if (this.hydrateTask != null) {
      $$.clear(this.hydrateTask);
      this.hydrateTask = null;
    }
  }

  private hydrateStickers(generation: number): void {
    if (this.hydrated || generation !== this.bindGeneration) return;
    this.cancelHydrationSchedule();
    this.hydrated = true;
    this.setDockReady(false);
    this.controller.reset();
    this.ensureViewportListener();
    this.ensureDropSurface();
    const $sheet = this.ensureStickerSheet();
    this.bindStickerSet($sheet, StickerArtCatalog.DEFAULT_SET_ID);
    this.registerPlacedStickerSources();
    void this.bindAvailableStickerSet(generation, $sheet);
    this.startDockSettle(generation);
  }

  private async bindAvailableStickerSet(
    generation: number,
    $sheet: StickerSheet,
  ): Promise<void> {
    const sets = await StickerArtCatalog.setSummaries().catch((err) => {
      Tracing.warn("ui")(
        `LandingStickerPlayground: failed to load sticker sets: ${err}`,
      );
      return null;
    });
    if (generation !== this.bindGeneration || !$sheet.isConnected || !sets) {
      return;
    }

    const set =
      sets.find((item) => item.id === StickerArtCatalog.DEFAULT_SET_ID) ??
        sets[0] ?? null;
    if (!set) return;
    if (set.id === this.activeSetId) return;
    this.bindStickerSet($sheet, set.id);
  }

  private bindStickerSet(
    $sheet: StickerSheet,
    setId: StickerArtCatalog.SetId,
  ): void {
    this.activeSetId = setId;
    // Docked (in-bento): the full vertical sticker card — header, accent, tiled
    // body — bleeding off the bottom; pins its tile size for a deterministic,
    // bigger-tile card.
    $sheet.bind({
      controller: null,
      setId,
      flipOnTap: false,
      bleed: true,
      tileSize: STICKER_DOCK_TILE_SIZE,
      previewLimit: STICKER_DOCK_PREVIEW_LIMIT,
    });
    // Popped: rebind whichever floating representation is showing (bar vs window
    // differ in layout / tile size).
    if (this.$floatingSheet && this.$floatingSheet !== $sheet) {
      this.bindFloatingSheet();
    }
  }

  // ─── Pop-out lifecycle ───
  //
  // Docked: the in-bento card is a click-to-pop-out affordance (a transparent
  // trigger overlays it). Popped: the in-bento card slides down + fades, and the
  // viewport-appropriate representation appears — on mobile a one-row sticker bar
  // (StickerSheet layout="bar") anchored to the BOTTOM of the page; on desktop a
  // chromeless floating MiniWindow. Crossing the breakpoint while popped switches
  // between them in place. Stickers drag off onto the page; closing re-docks.

  private wirePopTrigger(): void {
    if (this.popWired) return;
    this.popWired = true;
    GESTURE_MANAGER.addPointerEvent(this.$("pop-trigger"), {
      onClick: () => this.popOut(),
    });
  }

  private popOut(): void {
    this.hydrateStickers(this.bindGeneration);
    if (this.mode === "popped") {
      this.revealPopped(this.nextPopRevealGeneration());
      return;
    }
    this.mode = "popped";
    const revealGeneration = this.nextPopRevealGeneration();
    Tracing.log("sticker/pop-out", null);
    this.popHandle?.setPopped(true);

    const $dock = this.$("dock");
    const $sheetShell = this.$sheetShell;
    $dock.style.pointerEvents = "none";
    SimpleKeyframe.builder()
      .slideOut(0, 24)
      .fadeOut()
      .animate(
        $sheetShell,
        true,
        240,
        () =>
          this.mode !== "popped" ||
          revealGeneration !== this.popRevealGeneration,
        () => this.revealPopped(revealGeneration),
      );

    Hotkeys.pushEscapeHandler(STICKER_WINDOW_ESCAPE_ID, () => this.popIn());
  }

  private popIn(): void {
    if (this.mode === "docked") return;
    this.mode = "docked";
    this.nextPopRevealGeneration();
    Tracing.log("sticker/pop-in", null);
    this.popHandle?.setPopped(false);
    Hotkeys.clearEscapeHandler(STICKER_WINDOW_ESCAPE_ID);

    this.hidePopped();

    const $dock = this.$("dock");
    $dock.style.pointerEvents = "";
    if (this.lastSlotSize) this.layoutDockedSheet(this.lastSlotSize);
    SimpleKeyframe.builder()
      .slideIn(0, 24)
      .fadeIn()
      .animate(this.$sheetShell, true, 240);
  }

  // Pick the representation for the current viewport and show it. If a different
  // representation is already open (a mid-popped viewport switch), tear it down
  // first so only one shell is ever in the DOM.
  private revealPopped(generation: number): void {
    if (generation !== this.popRevealGeneration || this.mode !== "popped") {
      return;
    }
    const kind: "bar" | "window" = this.isMobile() ? "bar" : "window";
    if (this.poppedKind && this.poppedKind !== kind) {
      this.teardownActiveRepresentation();
    }
    this.poppedKind = kind;
    if (kind === "bar") this.revealBar(generation);
    else this.revealWindow(generation);
  }

  private nextPopRevealGeneration(): number {
    this.popRevealGeneration += 1;
    return this.popRevealGeneration;
  }

  private revealBar(generation: number): void {
    const $bar = this.ensureBottomBar();
    // bindFloatingSheet renders the bar's stickers at the current display scale,
    // so the bar wraps them at the matching (shorter) height before it slides in.
    this.bindFloatingSheet();
    if (!$bar.isConnected) document.body.appendChild($bar);
    $bar.style.display = "flex";
    $bar.style.visibility = "hidden";
    this.afterPoppedLayout(generation, () => {
      if (this.poppedKind !== "bar") return;
      $bar.style.removeProperty("visibility");
      SimpleKeyframe.builder().slideIn(0, 24).fadeIn().animate($bar, true, 240);
    });
  }

  // On resize, re-render the popped bar's stickers at the new display scale (only
  // when it crosses a quantized step, so we don't re-bind every pixel). The bar
  // wraps the smaller stickers, so its height follows; its full-width bleed is
  // unchanged.
  private maybeRescaleBar(): void {
    if (this.mode !== "popped" || this.poppedKind !== "bar") return;
    if (stickerBarScaleFor(window.innerWidth) === this.lastBarDisplayScale) {
      return;
    }
    this.bindFloatingSheet();
  }

  private revealWindow(generation: number): void {
    const $window = this.ensureMiniWindow();
    const wasRevealed = $window.isRevealed();
    if (!$window.isConnected) document.body.appendChild($window);
    if (wasRevealed) {
      this.bindFloatingSheet();
      $window.snapTo("bottom-right");
      return;
    }
    $window.prepareRevealAt("bottom-right");
    this.bindFloatingSheet();
    this.afterPoppedLayout(generation, () => {
      if (this.poppedKind !== "window") return;
      $window.finishPreparedRevealAt("bottom-right");
    });
  }

  // Bind the floating sheet for whichever representation is active: the bar uses
  // the one-row "bar" layout at the bar tile size; the window uses the sheet's
  // natural layout (its header doubles as window chrome).
  private bindFloatingSheet(): void {
    const $sheet = this.$floatingSheet;
    if (!$sheet) return;
    if (this.poppedKind === "bar") {
      // Shrink the stickers (and the tile pin, keeping its margin) on a narrow
      // page; the bar wraps them so its height follows while staying full-width.
      const scale = stickerBarScaleFor(window.innerWidth);
      this.lastBarDisplayScale = scale;
      $sheet.bind({
        controller: this.controller,
        setId: this.activeSetId,
        layout: "bar",
        tileSize: STICKER_BAR_TILE_SIZE * scale,
        displayScale: scale,
      });
    } else {
      $sheet.bind({
        controller: this.controller,
        setId: this.activeSetId,
        flipOnTap: false,
        tileSize: STICKER_WINDOW_TILE_SIZE,
      });
    }
  }

  private afterPoppedLayout(generation: number, onReady: () => void): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generation !== this.popRevealGeneration || this.mode !== "popped") {
          return;
        }
        onReady();
      });
    });
  }

  private hidePopped(): void {
    if (this.poppedKind === "bar") this.hideBar();
    else if (this.poppedKind === "window") this.hideWindow();
  }

  private hideBar(): void {
    const $bar = this.$bottomBar;
    if (!$bar) return;
    SimpleKeyframe.builder()
      .slideOut(0, 24)
      .fadeOut()
      .animate($bar, true, 200, () => this.mode !== "docked", () => {
        $bar.style.display = "none";
        $bar.style.removeProperty("visibility");
        $bar.style.removeProperty("opacity");
        $bar.style.removeProperty("transform");
      });
  }

  private hideWindow(): void {
    const $window = this.$miniWindow;
    if (!$window) return;
    SimpleKeyframe.builder()
      .fadeOut()
      .animate($window, true, 180, () => this.mode !== "docked", () => {
        $window.hide();
        $window.style.removeProperty("opacity");
      });
  }

  // The popped bar: a body-level container FIXED to the bottom of the page (so it
  // floats above all content and is never clipped by the bento). It holds the
  // sticker sheet in its one-row "bar" layout plus a close button; only the bar
  // catches pointer events, so the rest of the page stays interactive for drops.
  private ensureBottomBar(): HTMLElement {
    if (this.$bottomBar) return this.$bottomBar;

    const $bar = document.createElement("div");
    $bar.dataset.landingStickerBar = "true";
    $bar.assignStyles({
      position: "fixed",
      left: "0px",
      right: "0px",
      bottom: "0px",
      display: "flex",
      justifyContent: "center",
      padding: "0px 4px 4px",
      zIndex: "50",
      pointerEvents: "none",
    });

    const $row = document.createElement("div");
    $row.assignStyles({
      position: "relative", // anchor for the floating close button
      display: "flex",
      alignItems: "center",
      width: "100%",
      maxWidth: "900px",
      pointerEvents: "auto",
    });

    const $sheet = StickerSheet.make();
    $sheet.assignStyles({ flex: "1", minWidth: "0px" });
    this.applyStickerTints($sheet);

    // Reuse the shared close button (same one modals / lightbox / sidebar use).
    // Float it at the bar's top-right, ABOVE the bar — its :host is already
    // position:absolute, so we only override the offsets (and zero its default
    // modal-header margins). The circular --bg fill keeps it readable over
    // arbitrary page content.
    const $close = ModalCloseButton.make().bind({
      onDismiss: () => this.popIn(),
    });
    $close.assignStyles({
      top: "auto",
      right: "0px",
      bottom: "calc(100% + 8px)",
      marginInline: "0px",
      marginBottom: "0px",
      // Elevation so the floating button reads above the page (its built-in
      // scrolled/active shadow only fires with a scrollSource, which we don't set).
      boxShadow: "var(--box-shadow-light)",
    });

    $row.appendChild($sheet);
    $row.appendChild($close);
    $bar.appendChild($row);

    this.$floatingSheet = $sheet;
    this.$bottomBar = $bar;
    return $bar;
  }

  // Chromeless floating window (desktop): no MiniWindow titlebar/bg — the
  // StickerSheet's own header is the chrome (drag handle + a close button in its
  // header slot). Snaps to corners like the ux-test popover.
  private ensureMiniWindow(): MiniWindow {
    if (this.$miniWindow) return this.$miniWindow;

    const $window = MiniWindow.makeWith({
      snapToCorners: true,
      chromeless: true,
      // The sticker sheet's std-round surface owns the rounding + drop-shadow;
      // delegateRadius stops #content's overflow:auto from shaving that shadow.
      delegateRadius: true,
      onClose: () => this.popIn(),
    });

    const $sheet = StickerSheet.make();
    $sheet.toggleFullHeight(true);
    $sheet.style.height = "100%";
    this.applyStickerTints($sheet);

    const $close = IconButton.makeWith({
      content: LonaIcons.$svg(XIcon),
      ariaLabel: "Dock sticker sheet",
    });
    $close.slot = "header-action";
    GESTURE_MANAGER.addPointerEvent($close, { onClick: () => this.popIn() });
    $sheet.appendChild($close);

    $window.appendChild($sheet);
    $window.setDragHandle($sheet.headerElement());

    this.$floatingSheet = $sheet;
    this.$miniWindow = $window;
    return $window;
  }

  // Remove whichever popped shell exists (only one normally does) and reset the
  // popped pointers — used both for a viewport switch and for full teardown.
  private teardownActiveRepresentation(): void {
    this.$bottomBar?.remove();
    this.$bottomBar = null;
    this.$miniWindow?.remove();
    this.$miniWindow = null;
    this.$floatingSheet = null;
    this.poppedKind = null;
  }

  private teardownPopOut(): void {
    this.nextPopRevealGeneration();
    this.teardownActiveRepresentation();
    this.mode = "docked";
  }

  private mediaQuery(): MediaQueryList {
    if (!this.mql) this.mql = window.matchMedia("(max-width: 768px)");
    return this.mql;
  }

  private isMobile(): boolean {
    return this.mediaQuery().matches;
  }

  private ensureViewportListener(): void {
    if (this.onViewportChange) return;
    const handler = () => this.syncRepresentationToViewport();
    this.onViewportChange = handler;
    this.mediaQuery().addEventListener("change", handler);

    // The bar's sticker scale changes continuously with width; the matchMedia
    // `change` above only fires at the 768 breakpoint, so re-check on resize too.
    const onResize = () => this.maybeRescaleBar();
    this.onBarResize = onResize;
    window.addEventListener("resize", onResize);
  }

  private teardownViewportListener(): void {
    if (this.onViewportChange) {
      this.mediaQuery().removeEventListener("change", this.onViewportChange);
      this.onViewportChange = null;
    }
    if (this.onBarResize) {
      window.removeEventListener("resize", this.onBarResize);
      this.onBarResize = null;
    }
  }

  // When the viewport crosses the breakpoint while popped, switch the
  // representation in place. Placed stickers live on document.body, so they are
  // untouched by the swap.
  private syncRepresentationToViewport(): void {
    if (this.mode !== "popped") {
      // Docked: re-tile the in-bento card at the breakpoint (desktop bleed ⇄ mobile
      // contained), in case the slot-resize notification didn't fire.
      if (this.lastSlotSize) this.layoutDockedSheet(this.lastSlotSize);
      return;
    }
    const want: "bar" | "window" = this.isMobile() ? "bar" : "window";
    if (this.poppedKind === want) return;
    this.revealPopped(this.nextPopRevealGeneration());
  }

  private applyStickerTints($sheet: StickerSheet): void {
    // Body: one flat paper color pinned to --brand-page-bg, so it stays identical
    // whether the sheet is docked in the brand shell or popped into the bottom bar
    // on document.body. BrandApp sets --brand-page-bg on BOTH; outside the shell
    // --bg/--text-pri would resolve to different app/root values and shift it.
    const paper = "var(--brand-page-bg, var(--bg))";
    // Header: a real color from the atoms palette (STICKER_HEADER_COLOR, a solid
    // curated-wash color) — not a tint of the paper. It's a concrete rgb(...), so
    // it's identical docked vs popped.
    $sheet.style.setProperty("--sticker-sheet-header-bg", STICKER_HEADER_COLOR);
    $sheet.style.setProperty("--sticker-sheet-body-bg", paper);
  }

  private ensureStickerSheet(): StickerSheet {
    if (!this.$sheet) {
      this.$sheet = StickerSheet.make();
      this.$sheet.id = "sticker-sheet";
      this.$sheet.style.width = `${STICKER_NATIVE_WIDTH}px`;
      this.applyStickerTints(this.$sheet);
    }
    if (this.$sheet.parentElement !== this.$sheetShell) {
      DomUtils.clearChildren(this.$sheetShell);
      this.$sheetShell.appendChild(this.$sheet);
    }
    if (!this.sheetObserver) {
      this.sheetObserver = new ResizeObserver(() => {
        if (this.lastSlotSize) this.layoutDockedSheet(this.lastSlotSize);
      });
    }
    this.sheetObserver.observe(this.$sheet);
    if (this.offsetWidth > 0) {
      this.layoutDockedSheet({
        width: this.offsetWidth,
        height: this.offsetHeight,
      });
    }
    return this.$sheet;
  }

  // Lay out the docked sheet as one fixed-width object scaled into the asset
  // container. The outer #dock owns the persistent scale/position; the inner
  // #sheet-shell owns transient pop-out motion, so reveal/dismiss animations never
  // clobber the scale transform.
  private layoutDockedSheet(size: Size): void {
    if (size.width <= 0 || size.height <= 0) return;
    this.lastSlotSize = size;
    if (this.mode !== "docked") return;
    const $sheet = this.$sheet;
    if (!$sheet) return;
    const nativeHeight = $sheet.offsetHeight;
    if (nativeHeight <= 0) return;
    this.applyDockFrame(this.resolveDockFrame(size, nativeHeight));
  }

  private resolveDockFrame(
    size: Size,
    nativeHeight: number,
  ): DockFrame {
    const inset = this.dockInsetFor(size);
    const rightBleed = Math.max(
      inset,
      size.width * STICKER_DOCK_BLEED_FRACTION,
    );
    const bottomBleed = Math.max(
      inset,
      size.height * STICKER_DOCK_BLEED_FRACTION,
    );
    const scale = Math.min(
      STICKER_DOCK_MAX_SCALE,
      Math.max(
        (size.width + rightBleed - inset) / STICKER_NATIVE_WIDTH,
        (size.height + bottomBleed - inset) / nativeHeight,
      ),
    );
    const scaledWidth = STICKER_NATIVE_WIDTH * scale;
    const scaledHeight = nativeHeight * scale;
    return {
      left: this.resolveDockAxisStart(
        size.width,
        scaledWidth,
        inset,
        rightBleed,
      ),
      top: this.resolveDockAxisStart(
        size.height,
        scaledHeight,
        inset,
        bottomBleed,
      ),
      scale,
    };
  }

  private dockInsetFor(size: Size): number {
    return Math.min(STICKER_DOCK_INSET, Math.min(size.width, size.height) / 5);
  }

  private resolveDockAxisStart(
    stageExtent: number,
    scaledExtent: number,
    inset: number,
    bleed: number,
  ): number {
    if (stageExtent <= inset * 2) {
      return (stageExtent - scaledExtent) / 2;
    }
    return Math.max(inset, stageExtent + bleed - scaledExtent);
  }

  private applyDockFrame(frame: DockFrame): void {
    const $dock = this.$("dock");
    $dock.style.left = `${frame.left}px`;
    $dock.style.top = `${frame.top}px`;
    $dock.style.transform = `scale(${frame.scale})`;
  }

  private setDockReady(ready: boolean): void {
    this.toggleAttribute("dock-ready", ready);
  }

  private startDockSettle(generation: number): void {
    this.dockSettleGeneration = generation;
    this.dockSettleScheduled = false;
    this.dockSettleFrameCount = 0;
    this.dockStableFrames = 0;
    this.dockPreviousSettleKey = "";
    this.scheduleDockSettle(generation);
  }

  private scheduleDockSettle(generation: number): void {
    if (generation !== this.dockSettleGeneration || this.dockSettleScheduled) {
      return;
    }
    this.dockSettleScheduled = true;
    $$.measure(() => this.measureDockSettle(generation));
  }

  private measureDockSettle(generation: number): void {
    if (
      generation !== this.dockSettleGeneration ||
      generation !== this.bindGeneration ||
      !this.hydrated ||
      this.mode !== "docked"
    ) {
      this.dockSettleScheduled = false;
      return;
    }
    const measurement = this.measureDockSettleState();
    this.dockSettleFrameCount++;
    if (measurement.key === this.dockPreviousSettleKey) this.dockStableFrames++;
    else this.dockStableFrames = 0;
    this.dockPreviousSettleKey = measurement.key;
    const previewsReady = measurement.tileCount > 0 &&
      measurement.previewReadyCount >= measurement.tileCount;
    const stable = previewsReady &&
      this.dockStableFrames >= STICKER_DOCK_SETTLE_FRAMES;
    const timedOut =
      this.dockSettleFrameCount >= STICKER_DOCK_MAX_SETTLE_FRAMES;

    $$.mutate(() => {
      if (
        generation !== this.dockSettleGeneration ||
        generation !== this.bindGeneration ||
        !this.hydrated ||
        this.mode !== "docked"
      ) {
        this.dockSettleScheduled = false;
        return;
      }
      this.dockSettleScheduled = false;
      if (measurement.frame) this.applyDockFrame(measurement.frame);
      if (stable || timedOut) {
        this.setDockReady(true);
        return;
      }
      this.scheduleDockSettle(generation);
    });
  }

  private measureDockSettleState(): DockSettleMeasurement {
    const $sheet = this.$sheet;
    if (!$sheet) {
      return {
        frame: null,
        key: "missing",
        tileCount: 0,
        previewReadyCount: 0,
      };
    }
    const tileCount = $sheet.previewTileCount();
    const previewReadyCount = $sheet.previewReadyCount();
    const width = $sheet.offsetWidth;
    const height = $sheet.offsetHeight;
    const size = this.lastSlotSize ?? this.currentSlotSize();
    const frame = size && height > 0
      ? this.resolveDockFrame(size, height)
      : null;
    return {
      frame,
      key: `${width}:${height}:${tileCount}`,
      tileCount,
      previewReadyCount,
    };
  }

  private currentSlotSize(): Option<Size> {
    const width = this.offsetWidth;
    const height = this.offsetHeight;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  private ensureDropSurface(): void {
    const $root = this.resolveDropRoot();
    if (!$root) return;

    if (this.$dropRoot !== $root) {
      this.detachDropSurface();
      this.$dropRoot = $root;
      this.applyPositioning($root);
    }

    const $layer = this.ensureStickerLayer($root);
    for (const sticker of this.placedStickers) {
      if (sticker.$el.parentElement !== $layer) $layer.appendChild(sticker.$el);
      this.positionSticker(sticker);
    }

    this.controller.registerTarget($root, {
      canAccept: (payload) =>
        payload.is(StickerDrag.KIND) || payload.is(LandingStickerMoveDrag.KIND),
      onMove: (e) => this.previewDrop(e),
      onLeave: () => this.clearPreview(),
      onDrop: (e) => this.dropSticker(e),
    });
  }

  private resolveDropRoot(): Option<HTMLElement> {
    // Drop stickers ANYWHERE on the page. The whole document body is the drop
    // surface: the playground lives in a card's shadow DOM (so the light-DOM
    // page-engine root isn't reachable via closest(), and that root is reconciled
    // anyway — a layer parented there would be deleted). The body is the window
    // scroller, so the `inset:0` layer spans the full document and target-relative
    // drop coords place stickers in document space that scroll with the page.
    return document.body;
  }

  private ensureStickerLayer($root: HTMLElement): HTMLElement {
    if (!this.$stickerLayer) {
      this.$stickerLayer = this.$makeOverlayLayer("landingStickerLayer", "40");
    }
    if (this.$stickerLayer.parentElement !== $root) {
      $root.appendChild(this.$stickerLayer);
    }
    return this.$stickerLayer;
  }

  // The active drag preview rides ABOVE the popped bottom bar so the sticker
  // stays visible while you drag it out; on drop it becomes a placed sticker in
  // the resting layer BELOW the bar (see $makeOverlayLayer). Lazily created on
  // the first drag and parented to the current drop root.
  private ensurePreviewLayer(): Option<HTMLElement> {
    const $root = this.$dropRoot;
    if (!$root) return null;
    if (!this.$previewLayer) {
      this.$previewLayer = this.$makeOverlayLayer(
        "landingStickerPreviewLayer",
        "60",
      );
    }
    if (this.$previewLayer.parentElement !== $root) {
      $root.appendChild(this.$previewLayer);
    }
    return this.$previewLayer;
  }

  // Two sibling overlay layers on the drop root (document.body), identical in
  // geometry (absolute, inset:0 — document space, scrolling with the page) but
  // straddling the popped bottom bar (z 50) in stacking order. Each is its own
  // stacking context, so a sticker's layer — not its per-sticker z — decides
  // which side of the bar it lands on:
  //   - resting placed stickers sit BELOW the bar (z 40), so a sticker dropped
  //     over the bar tucks behind it;
  //   - the active drag preview sits ABOVE the bar (z 60), so it stays visible
  //     while dragged out (the StickerDragChip floats higher still, z 1000,
  //     until it hands off to this preview over the drop target).
  private $makeOverlayLayer(dataKey: string, zIndex: string): HTMLElement {
    const $layer = document.createElement("div");
    $layer.dataset[dataKey] = "true";
    $layer.assignStyles({
      position: "absolute",
      inset: "0px",
      overflow: "visible",
      pointerEvents: "none",
      zIndex,
    });
    return $layer;
  }

  private applyPositioning($root: HTMLElement): void {
    if (getComputedStyle($root).position !== "static") return;
    this.rootPositionPatch = {
      $root,
      inlinePosition: $root.style.position,
    };
    $root.style.position = "relative";
  }

  private previewDrop(e: DragDrop.TargetMove): void {
    const createPayload = e.payload.get(StickerDrag.KIND);
    if (createPayload) {
      this.showPreview(
        `create:${createPayload.stickerId}:${createPayload.effect}:${
          createPayload.effectVariant ?? ""
        }`,
        createPayload,
        e.local,
        { x: 0, y: 0 },
      );
      return;
    }

    const movePayload = e.payload.get(LandingStickerMoveDrag.KIND);
    if (!movePayload) return;
    const sticker = this.findPlacedSticker(movePayload.id);
    if (!sticker) return;
    this.showPreview(
      `move:${sticker.id}:${sticker.stickerId}:${sticker.effect}:${
        sticker.effectVariant ?? ""
      }`,
      sticker,
      e.local,
      this.grabFromCenter(sticker, e.grabOffset),
    );
  }

  private dropSticker(e: DragDrop.Drop): void {
    const createPayload = e.payload.get(StickerDrag.KIND);
    if (createPayload) {
      this.addPlacedSticker(createPayload, {
        x: e.local.x,
        y: e.local.y,
      });
      this.clearPreview();
      return;
    }

    const movePayload = e.payload.get(LandingStickerMoveDrag.KIND);
    if (!movePayload) return;
    const sticker = this.findPlacedSticker(movePayload.id);
    if (!sticker) return;
    const grab = this.grabFromCenter(sticker, e.grabOffset);
    sticker.x = e.local.x - grab.x;
    sticker.y = e.local.y - grab.y;
    sticker.z = this.nextZIndex++;
    this.positionSticker(sticker);
    this.clearPreview();
  }

  private showPreview(
    key: string,
    visual: LandingStickerVisual,
    local: { x: number; y: number },
    grab: { x: number; y: number },
  ): void {
    const $layer = this.ensurePreviewLayer();
    if (!$layer) return;

    const preview = this.ensurePreview(key, visual);
    if (preview.$el.parentElement !== $layer) $layer.appendChild(preview.$el);
    preview.$el.assignStyles({
      left: `${local.x - grab.x}px`,
      top: `${local.y - grab.y}px`,
    });
  }

  private ensurePreview(
    key: string,
    visual: LandingStickerVisual,
  ): PreviewSticker {
    if (this.preview?.key === key) return this.preview;

    this.clearPreview();
    const $el = this.makeStickerElement("raised", false);
    this.bindStickerPreview($el, visual, "raised");
    this.preview = { key, $el };
    return this.preview;
  }

  private addPlacedSticker(
    visual: LandingStickerVisual,
    point: { x: number; y: number },
  ): void {
    const $layer = this.$stickerLayer;
    if (!$layer) return;

    const sticker: PlacedSticker = {
      id: `landing-sticker-${this.nextStickerId++}`,
      stickerId: visual.stickerId,
      effect: visual.effect,
      effectVariant: visual.effectVariant,
      $el: this.makeStickerElement("flat", true),
      x: point.x,
      y: point.y,
      z: this.nextZIndex++,
      chip: null,
    };
    this.bindStickerPreview(sticker.$el, sticker, "flat");
    this.placedStickers.push(sticker);
    $layer.appendChild(sticker.$el);
    this.positionSticker(sticker);
    this.registerPlacedStickerSource(sticker);
  }

  private makeStickerElement(
    depth: StickerCutoutPreview.Depth,
    interactive: boolean,
  ): StickerCutoutPreview {
    const $el = StickerCutoutPreview.make();
    $el.assignStyles({
      position: "absolute",
      transform: "translate(-50%, -50%)",
      pointerEvents: interactive ? "auto" : "none",
      touchAction: "none",
      userSelect: "none",
      cursor: interactive ? "grab" : "default",
      opacity: depth === "raised" ? "0.92" : "1",
    });
    $el.setAttribute("aria-hidden", interactive ? "false" : "true");
    if (interactive) {
      $el.setAttribute("role", "button");
      $el.setAttribute("tabindex", "0");
    }
    return $el;
  }

  private bindStickerPreview(
    $el: StickerCutoutPreview,
    visual: LandingStickerVisual,
    depth: StickerCutoutPreview.Depth,
  ): void {
    const renderKey = `${visual.stickerId}:${visual.effect}:${
      visual.effectVariant ?? ""
    }:${depth}`;
    $el.dataset.stickerRenderKey = renderKey;
    void StickerArtCatalog.asset(visual.stickerId)
      .then((asset) => {
        if (!asset) return null;
        return StickerArtCatalog.cutout(asset.id).then((result) => {
          if (!result || $el.dataset.stickerRenderKey !== renderKey) return;
          $el.setAttribute("aria-label", asset.alt);
          $el.bindResult({
            result,
            alt: asset.alt,
            imageRendering: asset.imageRendering,
            displayWidth: asset.displayWidth,
            displayHeight: asset.displayHeight,
            depth,
            effect: visual.effect,
            effectVariant: visual.effectVariant,
          });
        });
      })
      .catch((err) => {
        Tracing.warn("ui")(
          `LandingStickerPlayground: failed to render dropped sticker "${visual.stickerId}": ${err}`,
        );
      });
  }

  private registerPlacedStickerSources(): void {
    for (const sticker of this.placedStickers) {
      this.registerPlacedStickerSource(sticker);
    }
  }

  private registerPlacedStickerSource(sticker: PlacedSticker): void {
    this.controller.registerSource(sticker.$el, {
      payload: () => LandingStickerMoveDrag.KIND.payload({ id: sticker.id }),
      onLift: (e) => this.liftPlacedSticker(sticker, e),
      onMove: (e) => this.movePlacedSticker(sticker, e),
      onSettle: (e) => this.settlePlacedSticker(sticker, e),
    });
  }

  private liftPlacedSticker(
    sticker: PlacedSticker,
    e: DragDrop.Lift,
  ): void {
    sticker.z = this.nextZIndex++;
    this.positionSticker(sticker);
    sticker.$el.assignStyles({
      cursor: "grabbing",
      opacity: "0.35",
    });

    const rect = sticker.$el.getBoundingClientRect();
    const grab = this.grabFromCenter(sticker, e.grabOffset);
    const chip = StickerDragChip.art(
      sticker.stickerId,
      sticker.effect,
      sticker.effectVariant,
      grab,
    );
    chip.moveTo({
      x: rect.left + e.grabOffset.x,
      y: rect.top + e.grabOffset.y,
    });
    sticker.chip = chip;
  }

  private movePlacedSticker(
    sticker: PlacedSticker,
    e: DragDrop.Move,
  ): void {
    const chip = sticker.chip;
    if (!chip) return;
    chip.setVisible(e.over == null);
    chip.moveTo({
      x: e.page.x - window.scrollX,
      y: e.page.y - window.scrollY,
    });
  }

  private settlePlacedSticker(
    sticker: PlacedSticker,
    _e: DragDrop.Settle,
  ): void {
    sticker.chip?.remove();
    sticker.chip = null;
    sticker.$el.assignStyles({
      cursor: "grab",
      opacity: "1",
    });
  }

  private grabFromCenter(
    sticker: PlacedSticker,
    grabOffset: { x: number; y: number },
  ): { x: number; y: number } {
    const rect = sticker.$el.getBoundingClientRect();
    return {
      x: grabOffset.x - rect.width / 2,
      y: grabOffset.y - rect.height / 2,
    };
  }

  private positionSticker(sticker: PlacedSticker): void {
    sticker.$el.assignStyles({
      left: `${sticker.x}px`,
      top: `${sticker.y}px`,
      zIndex: `${sticker.z}`,
    });
  }

  private findPlacedSticker(id: string): Option<PlacedSticker> {
    return this.placedStickers.find((sticker) => sticker.id === id) ?? null;
  }

  private clearPreview(): void {
    this.preview?.$el.remove();
    this.preview = null;
  }

  private clearPlacedStickers(): void {
    for (const sticker of this.placedStickers) {
      sticker.chip?.remove();
      sticker.$el.remove();
    }
    this.placedStickers.length = 0;
  }

  private detachDropSurface(): void {
    if (this.$dropRoot) {
      this.controller.unregisterTarget(this.$dropRoot);
    }
    this.clearPreview();
    this.$stickerLayer?.remove();
    this.$stickerLayer = null;
    this.$previewLayer?.remove();
    this.$previewLayer = null;
    const patch = this.rootPositionPatch;
    if (patch) {
      patch.$root.style.position = patch.inlinePosition;
      this.rootPositionPatch = null;
    }
    this.$dropRoot = null;
  }

  private teardown(): void {
    this.bindGeneration++;
    this.cancelHydrationSchedule();
    this.hydrated = false;
    this.setDockReady(false);
    this.dockSettleGeneration++;
    this.dockSettleScheduled = false;
    this.controller.reset();
    this.clearPlacedStickers();
    this.detachDropSurface();
    this.teardownPopOut();
    this.teardownViewportListener();
    this.sheetObserver?.disconnect();
    this.sheetObserver = null;
    this.lastSlotSize = null;
  }

  private scheduleDisconnectTeardown(): void {
    const generation = this.disconnectGeneration + 1;
    this.disconnectGeneration = generation;
    queueMicrotask(() => {
      if (generation !== this.disconnectGeneration || this.isConnected) return;
      this.teardown();
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disconnectGeneration++;
    if (this.hydrated) {
      this.ensureDropSurface();
      this.ensureViewportListener();
    } else if (this.bindGeneration > 0) {
      this.scheduleHydration(this.bindGeneration);
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.teardown();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scheduleDisconnectTeardown();
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #playground {
        position: relative;
        width: 100%;
        height: 100%;
        /* Clip the scaled sheet so the tiled body bleeds off the bottom. */
        overflow: hidden;
      }

      /* The sheet renders at its native width; layoutDockedSheet scales the whole
        card from this outer wrapper, preferring a bottom/right bleed inside the
        asset container. The drop-shadow traces the scaled sheet so it reads as
        elevated; the small vertical offset keeps the halo visible in the inset
        gap instead of falling into the clipped bottom bleed. */
      #dock {
        position: absolute;
        top: 0;
        left: 0;
        width: max-content;
        transform-origin: top left;
        z-index: 1;
        opacity: 0;
        visibility: hidden;
        transition: opacity 180ms ease;
        filter: drop-shadow(
          0
          6px
          34px
          color-mix(in srgb, var(--text-pri) 24%, transparent)
        );
      }

      :host([dock-ready]) #dock {
        opacity: 1;
        visibility: visible;
      }

      #sheet-shell {
        display: block;
        width: max-content;
      }

      #pop-trigger {
        position: absolute;
        inset: 0;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: pointer;
        z-index: 2;
      }

      :host(:not([dock-ready])) #pop-trigger {
        pointer-events: none;
      }

      #sticker-sheet {
        /* Tile size is pinned in JS (STICKER_DOCK_TILE_SIZE) for deterministic
          geometry; header/body tints are applied inline (applyStickerTints) so
          they match the floating sheet — neither is declared here. */
        --sticker-sheet-radius: 16px;
        --sticker-sheet-grid-gap: 6px;
        --sticker-sheet-border-color: color-mix(
          in srgb,
          var(--divider) 84%,
          transparent 16%
        );
        margin-top: 0px;
      }
    `,
  ];

  static $html = html`
    <div id="playground" data-sticker-playground-stub="true">
      <div id="dock">
        <aside id="sheet-shell" aria-label="Sticker sheet"></aside>
      </div>
      <button
        id="pop-trigger"
        type="button"
        aria-label="Pop out the sticker sheet to play"
      >
      </button>
    </div>
  `;
}

export namespace LandingStickerPlayground {
  export type Props = Optional<{
    // When provided, the playground registers its pop-out so an out-of-tree
    // control (the card's detach accessory) can trigger it.
    popHandle: StickerPopHandle;
  }>;
}
