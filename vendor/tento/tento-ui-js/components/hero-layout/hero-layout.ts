import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";

@component({
  name: "std-hero-layout",
})
export class HeroLayout extends LonaWebComponent {
  private static readonly ANIMATION_DURATION_MS = 300;
  private static readonly DRAG_THRESHOLD = 5;

  private selectedIndex: number = 0;
  private previousSelectedIndex: number = 0;
  private previewSize: Size = { width: 60, height: 60 };
  private rowGap: number = 2;
  private gap: number = 2;
  private showScrollbar: boolean = true;
  private showNavBar: boolean = true;
  private overlayNavBar: boolean = true;
  private onChange?: Option<(index: number) => void>;
  private onHover?: Option<(index: Option<number>) => void>;
  private lastHoveredIndex: Option<number> = undefined;

  private $container: HTMLElement = this.$("container");
  private $scrollWrapper: HTMLElement = this.$("scroll-wrapper");
  private $scrollContent: HTMLElement = this.$("scroll-content");
  private $slot: HTMLSlotElement = this.$<HTMLSlotElement>("slot");
  private $customScrollbar: HTMLElement = this.$("custom-scrollbar");
  private $scrollbarThumb: HTMLElement = this.$("scrollbar-thumb");

  private slotElements: HTMLElement[] = [];
  private resizeObserver: Option<ResizeObserver>;
  private pointerDownX: number = 0;
  private pointerDownY: number = 0;
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStartX: number = 0;
  private scrollbarDragStartScrollLeft: number = 0;

  static makeWith(props: HeroLayout.Props): HeroLayout {
    const $element = HeroLayout.make();
    $element.bind(props);
    return $element;
  }

  bind(props: HeroLayout.Props): this {
    const previousShowNavBar = this.showNavBar;
    const navBarToggled = previousShowNavBar !== (props.showNavBar ?? true);
    const shouldAnimate =
      this.selectedIndex !== (props.selectedIndex ?? 0) || navBarToggled;
    this.previousSelectedIndex = this.selectedIndex;
    this.selectedIndex = props.selectedIndex ?? 0;
    this.previewSize = props.previewSize ?? { width: 60, height: 60 };
    this.rowGap = props.rowGap ?? 2;
    this.showScrollbar = props.showScrollbar ?? true;
    this.showNavBar = props.showNavBar ?? true;
    this.overlayNavBar = props.overlayNavBar ?? true;
    this.onChange = props.onChange;
    this.onHover = props.onHover;

    this.updateLayout(shouldAnimate, navBarToggled);
    this.updateScrollbar();
    return this;
  }

  connectedCallback(): void {
    this.resizeObserver = new ResizeObserver(([_e]) =>
      this.updateLayout(false),
    );
    this.resizeObserver.observe(this.$container);

    this.$slot.addEventListener("slotchange", this.handleSlotChange);
    this.handleSlotChange();

    this.$scrollWrapper.addEventListener("scroll", this.handleScroll, {
      passive: true,
    });
    this.$scrollWrapper.addEventListener(
      "pointerdown",
      this.handleScrollWrapperPointerDown,
    );
    this.$scrollWrapper.addEventListener(
      "pointerup",
      this.handleScrollWrapperPointerUp,
    );

    this.$scrollbarThumb.addEventListener(
      "pointerdown",
      this.handleScrollbarPointerDown,
    );
    document.addEventListener("pointermove", this.handleScrollbarPointerMove);
    document.addEventListener("pointerup", this.handleScrollbarPointerUp);

    this.$scrollWrapper.addEventListener(
      "pointermove",
      this.handleScrollWrapperPointerMove,
    );
    this.$scrollWrapper.addEventListener(
      "pointerleave",
      this.handleScrollWrapperPointerLeave,
    );
  }

