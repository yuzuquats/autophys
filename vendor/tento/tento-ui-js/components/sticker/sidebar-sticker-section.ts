import "./sticker-sheet";
import { Tracing } from "@tento-core/tracing";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DragDrop } from "../../drag-drop";
import { IconButton } from "../icon-button";
import { Typography } from "../../ui/typography";
import { StickerArtCatalog } from "./sticker-art-catalog";
import { StickerMaterialVariant } from "./sticker-material-variant";
import { StickerSheet } from "./sticker-sheet";

const STICKER_OFFBAND_LOAD_DELAY_MS = 2500;
const STICKER_OFFBAND_IDLE_TIMEOUT_MS = 3000;

@component({ name: "std-sidebar-sticker-section" })
export class SidebarStickerSection extends LonaWebComponent {
  private readonly $sheet: StickerSheet = this.hydrate("sheet");
  private readonly $packNav: HTMLElement = this.$("pack-nav");
  private readonly $prev: IconButton = this.hydrate("prev");
  private readonly $next: IconButton = this.hydrate("next");
  private readonly $position: HTMLElement = this.$("position");

  private controller: Option<DragDrop.Controller> = null;
  private effectVariant: Option<StickerMaterialVariant.Id> = null;
  private sets: readonly StickerArtCatalog.StickerSetSummary[] = [];
  private currentIndex = 0;
  private bindGeneration = 0;
  private initialSetId: StickerArtCatalog.SetId =
    StickerArtCatalog.DEFAULT_SET_ID;
  private loaded = false;
  private loading = false;

  constructor() {
    super();
    this.$sheet.toggleFullHeight(true);

    this.$prev.bind({
      content: SidebarStickerSection.arrowLabel("←"),
      squarish: true,
      sizePx: 26,
      ariaLabel: "Previous sticker pack",
    });
    this.$next.bind({
      content: SidebarStickerSection.arrowLabel("→"),
      squarish: true,
      sizePx: 26,
      ariaLabel: "Next sticker pack",
    });

    this.$prev.addPointerEvent({ onClick: () => this.pageBy(-1) });
    this.$next.addPointerEvent({ onClick: () => this.pageBy(1) });
  }

  private static arrowLabel(text: string): HTMLElement {
    const $label = document.createElement("span");
    $label.textContent = text;
    $label.setAttribute("aria-hidden", "true");
    return $label;
  }

  bind(vm: SidebarStickerSection.ViewModel): this {
    const initialSetId = vm.initialSetId ?? StickerArtCatalog.DEFAULT_SET_ID;
    const generation = this.bindGeneration + 1;
    this.bindGeneration = generation;
    this.controller = vm.controller;
    this.effectVariant = vm.effectVariant ?? null;
    this.initialSetId = initialSetId;
    this.sets = [];
    this.currentIndex = 0;
    this.loaded = false;
    this.loading = false;
    this.toggleAttribute("loaded", false);
    this.togglePackNav(false);
    this.$position.textContent = "";
    this.$sheet.bindPlaceholder();
    // Sticker packs stay dormant until the user expands the section; viewport
    // visibility alone is part of cold boot for common sidebar layouts. They
    // still hydrate offband so the collapsed palette does not stay empty.
    if (this.hasAttribute("expanded") || this.classList.contains("expanded")) {
      this.activate();
    } else {
      this.scheduleOffbandLoad(generation);
    }
    return this;
  }

  toggleExpanded(force: boolean): boolean {
    const expanded = this.toggleAttribute("expanded", force);
    if (expanded) this.activate();
    return expanded;
  }

  activate(): void {
    this.ensureLoaded();
  }

  private scheduleOffbandLoad(generation: number): void {
    window.setTimeout(() => {
      if (generation !== this.bindGeneration || this.loaded || this.loading) {
        return;
      }
      const run = () => {
        if (
          generation !== this.bindGeneration ||
          this.loaded ||
          this.loading ||
          !this.isConnected
        ) {
          return;
        }
        this.ensureLoaded();
      };
      if (globalThis.requestIdleCallback) {
        globalThis.requestIdleCallback(run, {
          timeout: STICKER_OFFBAND_IDLE_TIMEOUT_MS,
        });
      } else {
        window.setTimeout(run, 0);
      }
    }, STICKER_OFFBAND_LOAD_DELAY_MS);
  }

