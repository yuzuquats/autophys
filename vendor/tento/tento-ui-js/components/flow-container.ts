import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { $qs_maybe } from "../dom-selectors";
import { $$ } from "../fastdom";

@component({
  name: "std-flow-container",
})
export class FlowContainer<PageInfo = any> extends LonaWebComponent {
  private pageInfoStack: Option<PageInfo>[] = [];
  private $stack: HTMLElement[] = [];
  private headerro = new ResizeObserver(([entry]) => {
    this.assignStyles({
      "--header-height": entry.contentRect.height + "px",
    });
  });
  // Observes the currently-revealed page in content-basis auto-height modes
  // (mode="fit" or mode="grow" scroll="page"), re-targeted on every render, so
  // the container re-measures when the page's content changes size AFTER layout
  // (async children mounting, expand/collapse). Disabled in fill / grow+container
  // modes, where the page height is parent- or `--p-height`-driven — observing it
  // there would feed our own writes back into the observer (a layout loop).
  private pagero = new ResizeObserver(() => this.remeasure());
  onPageInfoChange: (info: Option<PageInfo>) => void = Constants.EMPTY_FUNCTION;
  private renderFn: Option<EmptyFunction>;
  private $header = this.$("header");

  connectedCallback() {
    super.connectedCallback();
    this.headerro.observe(this.$header);
    this.observePage();
    this.renderFn?.();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.headerro.disconnect();
    this.pagero.disconnect();
    this.toggleAttribute("animate", false);
  }

  onRecycle(): void {
    this.reset();
  }

  dismiss(): void {
    this.toggleAttribute("animate", false);
  }

  stackSize(): number {
    return this.$stack.length;
  }

  /**
   * Declare how this flow-container sizes itself. The public sizing interface —
   * sets the `mode`/`scroll` attributes (which the CSS keys off) and the
   * `--flow-max-height` cap, and re-targets the page ResizeObserver. Call before
   * the first `pushPage`/`render` so the mode is in effect when the container
   * first measures. The discriminated union encodes the valid matrix: `fill`
   * needs nothing; `fit` hugs content uncapped (never scrolls); only `grow` takes
   * a `scroll` owner + a `maxHeight` cap (null ⇒ inherit the ambient modal cap).
   */
  setSizing(sizing: FlowContainer.Sizing): void {
    this.setAttribute("mode", sizing.mode);
    if (sizing.mode === "grow") {
      this.setAttribute("scroll", sizing.scroll);
      if (sizing.maxHeight != null) {
        this.style.setProperty("--flow-max-height", sizing.maxHeight);
      } else {
        this.style.removeProperty("--flow-max-height");
      }
    } else {
      this.removeAttribute("scroll");
      this.style.removeProperty("--flow-max-height");
    }
    this.observePage();
  }

  /** Parent-driven height (no measurement). */
  private isFill(): boolean {
    return this.getAttribute("mode") === "fill";
  }

  /**
   * The revealed page is `height: auto` (content-driven) — `mode="fit"` or
   * `mode="grow" scroll="page"`. Only in these modes is observing the page for
   * live re-measure both necessary and loop-free.
   */
  private isAutoPage(): boolean {
    const mode = this.getAttribute("mode");
    return (
      mode === "fit" ||
      (mode === "grow" && this.getAttribute("scroll") === "page")
    );
  }

  /** Point the page ResizeObserver at the revealed page (auto-height modes only). */
  private observePage(): void {
    this.pagero.disconnect();
    const $revealed = this.$stack[this.$stack.length - 1];
    if (this.isConnected && this.isAutoPage() && $revealed) {
      this.pagero.observe($revealed);
    }
  }

  reset(): FlowContainer<PageInfo> {
    for (const $page of this.$stack) {
      DomUtils.removeFromDom($page);
    }
    this.$stack = [];
    this.pageInfoStack = [];
    this.pagero.disconnect();
    this.onPageInfoChange(null);
    this.toggleAttribute("animate", false);
    return this;
  }

  setHeader($e: HTMLElement): FlowContainer<PageInfo> {
    $e.slot = "header";
    this.appendChild($e);
    return this;
  }

  pushPage(
    $e: HTMLElement,
    pageInfo: Option<PageInfo> = null,
    render: boolean = true,
  ): FlowContainer<PageInfo> {
    if (this.$stack[this.$stack.length - 1] === $e) {
      return this;
    }

    $e.slot = "page";
    this.appendChild($e);
    this.pageInfoStack.push(pageInfo);
    this.$stack.push($e);
    render && this.render();
    this.onPageInfoChange(pageInfo);
    setTimeout(() => {
      $$.defer(() => {
        this.toggleAttribute("animate", true);
      });
    });
    return this;
  }

  get numPages(): number {
    return this.$stack.length;
  }

  popPage(): FlowContainer<PageInfo> {
    if (this.$stack.length === 0) return this;

    const $page = this.$stack.pop();
    if ($page) {
      $page.remove();
    }
    this.pageInfoStack.pop();
    const info = this.pageInfoStack[this.pageInfoStack.length - 1];
    this.onPageInfoChange(info);
    this.render();
    return this;
  }