  disconnectedCallback(): void {
    this.$slot.removeEventListener("slotchange", this.handleSlotChange);
    this.$scrollWrapper.removeEventListener("scroll", this.handleScroll);
    this.$scrollWrapper.removeEventListener(
      "pointerdown",
      this.handleScrollWrapperPointerDown,
    );
    this.$scrollWrapper.removeEventListener(
      "pointerup",
      this.handleScrollWrapperPointerUp,
    );
    this.$scrollbarThumb.removeEventListener(
      "pointerdown",
      this.handleScrollbarPointerDown,
    );
    document.removeEventListener(
      "pointermove",
      this.handleScrollbarPointerMove,
    );
    document.removeEventListener("pointerup", this.handleScrollbarPointerUp);
    this.$scrollWrapper.removeEventListener(
      "pointermove",
      this.handleScrollWrapperPointerMove,
    );
    this.$scrollWrapper.removeEventListener(
      "pointerleave",
      this.handleScrollWrapperPointerLeave,
    );
    this.resizeObserver?.disconnect();
  }

  private handleScroll = (): void => {
    if (this.isDraggingScrollbar) return;
    const scrollLeft = this.$scrollWrapper.scrollLeft;
    this.$container.style.setProperty("--scroll-offset", `${-scrollLeft}px`);
    this.updateScrollbar();
  };

  private handleScrollbarPointerDown = (e: PointerEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    this.isDraggingScrollbar = true;
    this.scrollbarDragStartX = e.clientX;
    this.scrollbarDragStartScrollLeft = this.$scrollWrapper.scrollLeft;
    document.body.style.userSelect = "none";
  };

  private handleScrollbarPointerMove = (e: PointerEvent): void => {
    if (!this.isDraggingScrollbar) return;

    const deltaX = e.clientX - this.scrollbarDragStartX;
    const scrollWidth = this.$scrollWrapper.scrollWidth;
    const clientWidth = this.$scrollWrapper.clientWidth;
    const scrollRatio = scrollWidth / clientWidth;
    const scrollDelta = deltaX * scrollRatio;

    this.$scrollWrapper.scrollLeft =
      this.scrollbarDragStartScrollLeft + scrollDelta;

    const scrollLeft = this.$scrollWrapper.scrollLeft;
    this.$container.style.setProperty("--scroll-offset", `${-scrollLeft}px`);
    this.updateScrollbar();
  };

  private handleScrollbarPointerUp = (): void => {
    if (!this.isDraggingScrollbar) return;
    this.isDraggingScrollbar = false;
    document.body.style.userSelect = "";
  };

  private handleScrollWrapperPointerDown = (e: PointerEvent): void => {
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
  };

  private handleScrollWrapperPointerUp = (e: PointerEvent): void => {
    const deltaX = Math.abs(e.clientX - this.pointerDownX);
    const deltaY = Math.abs(e.clientY - this.pointerDownY);

    if (
      deltaX > HeroLayout.DRAG_THRESHOLD ||
      deltaY > HeroLayout.DRAG_THRESHOLD
    ) {
      return;
    }

    const layout = this.calculateLayoutMetrics();
    const clickX = e.clientX - this.$scrollWrapper.getBoundingClientRect().left;
    const scrollLeft = this.$scrollWrapper.scrollLeft;

    let currentPos = 0;
    for (let i = 0; i < this.slotElements.length; i++) {
      const item = this.slotElements[i] as HeroLayout.Item;
      if (i === this.selectedIndex) {
        continue;
      }

      const itemWidth = layout.scaledPreviewWidth;
      const itemStart = currentPos;
      const itemEnd = currentPos + itemWidth;

      if (scrollLeft + clickX >= itemStart && scrollLeft + clickX < itemEnd) {
        if (item.isStatic) {
          item.onClick?.();
        } else {
          this.onChange?.(i);
        }
        return;
      }

      currentPos += itemWidth + this.gap;
    }
  };

