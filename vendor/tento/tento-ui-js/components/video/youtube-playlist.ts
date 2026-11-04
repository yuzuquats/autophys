import "@tento-ui/components/hero-layout/hero-layout";
import "@tento-ui/components/video/youtube-player";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { HeroLayout } from "../hero-layout/hero-layout";
import { CarouselIndicator } from "../carousel/carousel-indicator";
import { YoutubePlayer } from "./youtube-player";
import { YoutubeUrl } from "./youtube-url";

@component({
  name: "std-youtube-playlist",
})
export class YoutubePlaylist extends LonaWebComponent {
  private $heroLayout: HeroLayout = this.hydrate<HeroLayout>("hero-layout");

  private urls: YoutubeUrl[] = [];
  private selectedIndex: number = 0;
  private showNavBar: boolean = false;
  private overlayNavBar: boolean = true;
  private showIndicator: boolean = false;
  private showAddButton: boolean = false;
  private onChange?: Option<(index: number) => void>;
  private onAdd?: Option<() => void>;
  private loadedPlayers: Map<number, YoutubePlayer> = new Map();
  private thumbnailCleanups: (() => void)[] = [];
  private lastSetHeight: number = 0;
  private hoverCleanup?: () => void;
  private $indicator?: CarouselIndicator;

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    const hasExplicitHeight =
      this.style.height &&
      this.style.height !== "" &&
      this.style.height !== "auto";