  render(onFinish?: Option<() => void>, sync: boolean = false): void {
    if (this.$stack.length === 0) return;

    const $previousRevealed = $qs_maybe("[slot=page][revealed]", this);
    const $revealed = this.$stack[this.$stack.length - 1];
    if ($previousRevealed === $revealed || !$revealed) return;

    // help me god
    //
    // in some circumstances (ie. initial layout), we dont want any animations
    // forget queuing onto the animation thread so we have to wait 2 frames
    //
    // the "idea" behind mutate-measure-mutate is that the first mutation
    // forces a style-recalc/layout (scheduled immediately after the fastdom
    // flushes the transaction).
    //
    // we then measure-mutate in the next animation frame because we always
    // want to measure before mutate (measure *SHOULD* never trigger a layout-
    // recalc).
    //
    const mutate = sync ? (fn: () => void) => fn() : $$.mutate.bind($$);
    const measure = sync ? (fn: () => void) => fn() : $$.mutate.bind($$);

    const secondFrame = () => {
      if (this.isFill()) return;
      measure(() => {
        const rect = $revealed.getBoundingClientRect();

        mutate(() => {
          this.assignStyles({
            "--p-height": Math.max(rect.height, 0) + "px",
            "--p-width": Math.max(rect.width, 0) + "px",
          });

          if (!onFinish) return;
          setTimeout(() => {
            if (!this.isConnected) return;
            onFinish();
          }, 300);
        });
      });
    };
    this.renderFn = null;

    // 1) First Frame
    mutate(() => {
      this.assignStyles({
        "--p-height": "",
        "--p-width": "",
      });
      $revealed.toggleAttribute("revealed", true);
      $revealed.assignStyles({
        transform: "",
        "--x": "0px",
      });
      // Re-target the page observer at the now-revealed page (auto-height modes).
      this.observePage();

      if ($previousRevealed) {
        $previousRevealed.toggleAttribute("revealed", false);
        $previousRevealed.assignStyles({
          "--x": "-40px",
        });
      }

      // 2) Second Frame
      //    If we're not connected, defer the function until connectedCallback
      //    occurs. We also need to measure the header-height so that the two
      //    are sized together in the same transaction.
      //
      //    If we wait until header-ro to discover the height, any resize observer
      //    belonging to an ancestor will race with our header resize observer.
      //
      //    the parent will see
      //        1. {0 (header) + 100px (body)}
      //
      //        ...some time later
      //
      //        2. {10 (header) + 100px (body)}
      //
      if (this.isConnected) {
        secondFrame();
      } else {
        this.renderFn = () => {
          secondFrame();
          this.assignStyles({
            "--header-height": this.$header.offsetHeight + "px",
          });
        };
      }
    });
  }

  /**
   * Re-measure the revealed page and refresh `--p-height`/`--p-width` without a
   * full render/animation pass. Driven by the `pagero` observer in auto-height
   * modes (`fit` / `grow`+`page`) when the page's content changes size after the
   * initial render. No-op in `fill` (height is parent-driven, not measured).
   *
   * Two guards (both confirmed by ux-test traces of the old hand-wired path):
   *  - skip when the measured size is UNCHANGED (the observer fires redundantly;
   *    re-writing the same `--p-height` re-triggers it — the benign RO loop).
   *  - never clobber an existing good height with 0 (content not yet laid out);
   *    keep the prior value and let the next observer tick correct it.
   */
  remeasure(): void {
    if (this.isFill()) return;
    const $revealed = this.$stack[this.$stack.length - 1];
    if (!$revealed) return;
    $$.measure(() => {
      const rect = $revealed.getBoundingClientRect();
      const h = Math.max(rect.height, 0);
      const w = Math.max(rect.width, 0);
      const curH = this.style.getPropertyValue("--p-height");
      if (h === 0 && curH !== "") return;
      if (curH === h + "px" && this.style.getPropertyValue("--p-width") === w + "px") {
        return;
      }
      $$.mutate(() => {
        this.assignStyles({
          "--p-height": h + "px",
          "--p-width": w + "px",
        });
      });
    });
  }