  private handleScrollWrapperPointerMove = (e: PointerEvent): void => {
    if (!this.showNavBar) return;

    const layout = this.calculateLayoutMetrics();
    const hoverX = e.clientX - this.$scrollWrapper.getBoundingClientRect().left;
    const scrollLeft = this.$scrollWrapper.scrollLeft;

    let currentPos = 0;
    for (let i = 0; i < this.slotElements.length; i++) {
      if (i === this.selectedIndex) continue;

      const item = this.slotElements[i] as HeroLayout.Item;
      const itemWidth = item.isStatic && item.aspectRatio
        ? this.previewSize.height * item.aspectRatio
        : layout.scaledPreviewWidth;
      const itemStart = currentPos;
      const itemEnd = currentPos + itemWidth;

      if (scrollLeft + hoverX >= itemStart && scrollLeft + hoverX < itemEnd) {
        if (this.lastHoveredIndex !== i) {
          this.lastHoveredIndex = i;
          this.onHover?.(i);
        }
        return;
      }

      currentPos += itemWidth + this.gap;
    }

    if (this.lastHoveredIndex !== undefined) {
      this.lastHoveredIndex = undefined;
      this.onHover?.(undefined);
    }
  };

  private handleScrollWrapperPointerLeave = (): void => {
    if (this.lastHoveredIndex !== undefined) {
      this.lastHoveredIndex = undefined;
      this.onHover?.(undefined);
    }
  };

  private handleSlotChange = (): void => {
    this.slotElements = Array.from(
      this.$slot.assignedElements() as HTMLElement[],
    );
    this.updateLayout(false);
  };

  private calculateLayoutMetrics() {
    const containerWidth = this.$container.offsetWidth;

    // Calculate ideal hero dimensions based on preview aspect ratio
    const aspectRatio = this.previewSize.width / this.previewSize.height;
    const heroWidth = containerWidth;
    const heroHeight = heroWidth / aspectRatio;

    // Determine available space accounting for navbar when visible
    const hasExplicitHeight = this.style.height && this.style.height !== "auto";
    const scrollbarHeight = this.showScrollbar ? 10 : 0;
    const scrollbarMarginTop = this.showScrollbar ? 2 : 0;
    const navBarHeight =
      this.previewSize.height + scrollbarMarginTop + scrollbarHeight;
    const layoutNavBarHeight = this.showNavBar ? navBarHeight : 0;
    const layoutRowGap = this.showNavBar ? this.rowGap : 0;

    const style = getComputedStyle(this);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const containerHeight = hasExplicitHeight
      ? this.clientHeight - paddingTop - paddingBottom
      : 0;

    // Calculate available space for hero
    // When overlayNavBar is true, navbar space is subtracted even in auto-height mode
    const shouldSubtractNavBar = this.overlayNavBar && this.showNavBar;
    const availableHeroHeight = hasExplicitHeight
      ? containerHeight - layoutNavBarHeight - layoutRowGap
      : shouldSubtractNavBar
        ? heroHeight - layoutNavBarHeight - layoutRowGap
        : heroHeight;

    // Scale hero down to fit available space
    const heroScale =
      hasExplicitHeight || shouldSubtractNavBar
        ? Math.min(1, availableHeroHeight / heroHeight)
        : 1;

    // Calculate actual hero dimensions after scaling
    const actualHeroWidth = heroWidth * heroScale;
    const actualHeroHeight = heroHeight * heroScale;

    // Center hero horizontally and position vertically based on navbar visibility
    const heroCenterX = (containerWidth - actualHeroWidth) / 2;
    const heroCenterY = this.showNavBar
      ? hasExplicitHeight
        ? (availableHeroHeight - actualHeroHeight) / 2
        : 0
      : hasExplicitHeight
        ? (containerHeight - actualHeroHeight) / 2
        : this.overlayNavBar
          ? 0
          : navBarHeight / 2;

    // Calculate how much to scale preview items to fit in navbar
    const previewScale = Math.min(
      this.previewSize.width / actualHeroWidth,
      this.previewSize.height / actualHeroHeight,
    );

    // Width of each preview in navbar after scaling
    const scaledPreviewWidth = actualHeroWidth * previewScale;
    const navYPos = availableHeroHeight + layoutRowGap;

    return {
      containerWidth,
      containerHeight,
      heroWidth,
      heroHeight,
      heroScale,
      actualHeroWidth,
      actualHeroHeight,
      heroCenterX,
      heroCenterY,
      previewScale,
      scaledPreviewWidth,
      navBarHeight,
      layoutNavBarHeight,
      navYPos,
      hasExplicitHeight,
      scrollbarHeight,
      scrollbarMarginTop,
    };
  }