    if (
      hasExplicitHeight &&
      size.height > 0 &&
      size.height !== this.lastSetHeight
    ) {
      this.lastSetHeight = size.height;
      this.$heroLayout.style.height = `${size.height}px`;
      this.updateHeroLayout();
    }
  };

  static makeWith(props: YoutubePlaylist.Props): YoutubePlaylist {
    const $element = YoutubePlaylist.make();
    $element.bind(props);
    return $element;
  }

  connectedCallback(): void {
    super.connectedCallback();

    const handlePointerEnter = () => {
      if (this.$indicator) {
        this.$indicator.style.opacity = "1";
      }
    };

    const handlePointerLeave = () => {
      if (this.$indicator) {
        this.$indicator.style.opacity = "0";
      }
    };

    this.addEventListener("pointerenter", handlePointerEnter);
    this.addEventListener("pointerleave", handlePointerLeave);

    this.hoverCleanup = () => {
      this.removeEventListener("pointerenter", handlePointerEnter);
      this.removeEventListener("pointerleave", handlePointerLeave);
    };
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cleanupThumbnails();
    this.hoverCleanup?.();
  }

  bind(props: YoutubePlaylist.Props): this {
    this.urls = props.urls ?? [];
    this.selectedIndex = props.selectedIndex ?? 0;
    this.showNavBar = props.showNavBar ?? false;
    this.overlayNavBar = props.overlayNavBar ?? true;
    this.showIndicator = props.showIndicator ?? false;
    this.showAddButton = props.showAddButton ?? false;
    this.onChange = props.onChange;
    this.onAdd = props.onAdd;
    this.lastSetHeight = 0;

    this.cleanupThumbnails();
    this.loadedPlayers.clear();

    this.$heroLayout.bind(this.getHeroLayoutProps());

    DomUtils.clearChildren(this.$heroLayout);

    this.createItems();
    this.createAddButton();
    this.createIndicator();

    return this;
  }

  private cleanupThumbnails(): void {
    for (const cleanup of this.thumbnailCleanups) cleanup();
    this.thumbnailCleanups = [];
  }

  private getHeroLayoutProps(): HeroLayout.Props {
    return {
      selectedIndex: this.selectedIndex,
      previewSize: { width: 120, height: 68 },
      rowGap: 2,
      showScrollbar: true,
      showNavBar: this.showNavBar,
      overlayNavBar: this.overlayNavBar,
      onChange: (index) => this.handleIndexChange(index),
    };
  }

  private updateHeroLayout(): void {
    this.$heroLayout.bind(this.getHeroLayoutProps());
  }

  private handleIndexChange(index: number): void {
    const previousIndex = this.selectedIndex;
    const previousPlayer = this.loadedPlayers.get(previousIndex);

    if (previousPlayer) {
      previousPlayer.pause();
    }

    this.selectedIndex = index;
    this.onChange?.(index);
    this.updateHeroLayout();
  }

  private createItems(): void {
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[i];
      const $item = HeroLayout.Item.makeWith({
        borderRadius: 12,
        isStatic: false,
      });
      const $container = this.createThumbnail(url, i);
      $item.appendChild($container);
      this.$heroLayout.appendChild($item);
    }
  }

  private createAddButton(): void {
    if (!this.showAddButton) return;

    const $addButton = document.createElement("std-center");
    $addButton.assignStyles({
      width: "100%",
      height: "100%",
      background: "var(--add-button-bg, var(--bg-surface-light))",
      fontSize: "32px",
      color: "var(--add-button-color, var(--fg-icon-pri))",
    });
    $addButton.textContent = "+";

    const $item = HeroLayout.Item.makeWith({
      borderRadius: 12,
      isStatic: true,
      aspectRatio: 1,
      onClick: () => this.onAdd?.(),
    });
    $item.appendChild($addButton);
    this.$heroLayout.appendChild($item);
  }

  private createIndicator(): void {
    if (!this.showIndicator || this.urls.length === 0) return;

    this.$indicator = CarouselIndicator.makeWith({
      count: this.urls.length,
      isExpanded: this.showNavBar,
      onToggle: (isExpanded) => {
        this.showNavBar = isExpanded;
        this.updateHeroLayout();
      },
      onEdit: () => this.onAdd?.(),
    });
    this.$indicator.slot = "controls";
    this.$indicator.style.opacity = "0";
    this.$indicator.style.transition = "opacity 0.3s ease";
    this.$heroLayout.appendChild(this.$indicator);
  }

  private createThumbnail(url: YoutubeUrl, index: number): HTMLElement {
    const videoId = YoutubeUrl.extractVideoId(url.url.toString());

    const $container = document.createElement("std-col");
    $container.assignStyles({
      width: "100%",
      height: "100%",
      position: "relative",
      cursor: "pointer",
      background: "black",
    });

    if (videoId) {
      const $img = document.createElement("img");
      const cleanup = this.setThumbnailWithFallback($img, videoId);
      this.thumbnailCleanups.push(cleanup);
      $img.assignStyles({
        width: "100%",
        height: "100%",
        objectFit: "cover",
      });

      const $playButton = this.createPlayButton();

      $container.appendChild($img);
      $container.appendChild($playButton);

      $container.addEventListener("click", () => {
        this.loadPlayer(index, $container);
      });
    }

    return $container;
  }

  private setThumbnailWithFallback(
    $img: HTMLImageElement,
    videoId: string,
  ): () => void {
    const qualities = ["maxresdefault", "sddefault", "hqdefault", "mqdefault"];
    let currentQualityIndex = 0;
    let isValid = true;

    const tryNextQuality = () => {
      if (!isValid || currentQualityIndex >= qualities.length) return;
      const quality = qualities[currentQualityIndex];
      $img.src = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
    };

    $img.addEventListener("error", () => {
      if (!isValid) return;
      currentQualityIndex++;
      tryNextQuality();
    });

    $img.addEventListener("load", () => {
      if (!isValid) return;
      if ($img.naturalWidth === 120 && $img.naturalHeight === 90) {
        currentQualityIndex++;
        tryNextQuality();
      }
    });

    tryNextQuality();

    return () => {
      isValid = false;
    };
  }

  private createPlayButton(): HTMLElement {
    const $playButton = document.createElement("std-col");
    $playButton.assignStyles({
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "80px",
      height: "80px",
      background: "rgba(0, 0, 0, 0.7)",
      borderRadius: "50%",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
    });

    const $triangle = document.createElement("div");
    $triangle.style.width = "0";
    $triangle.style.height = "0";
    $triangle.style.borderLeft = "24px solid white";
    $triangle.style.borderTop = "16px solid transparent";
    $triangle.style.borderBottom = "16px solid transparent";
    $triangle.style.marginLeft = "6px";

    $playButton.appendChild($triangle);
    return $playButton;
  }

  private async loadPlayer(
    index: number,
    $container: HTMLElement,
  ): Promise<void> {
    if (this.loadedPlayers.has(index)) return;

    const url = this.urls[index];

    DomUtils.clearChildren($container);

    const containerWidth = $container.offsetWidth;
    const $player = YoutubePlayer.make();
    $player.bind(url.url.toString(), containerWidth);
    $container.appendChild($player);
    $container.style.cursor = "default";

    this.loadedPlayers.set(index, $player);

    await $player.play();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        --add-button-bg: var(--bg-surface-light);
        --add-button-color: var(--fg-icon-pri);
      }

      #hero-layout {
        width: 100%;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-hero-layout id="hero-layout"></std-hero-layout>
  `;
}

export namespace YoutubePlaylist {
  export interface Props {
    urls?: YoutubeUrl[];
    selectedIndex?: number;
    showNavBar?: boolean;
    overlayNavBar?: boolean;
    showIndicator?: boolean;
    showAddButton?: boolean;
    onChange?: Option<(index: number) => void>;
    onAdd?: Option<() => void>;
  }
}