  static $styles = [
    css`
      :host {
        /* A flow-container is a layout container, never inline. Without this it
           defaults to the custom-element inline display, so a block #root lands
           in a line box and picks up ~half-leading of vertical offset (visible
           in the sheet-details drawer, whose host is not a flex parent to
           blockify it). Flex-parented consumers already compute to block. */
        display: block;
        width: 100%;
        --flow-padding: 0px;
        --flow-initial-x: -120px;
        --flow-previous-x: -40px;
      }

      /* The grow cap: an explicit --flow-max-height, else the ambient modal cap
         (--std-modal-max-height set by std-modal-component). Unset ⇒ none. */
      #root {
        position: relative;
        height: calc(
          var(--p-height, 0px) + var(--header-height, 0px) +
            var(--flow-padding) * 2
        );
        width: 100%;
        max-height: inherit;
      }

      #root::before {
        content: "";
        position: absolute;
        inset: 0;
        background: var(--flow-bg, var(--bg));
        /* explicit flow shadow, else the ambient global --box-shadow token */
        box-shadow: var(--flow-shadow, var(--box-shadow));
        border-radius: 8px;
        height: calc(
          var(--p-height, 0px) + var(--header-height, 0px) +
            var(--flow-padding) * 2
        );
        max-height: var(--flow-max-height, var(--std-modal-max-height));
        width: 100%;
        z-index: -1;
      }

      :host([animate]) #root::before {
        transition: width 0.3s ease, height 0.3s ease;
      }

      /* Default = grow + container: page is sized to the measured --p-height,
         capped, and the flow-container scrolls it when it overflows the cap. */
      slot[name="page"]::slotted(*) {
        /* Border-box, because every size below is the page's WHOLE box: the
           width is the flow's, the heights are the flow's or the measured
           --p-height (an offsetHeight, padding included). Under content-box a
           page with padding of its own came out wider and taller than the
           flow by exactly that padding. MEASURED on the storybook's form page:
           std-form pads itself 12px, so its fields ran 24px past the
           container's right edge. */
        box-sizing: border-box;
        position: absolute;
        top: var(--flow-padding);
        left: var(--flow-padding);
        opacity: 0;
        pointer-events: none;
        transform: translate(var(--x, 0px), var(--header-height, 0px));
        width: calc(100% - calc(var(--flow-padding) * 2));
        max-height: calc(
          var(--flow-max-height, var(--std-modal-max-height)) -
            var(--header-height)
        );
        height: var(--p-height);
      }

      slot[name="page"]::slotted(*[revealed]) {
        opacity: 1;
        pointer-events: all;
        overflow-y: auto;
      }

      #header {
        z-index: 1;
      }

      #page {
        overflow-y: auto;
        height: var(--p-height, 0px);
        max-height: calc(
          var(--flow-max-height, var(--std-modal-max-height)) -
            var(--header-height)
        );
      }

      /* ---- mode: fill — fill a definite-height parent (scroll lives in page) ---- */
      :host([mode="fill"]) {
        height: 100%;
      }
      :host([mode="fill"]) #root {
        height: 100%;
      }
      :host([mode="fill"]) #page {
        height: calc(
          100% - var(--header-height, 0px) - var(--flow-padding) * 2
        );
        max-height: none;
      }
      /* The header's height has to come OFF the page, and this is the one place
         it does not fall out for free. #page already subtracts it, but a slotted
         page is absolutely positioned, so its containing block is #root — the
         whole flow, header included — and height:100% there resolved to the
         full flow height. The page was then translated DOWN by --header-height
         (see the slot rule above), so it hung off the bottom by exactly the
         header: MEASURED in ux-tests.node as a 763px page inside a 763px flow
         whose top was 53px lower, i.e. 53px of the page below the viewport with
         html/body at overflow:hidden and nothing to scroll it back.
         No effect on a headerless fill consumer: --header-height is 0 there. */
      :host([mode="fill"]) slot[name="page"]::slotted(*) {
        height: calc(
          100% - var(--header-height, 0px) - var(--flow-padding) * 2
        );
        max-height: none;
      }

      /* ---- scroll: page — the revealed page is the scroller: height:auto so it
             hugs content (measured into --p-height), capped at the grow cap, and
             scrolls itself once content exceeds the cap. overflow-x MUST be hidden
             explicitly: with only overflow-y:auto, CSS promotes a visible
             overflow-x to auto, so any sub-pixel/margin width overflow raises a
             horizontal scrollbar that inflates the border-box ~15px above the
             content — the "extra gap" the container then measures and locks in. ---- */
      :host([scroll="page"]) slot[name="page"]::slotted(*) {
        height: auto;
      }
      :host([scroll="page"]) slot[name="page"]::slotted(*[revealed]) {
        overflow-y: auto;
        overflow-x: hidden;
      }
      :host([scroll="page"]) #page {
        overflow: visible;
      }

      /* ---- mode: fit — hug content exactly, uncapped, never scroll ---- */
      :host([mode="fit"]) slot[name="page"]::slotted(*) {
        height: auto;
        max-height: none;
      }
      :host([mode="fit"]) slot[name="page"]::slotted(*[revealed]) {
        overflow: visible;
      }
      :host([mode="fit"]) #page {
        max-height: none;
        overflow: visible;
      }

      :host([animate]) slot[name="page"]::slotted(*) {
        transition: opacity 0.3s ease, transform 0.3s ease;
      }
    `,
  ];

  static $html = html`
    <div id="root" role="navigation" aria-label="Page navigation">
      <div id="header">
        <slot name="header"></slot>
      </div>
      <div id="page" role="main" aria-live="polite">
        <slot name="page"></slot>
      </div>
    </div>
  `;
}

export namespace FlowContainer {
  export type Scroll = "container" | "page";
  export type Sizing =
    | { mode: "fill" }
    | { mode: "fit" }
    | { mode: "grow"; scroll: Scroll; maxHeight: Option<string> };
}