  onRecycle(): void {
    super.onRecycle();
    this.controller = null;
    this.effectVariant = null;
    this.sets = [];
    this.currentIndex = 0;
    this.initialSetId = StickerArtCatalog.DEFAULT_SET_ID;
    this.loaded = false;
    this.loading = false;
    this.toggleAttribute("loaded", false);
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      this.bindCurrentSet();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    const generation = this.bindGeneration;
    const initialSetId = this.initialSetId;
    this.bindSheet(initialSetId);
    void this.bindSets(generation, initialSetId).then((didLoad) => {
      if (generation !== this.bindGeneration) {
        return;
      }
      this.loaded = didLoad;
      this.loading = false;
      this.toggleAttribute("loaded", didLoad);
    }).catch((err) => {
      if (generation !== this.bindGeneration) return;
      this.loading = false;
      Tracing.warn("ui")(
        `SidebarStickerSection: failed to activate sticker sets: ${err}`,
      );
    });
  }

  private async bindSets(
    generation: number,
    initialSetId: StickerArtCatalog.SetId,
  ): Promise<boolean> {
    const sets = await StickerArtCatalog.setSummaries().catch((err) => {
      Tracing.warn("ui")(
        `SidebarStickerSection: failed to load sticker sets: ${err}`,
      );
      return null;
    });
    if (generation !== this.bindGeneration || !sets || sets.length <= 0) {
      return false;
    }

    this.sets = sets;
    this.currentIndex = Math.max(
      0,
      sets.findIndex((set) => set.id === initialSetId),
    );
    this.bindCurrentSet();
    this.syncPackNav();
    return true;
  }

  private pageBy(delta: number): void {
    if (this.sets.length <= 1) return;
    this.currentIndex =
      (this.currentIndex + delta + this.sets.length) % this.sets.length;
    this.bindCurrentSet();
    this.syncPackNav();
  }

  private bindCurrentSet(): void {
    const set = this.sets[this.currentIndex];
    if (!set) return;
    this.bindSheet(set.id);
  }

  private bindSheet(setId: StickerArtCatalog.SetId): void {
    const controller = this.controller;
    if (!controller) return;
    this.$sheet.bind({
      controller,
      setId,
      effectVariant: this.effectVariant,
    });
  }

  private syncPackNav(): void {
    const count = this.sets.length;
    this.togglePackNav(count > 1);
    this.$position.textContent =
      count > 1 ? `${this.currentIndex + 1} / ${count}` : "";
  }

  private togglePackNav(force: boolean): void {
    this.toggleAttribute("pack-nav-shown", force);
    this.$packNav.setAttribute("aria-hidden", force ? "false" : "true");
  }

  static $styles: Style.Compat[] = [
    Typography.$style,
    css`
      :host {
        display: block;
        width: 100%;
        height: var(--sidebar-sticker-section-height, 420px);
        box-sizing: border-box;
        overflow: visible;
        margin-top: 6px;
      }

      :host([expanded]) {
        height: 100%;
        margin-top: 0px;
        padding-right: 0px;
      }

      #root {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-height: 0px;
        box-sizing: border-box;
      }

      :host([expanded]) #root {
        /* Pill clearance from the shared sidebar token (inherits through the
           shadow boundary from the .expanded host); 60 + safe-area inset. */
        padding-bottom: var(--sidebar-bottom-clearance);
      }

      #pack-nav {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 34px;
        padding: 8px 6px 0px;
        box-sizing: border-box;
        flex-shrink: 0;
        visibility: hidden;
        pointer-events: none;
      }

      :host([pack-nav-shown]) #pack-nav {
        visibility: visible;
        pointer-events: auto;
      }

      #position {
        flex: 1;
        color: var(--text-ter);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      #prev,
      #next {
        --std-icon-background-color: transparent;
        --std-icon-hover-color: var(--bg-hover);
        --std-icon-button-color: var(--fg-icon-sec);
      }

      #sheet {
        flex: 1;
        width: 100%;
        min-height: 0px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-sticker-sheet id="sheet"></std-sticker-sheet>
      <std-row id="pack-nav" role="navigation" aria-label="Sticker packs">
        <std-icon-button id="prev" squarish></std-icon-button>
        <p id="position" class="small"></p>
        <std-icon-button id="next" squarish></std-icon-button>
      </std-row>
    </std-col>
  `;
}

export namespace SidebarStickerSection {
  export type ViewModel = {
    controller: DragDrop.Controller;
  } & Optional<{
    initialSetId: StickerArtCatalog.SetId;
    effectVariant: StickerMaterialVariant.Id;
  }>;
}