  private updateLayout(animate: boolean, navBarToggled: boolean = false): void {
    if (this.slotElements.length === 0) return;

    const totalItems = this.slotElements.length;
    const layout = this.calculateLayoutMetrics();

    this.updateContainerDimensions(layout);
    const itemsToAnimate = this.getItemsToAnimate(
      animate,
      totalItems,
      navBarToggled,
    );
    this.updateItemTransforms(animate, itemsToAnimate, layout);
    this.updateScrollbar();
  }

  private updateScrollbar(): void {
    if (!this.showScrollbar) {
      return;
    }

    const scrollWidth = this.$scrollWrapper.scrollWidth;
    const clientWidth = this.$scrollWrapper.clientWidth;
    const scrollLeft = this.$scrollWrapper.scrollLeft;

    if (scrollWidth <= clientWidth) {
      return;
    }

    const thumbWidth = (clientWidth / scrollWidth) * clientWidth;
    const thumbLeft = (scrollLeft / scrollWidth) * clientWidth;

    this.$scrollbarThumb.assignStyles({
      width: `${thumbWidth}px`,
      transform: `translateX(${thumbLeft}px)`,
    });
  }

  private updateContainerDimensions(
    layout: ReturnType<typeof this.calculateLayoutMetrics>,
  ): void {
    let totalWidth = 0;
    let navItemCount = 0;

    for (let i = 0; i < this.slotElements.length; i++) {
      if (i === this.selectedIndex) continue;

      const item = this.slotElements[i] as HeroLayout.Item;
      const itemWidth =
        item.isStatic && item.aspectRatio
          ? this.previewSize.height * item.aspectRatio
          : layout.scaledPreviewWidth;

      if (navItemCount > 0) {
        totalWidth += this.gap;
      }
      totalWidth += itemWidth;
      navItemCount++;
    }

    if (!layout.hasExplicitHeight) {
      // When overlayNavBar is true, maintain aspect ratio (don't add navbar height)
      const desiredHeight = this.overlayNavBar
        ? layout.heroHeight
        : layout.actualHeroHeight + this.rowGap + layout.navBarHeight;
      this.$container.style.height = `${desiredHeight}px`;
    } else {
      this.$container.style.height = `${layout.containerHeight}px`;
    }

    const scrollWrapperTop = layout.hasExplicitHeight
      ? layout.containerHeight - layout.layoutNavBarHeight
      : layout.actualHeroHeight + this.rowGap;

    const showNavElements = this.showNavBar;

    this.$scrollWrapper.assignStyles({
      top: `${scrollWrapperTop}px`,
      height: `${this.previewSize.height}px`,
      width: `${layout.containerWidth}px`,
      opacity: showNavElements ? "1" : "0",
      transform: showNavElements ? "translateY(0)" : "translateY(10px)",
      pointerEvents: showNavElements ? "auto" : "none",
    });

    this.$scrollContent.assignStyles({
      width: `${totalWidth}px`,
      height: `${this.previewSize.height}px`,
    });

    this.$customScrollbar.assignStyles({
      bottom: "0px",
      height: `${layout.scrollbarHeight}px`,
      opacity: showNavElements && this.showScrollbar ? "1" : "0",
      pointerEvents: showNavElements && this.showScrollbar ? "auto" : "none",
    });
  }

  private getItemsToAnimate(
    animate: boolean,
    totalItems: number,
    navBarToggled: boolean,
  ): HTMLElement[] {
    if (!animate) return [];

    if (navBarToggled) {
      return this.slotElements;
    }

    const items: HTMLElement[] = [];
    if (
      this.previousSelectedIndex >= 0 &&
      this.previousSelectedIndex < totalItems
    ) {
      items.push(this.slotElements[this.previousSelectedIndex]);
    }
    if (this.selectedIndex >= 0 && this.selectedIndex < totalItems) {
      items.push(this.slotElements[this.selectedIndex]);
    }
    return items;
  }

