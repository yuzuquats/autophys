import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { MathUtils } from "@tento-core/math";

type CarouselCallbacks = {
  onScroll: (fromIdx: number, toIdx: number, duration?: Option<number>) => void;
};

@component({ name: "std-carousel" })
export class Carousel extends LonaWebComponent {
  private _currentPageIndex = 0;
  private updateGeneration = 0;
  private $pages: HTMLElement[] = [];
  callbacks?: Optional<CarouselCallbacks>;
  pageStopIdx = 0;
  private animations = new Map<HTMLElement, Animation>();
  private motion?: MediaQueryList;
  private suppressClick = false;
  private drag?: {
    id: number;
    x: number;
    y: number;
    width: number;
    start: number;
    horizontal: boolean;
    progress: number;
    userSelect: string;
  };
  private pageAttributes = new Map<HTMLElement, Map<string, string | null>>();

  get currentPageIndex(): number {
    return this._currentPageIndex;
  }

  private stopCount(value: number, count = this.$pages.length): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new RangeError("Carousel stop count must be a nonnegative integer");
    }
    return Math.min(value, count);
  }

  private bounded(idx: number, stop: number): number {
    return stop === 0 ? 0 : MathUtils.clampInc(idx, 0, stop - 1);
  }

  // Binding replaces the inventory. Reject unsupported nodes before touching it.
  domBind(
    pages: Array<HTMLElement | Node>,
    pageStopIdx = pages.length,
    callbacks?: Optional<CarouselCallbacks>,
  ) {
    const inventory = [...pages];
    if (
      inventory.some((page) => !(page instanceof HTMLElement)) ||
      new Set(inventory).size !== inventory.length
    ) {
      throw new TypeError("Carousel pages must be distinct HTMLElements");
    }
    const stop = this.stopCount(pageStopIdx, inventory.length);
    const container = this.$("page-container");
    if (
      inventory.some((page) =>
        page === this || page === container || page.contains(this) ||
        page.contains(container)
      )
    ) {
      throw new TypeError("Carousel pages cannot contain the carousel");
    }
    const generation = ++this.updateGeneration;
    this.endDrag(false, undefined, false, false);
    if (generation !== this.updateGeneration) return;
    this.cancelAnimations();
    if (this.$pages.some((page) => page.matches(":focus-within"))) {
      this.focus({ preventScroll: true });
      if (generation !== this.updateGeneration) return;
    }
    this.restorePages();
    this.$pages = inventory as HTMLElement[];
    this.pageStopIdx = stop;
    this.callbacks = callbacks;
    container.replaceChildren(...inventory);
    for (const page of this.$pages) {
      this.pageAttributes.set(
        page,
        new Map(
          [
            "class",
            "inert",
            "aria-hidden",
            "role",
            "aria-roledescription",
            "aria-label",
          ]
            .map((name) => [name, page.getAttribute(name)]),
        ),
      );
      this.pageAttributes.get(page)!.set(
        "transform",
        page.style.getPropertyValue("transform"),
      );
      this.pageAttributes.get(page)!.set(
        "transform-priority",
        page.style.getPropertyPriority("transform"),
      );
      page.classList.add("page");
    }
    this.setPage(Math.round(this._currentPageIndex), stop, false);
  }

  private restorePages() {
    for (const [page, attributes] of this.pageAttributes) {
      for (const [name, value] of attributes) {
        if (name === "class") {
          if (!value?.split(/\s+/).includes("page")) {
            page.classList.remove("page");
          }
          continue;
        }
        if (name === "transform") {
          page.style.setProperty(
            "transform",
            value ?? "",
            attributes.get("transform-priority") ?? "",
          );
          continue;
        }
        if (name === "transform-priority") continue;
        if (value === null) page.removeAttribute(name);
        else page.setAttribute(name, value);
      }
    }
    this.pageAttributes.clear();
  }

  connectedCallback() {
    super.connectedCallback();
    for (
      const [name, value] of [["tabindex", "0"], ["role", "region"], [
        "aria-label",
        "Carousel",
      ]]
    ) {
      if (
        !this.hasAttribute(name) &&
        !(name === "aria-label" && this.hasAttribute("aria-labelledby"))
      ) {
        this.setAttribute(name, value);
      }
    }
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener("change", this.handleMotion);
    this.addEventListener("keydown", this.handleKeydown);
    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("click", this.handleClick, true);
    this.addEventListener("lostpointercapture", this.handleLostCapture);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    try {
      this.endDrag(false);
    } finally {
      this.cancelAnimations();
      this.motion?.removeEventListener("change", this.handleMotion);
      this.removeEventListener("keydown", this.handleKeydown);
      this.removeEventListener("pointerdown", this.handlePointerDown);
      this.removeEventListener("click", this.handleClick, true);
      this.removeEventListener("lostpointercapture", this.handleLostCapture);
    }
  }

  private handleMotion = () => {
    if (this.motion?.matches) this.cancelAnimations();
  };
  private cancelAnimations() {
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
  }

  private interactivePath(e: Event): boolean {
    for (const node of e.composedPath()) {
      if (node === this) break;
      if (
        node instanceof HTMLElement &&
        (node.isContentEditable || node.matches(
          "input,textarea,select,button,a[href],summary,audio,video,[tabindex],std-carousel",
        ) || (node.hasAttribute("role") &&
          (!this.$pages.includes(node) || this.pageAttributes.get(node)?.get("role") != null)))
      ) return true;
    }
    return false;
  }

  private handleKeydown = (e: KeyboardEvent) => {
    if (
      e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey
    ) return;
    if (e.key === "Escape" && this.drag) {
      e.preventDefault();
      this.endDrag(true);
      return;
    }
    if (this.interactivePath(e)) return;
    // Left/right retain the existing logical previous/next convention in RTL.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (e.key === "ArrowLeft") this.previousPage();
      else this.nextPage();
    }
  };

  private handleClick = (e: MouseEvent) => {
    if (this.suppressClick && e.detail > 0) {
      this.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };
  private handlePointerDown = (e: PointerEvent) => {
    this.suppressClick = false;
    if (
      this.drag || e.defaultPrevented || e.button !== 0 || !e.isPrimary ||
      this.interactivePath(e)
    ) return;
    const width = this.$pages[0]?.offsetWidth ?? 0;
    if (!(width > 0) || this.stopCount(this.pageStopIdx) < 2) return;
    e.stopPropagation();
    // Observe until horizontal intent is known; do not capture or suppress a tap/vertical scroll.
    this.drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      width,
      start: this._currentPageIndex,
      horizontal: false,
      progress: 0,
      userSelect: this.style.userSelect,
    };
    window.addEventListener("pointermove", this.handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
    window.addEventListener("keydown", this.handleDragKeydown, true);
    window.addEventListener("blur", this.handlePointerCancel);
  };
  private handleDragKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.drag) {
      e.preventDefault();
      e.stopPropagation();
      this.endDrag(true);
    }
  };
  private handlePointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.id) return;
    const dx = drag.x - e.clientX, dy = drag.y - e.clientY;
    if (!drag.horizontal) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        this.endDrag(false);
        return;
      }
      if (this.animations.size) {
        const displayed = new DOMMatrixReadOnly(
          getComputedStyle(this.$pages[0]).transform,
        );
        drag.start = this.bounded(
          -displayed.m41 / drag.width,
          this.stopCount(this.pageStopIdx),
        );
      }
      drag.horizontal = true;
      this.suppressClick = true;
      this.style.userSelect = "none";
      try {
        this.setPointerCapture(drag.id);
      } catch { /* Window listeners still own settlement. */ }
    }
    e.preventDefault();
    e.stopPropagation();
    drag.progress = dx / drag.width;
    this.renderPage(
      drag.start + drag.progress,
      this.stopCount(this.pageStopIdx),
      false,
      0,
      "ease",
    );
  };
  private handlePointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.horizontal) {
      this.endDrag(false);
      return;
    }
    drag.progress = (drag.x - e.clientX) / drag.width;
    const progress = drag.start + drag.progress;
    const target = drag.progress > 0
      ? (progress % 1 > .15 ? Math.ceil(progress) : Math.floor(progress))
      : (progress % 1 < .85 ? Math.floor(progress) : Math.ceil(progress));
    this.endDrag(false, target, true);
  };
  private handlePointerCancel = (e: Event) => {
    if (e instanceof PointerEvent && e.pointerId !== this.drag?.id) return;
    this.endDrag(true);
  };
  private handleLostCapture = (e: PointerEvent) => {
    if (e.pointerId === this.drag?.id) this.endDrag(true);
  };
  private endDrag(
    cancel: boolean,
    target?: number,
    animate = false,
    settle = true,
  ) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    window.removeEventListener("keydown", this.handleDragKeydown, true);
    window.removeEventListener("blur", this.handlePointerCancel);
    this.style.userSelect = drag.userSelect;
    if (this.hasPointerCapture(drag.id)) this.releasePointerCapture(drag.id);
    if (settle && (drag.horizontal || target !== undefined || cancel)) {
      this.setPage(target ?? Math.round(drag.start), this.pageStopIdx, animate);
    }
  }

  nextPage() {
    this.setPage(Math.round(this._currentPageIndex) + 1);
  }
  previousPage() {
    this.setPage(Math.round(this._currentPageIndex) - 1);
  }

  setPage(
    idx: number,
    stopIdx = this.pageStopIdx,
    animate = true,
    animationDurationMs = 500,
    easing = "ease",
  ) {
    if (!Number.isFinite(idx)) {
      throw new RangeError("Carousel index must be finite");
    }
    const stop = this.stopCount(stopIdx);
    if (!Number.isFinite(animationDurationMs) || animationDurationMs < 0) {
      throw new RangeError("Carousel duration must be finite and nonnegative");
    }
    // CSS-wide keywords/variables pass CSS.supports but are invalid WAAPI easing.
    new KeyframeEffect(null, [], { duration: animationDurationMs, easing });
    // A public navigation supersedes an active drag before notifying consumers.
    if (this.drag) this.endDrag(false, undefined, false, false);
    this.renderPage(
      this.bounded(Math.round(idx), stop),
      stop,
      animate,
      animationDurationMs,
      easing,
    );
  }

  private renderPage(
    idx: number,
    stop: number,
    animate: boolean,
    duration: number,
    easing: string,
  ) {
    const generation = ++this.updateGeneration;
    const previous = this.bounded(this._currentPageIndex, stop);
    const active = stop > 0 ? this.bounded(Math.round(idx), stop) : -1;
    // Focus dispatches synchronous consumer events. A nested navigation or bind wins.
    if (this.$pages.some((page, i) =>
      i !== active && (page.matches(":focus-within") || page.matches(":focus"))
    )) {
      this.focus({ preventScroll: true });
      if (generation !== this.updateGeneration) return;
    }
    const animated = animate && duration > 0 &&
      !(this.motion?.matches ??
        matchMedia("(prefers-reduced-motion: reduce)").matches);
    const from = animated
      ? this.$pages.map((page) => getComputedStyle(page).transform)
      : [];
    this.cancelAnimations();
    const transforms = Carousel.progressToTransform(
      idx,
      this.$pages.length,
      stop,
    );
    this._currentPageIndex = idx;
    for (const [i, page] of this.$pages.entries()) {
      const transform = `translate(${
        transforms[i].translate * 100
      }%, 0px) scale(${transforms[i].scale})`;
      page.style.transform = transform;
      if (animated) {
        const animation = page.animate(
          [{ transform: from[i] }, { transform }],
          { duration, easing },
        );
        this.animations.set(page, animation);
        animation.onfinish = () => {
          if (this.animations.get(page) === animation) {
            this.animations.delete(page);
          }
        };
      }
      page.inert = i !== active;
      page.setAttribute("aria-hidden", String(i !== active));
      if (!page.hasAttribute("role")) page.setAttribute("role", "group");
      if (!page.hasAttribute("aria-roledescription")) {
        page.setAttribute("aria-roledescription", "slide");
      }
      const original = this.pageAttributes.get(page);
      if (!original?.get("aria-label")) {
        page.setAttribute("aria-label", `${i + 1} of ${this.$pages.length}`);
      }
    }
    // Notification: state, transforms and focus policy are committed before reentry or exceptions.
    this.callbacks?.onScroll?.(
      previous,
      this.bounded(idx, stop),
      animated ? duration : null,
    );
  }

  static progressToTransform = (
    idx: number,
    cnt: number,
    stopIdx = cnt,
    easeFn: (n: number) => number = MathUtils.easeInSine,
  ): { progress: number; translate: number; scale: number }[] => {
    if (
      !Number.isFinite(idx) || !Number.isInteger(cnt) || cnt < 0 ||
      !Number.isInteger(stopIdx) || stopIdx < 0
    ) {
      throw new RangeError("Invalid carousel transform bounds");
    }
    const stop = Math.min(cnt, stopIdx);
    const floor = Math.floor(idx), ceil = Math.ceil(idx);
    const progress = idx < 0 ? 1 - Math.abs(idx % 1) : idx % 1;
    return Array.from({ length: cnt }, (_, i) => {
      if (i >= stop) return { progress: 0, translate: i, scale: .95 };
      let diff = i - idx;
      // Preserve edge feedback, but approach a bound monotonically for long pulls.
      if (idx < 0 && i === 0) diff = (1 - Math.exp(-diff)) / 3;
      else if (idx > stop - 1 && i === stop - 1) {
        diff = -(1 - Math.exp(-Math.abs(diff))) / 3;
      }
      let p = i === floor ? 1 - progress : 0;
      if (i === ceil && i !== idx) p = progress;
      return {
        progress: p,
        translate: diff,
        scale: MathUtils.lerp(.95, 1, easeFn(p)),
      };
    });
  };

  private static _$styles: Style.Compat[] = [
    css`
      :host {
        width: 100%;
        height: 660px;
        touch-action: pan-y pinch-zoom;
        display: flex;
        flex-direction: column;
      }

      :host(:focus-visible) {
        outline: var(--std-carousel-focus-outline, 2px solid var(--blue));
        outline-offset: var(--std-carousel-focus-outline-offset, 4px);
      }

      .card {
        height: 100%;
      }
      #title {
        margin-top: 80px;
        margin-bottom: 80px;
        font-size: 1.5rem;
      }
    `,
    css`
      #alias-fix {
        position: relative;
        height: 100%;
      }
      #alias-fix:after {
        position: absolute;
        inset: -3px;
        content: "";
        z-index: 1;
        border-radius: calc(var(--std-carousel-border-radius, 20px) + 4px);
        border: var(--std-carousel-border, 1px solid var(--std-carousel-background-color, white));
        pointer-events: none;
      }
      #alias-fix:before {
        position: absolute;
        inset: -1px;
        content: "";
        z-index: 1;
        border-radius: var(--std-carousel-border-radius, 20px);
        box-shadow: var(--std-carousel-container-box-shadow, 0px 0px 6px 3px rgb(0 0 0 / 12%)
          inset);
        opacity: 1;
        pointer-events: none;
      }
      #page-container {
        position: relative;
        border-radius: var(--std-carousel-border-radius, 20px);
        overflow: hidden;
        background-color: var(
          --std-carousel-background-color,
          var(--slate-gray)
        );
      }
      .page {
        position: absolute;
        top: 0;
        left: 0;
        margin: var(--std-carousel-page-margin, 0px);
        width: calc(100% - var(--std-carousel-page-margin, 0px) * 2);
        height: calc(100% - var(--std-carousel-page-margin, 0px) * 2);
        padding: var(--std-carousel-page-padding, 20px);
        border-radius: var(--std-carousel-border-radius, 20px);
        box-shadow: var(--std-carousel-card-box-shadow, none);
      }
      .page::before {
        content: "";
        position: absolute;
        inset: 4px;
        background-color: var(--std-carousel-page-background-color);
        border-radius: var(--std-carousel-border-radius, 20px);
        z-index: -1;
      }
    `,
    css`
      #time-graph {
        position: fixed;
        display: none;
        top: 8px;
        left: 8px;
        z-index: 1;
        opacity: 0.8;
        background-color: var(--bg);
      }
    `,
  ];
  public static get $styles(): Style.Compat[] {
    return Carousel._$styles;
  }
  public static set $styles(value: Style.Compat[]) {
    Carousel._$styles = value;
  }

  static $html = html`
    <div id="alias-fix">
      <std-col id="page-container" class="card"></std-col>
    </div>
  `;
}