  private updateItemTransforms(
    animate: boolean,
    itemsToAnimate: HTMLElement[],
    layout: ReturnType<typeof this.calculateLayoutMetrics>,
  ): void {
    let navIndex = 0;
    for (let i = 0; i < this.slotElements.length; i++) {
      const $item = this.slotElements[i];
      const oldTransform = $item.style.transform;
      const item = $item as HeroLayout.Item;

      const isSelected = !item.isStatic && i === this.selectedIndex;
      const shouldAnimateThisItem = animate && itemsToAnimate.includes($item);

      const newTransform = this.calculateTransform(i, navIndex, layout, item);
      const navItemTranslate = this.showNavBar ? "" : " translateY(10px)";
      const finalTransform = isSelected
        ? newTransform
        : `${newTransform}${navItemTranslate}`;

      const { width, height, scale } = this.calculateItemDimensions(
        item,
        isSelected,
        layout,
      );

      $item.assignStyles({
        position: "absolute",
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: isSelected ? "auto" : "none",
        transformOrigin: "top left",
        opacity: isSelected ? "1" : this.showNavBar ? "1" : "0",
        "--scale": String(scale),
        "--selected": String(isSelected ? 1 : 0),
        "--not-selected": String(isSelected ? 0 : 1),
      });

      $item.setAttribute("scale", scale.toString());
      if (shouldAnimateThisItem) {
        $item.setAttribute("animate", "true");
      }

      if (!isSelected) {
        navIndex++;
      }

      $item.style.transform = finalTransform;

      if (
        shouldAnimateThisItem &&
        oldTransform &&
        oldTransform !== finalTransform
      ) {
        $item.animate(
          [{ transform: oldTransform }, { transform: finalTransform }],
          {
            duration: HeroLayout.ANIMATION_DURATION_MS,
            easing: "ease",
          },
        );
        setTimeout(
          () => $item.removeAttribute("animate"),
          HeroLayout.ANIMATION_DURATION_MS,
        );
      }
    }
  }

  private calculateItemDimensions(
    item: HeroLayout.Item,
    isSelected: boolean,
    layout: ReturnType<typeof this.calculateLayoutMetrics>,
  ): { width: number; height: number; scale: number } {
    if (item.isStatic && item.aspectRatio) {
      const height = this.previewSize.height;
      const width = height * item.aspectRatio;
      return { width, height, scale: 1 };
    }

    if (isSelected) {
      return {
        width: layout.heroWidth,
        height: layout.heroHeight,
        scale: layout.heroScale,
      };
    }

    return {
      width: layout.heroWidth,
      height: layout.heroHeight,
      scale: layout.heroScale * layout.previewScale,
    };
  }

  private calculateTransform(
    index: number,
    navIndex: number,
    layout: ReturnType<typeof this.calculateLayoutMetrics>,
    item: HeroLayout.Item,
  ): string {
    if (!item.isStatic && index === this.selectedIndex) {
      return `translate(${layout.heroCenterX}px, ${layout.heroCenterY}px) scale(${layout.heroScale})`;
    }

    const xPos = navIndex * (layout.scaledPreviewWidth + this.gap);
    const scale = item.isStatic ? 1 : layout.heroScale * layout.previewScale;
    return `translate(calc(var(--scroll-offset, 0px) + ${xPos}px), ${layout.navYPos}px) scale(${scale})`;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        overflow: hidden;
      }

      .container {
        width: 100%;
        position: relative;
      }

      .scroll-wrapper {
        position: absolute;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        cursor: pointer;
        scrollbar-width: none;
        transition: opacity 0.3s ease, transform 0.3s ease;
      }

      .scroll-wrapper::-webkit-scrollbar {
        display: none;
      }

      .scroll-content {
        pointer-events: none;
      }

      .custom-scrollbar {
        position: absolute;
        left: 0;
        right: 0;
        background: var(--scrollbar-bg, var(--divider));
        border-radius: 8px;
        transition: opacity 0.3s ease;
      }

      .scrollbar-thumb {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: var(--scrollbar-thumb-bg, var(--text-ter));
        border-radius: 8px;
        cursor: pointer;
      }

      .scrollbar-thumb:hover {
        background: var(--scrollbar-thumb-bg-hover, var(--text-sec));
      }

      .controls-container {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .controls-container:empty {
        display: none;
      }
    `,
  ];

  static $html = html`
    <div id="container" class="container">
      <slot id="slot"></slot>
      <div id="controls-container" class="controls-container">
        <slot name="controls"></slot>
      </div>
      <div id="scroll-wrapper" class="scroll-wrapper">
        <div id="scroll-content" class="scroll-content"></div>
      </div>
      <div id="custom-scrollbar" class="custom-scrollbar">
        <div id="scrollbar-thumb" class="scrollbar-thumb"></div>
      </div>
    </div>
  `;
}

export namespace HeroLayout {
  export interface Props {
    selectedIndex?: number;
    previewSize?: Size;
    rowGap?: number;
    showScrollbar?: boolean;
    showNavBar?: boolean;
    overlayNavBar?: boolean;
    onChange?: Option<(index: number) => void>;
    onHover?: Option<(index: Option<number>) => void>;
  }

  export function calculateSquarePreviewSize(
    containerWidth: number,
    containerHeight: number,
    totalItems: number,
    gap: number = 2,
    rowGap: number = 2,
  ): Size {
    const numPreviews = totalItems - 1;
    const totalGapWidth = (numPreviews - 1) * gap;

    const previewFromWidth = (containerWidth - totalGapWidth) / numPreviews;
    const previewFromHeight = containerHeight - containerWidth - rowGap;

    const previewDimension = Math.min(previewFromWidth, previewFromHeight);

    return {
      width: previewDimension,
      height: previewDimension,
    };
  }

  export function calculatePreviewWidthFromHeight(
    containerWidth: number,
    containerHeight: number,
    previewHeight: number,
    rowGap: number = 2,
  ): number {
    const heroHeight = containerHeight - rowGap - previewHeight;
    const previewWidth = (containerWidth * previewHeight) / heroHeight;
    return previewWidth;
  }

  @component({ name: "std-hero-layout-item" })
  export class Item extends LonaWebComponent {
    static observedAttributes = ["scale", "animate"];

    private borderRadius: number = 12;
    private overflow: string = "hidden";
    private currentScale: number = 1;
    private shouldAnimate: boolean = false;
    public isStatic: boolean = false;
    public aspectRatio?: number | undefined;
    public onClick?: Option<() => void>;

    static makeWith(props: Item.Props): Item {
      const $element = Item.make();
      $element.bind(props);
      return $element;
    }

    bind(props: Item.Props): this {
      this.borderRadius = props.borderRadius ?? 12;
      this.overflow = props.overflow ?? "hidden";
      this.style.overflow = this.overflow;
      this.isStatic = props.isStatic ?? false;
      this.aspectRatio = props.aspectRatio;
      this.onClick = props.onClick;
      this.updateBorderRadius();
      return this;
    }

    attributeChangedCallback(
      name: string,
      _oldValue: string,
      newValue: string,
    ): void {
      if (name === "scale") {
        this.currentScale = Number.parseFloat(newValue) || 1;
        this.updateBorderRadius();
      } else if (name === "animate") {
        this.shouldAnimate = newValue !== null;
        this.updateBorderRadius();
      }
    }

    private updateBorderRadius(): void {
      const scaledRadius = this.borderRadius / this.currentScale;
      this.assignStyles({
        borderRadius: `${scaledRadius}px`,
        transition: this.shouldAnimate
          ? "border-radius 0.3s ease, opacity 0.3s ease, transform 0.3s ease"
          : "opacity 0.3s ease",
      });
    }

    static $styles: Style.Compat[] = [
      css`
        :host {
          display: block;
          width: 100%;
          height: 100%;
        }
      `,
    ];
    static $html = html`<slot></slot>`;
  }

  export namespace Item {
    export interface Props {
      borderRadius?: number;
      overflow?: string;
      isStatic?: boolean;
      aspectRatio?: number;
      onClick?: Option<() => void>;
    }
  }
}
