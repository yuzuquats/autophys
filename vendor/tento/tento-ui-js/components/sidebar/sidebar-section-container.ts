import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { Scrollbars } from "../scrollbars";

@component({
  name: "std-sidebar-section-container",
})
export class SidebarSectionContainer extends LonaWebComponent {
  private animationDurationMs: number = 450;
  private previousScrollTopPx: Option<number>;

  private _$focusedSection: Option<HTMLElement>;
  get $focusedSection(): Option<HTMLElement> {
    return this._$focusedSection;
  }

  private expanded: boolean = false;

  private lifetime = 0;

  disconnectedCallback(): void {
    this.lifetime++;
    this.clearAnimationCompletions();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.lifetime++;
    this.clearAnimationCompletions();
    this._$focusedSection = null;
    this.expanded = false;
    this.previousScrollTopPx = null;
    super.onRecycle();
  }

  focusOnSection(
    toExpand: boolean,
    $target: HTMLElement,
    bind: EmptyFunction,
    animate: boolean = true,
  ) {
    this.clearAnimationCompletions();

    const $previousSection = this._$focusedSection;
    const wasExpanded = this.expanded;

    this._$focusedSection = toExpand ? $target : null;
    this.expanded = toExpand;

    const originalRects = this.sidebarRects();
    bind();
    const lifetime = this.lifetime;
    this.mutateOwned(() => {
      if (lifetime !== this.lifetime) return;
      const newRects = this.sidebarRects();
      if (
        $previousSection != null &&
        $previousSection !== $target &&
        wasExpanded
      ) {
        this.collapseAllSections(
          $target,
          originalRects,
          newRects,
          animate,
          false,
        );
        this.deferOwned(() => {
          this.expandSection($target, originalRects, newRects, false);
        });
        return;
      }

      toExpand
        ? this.expandSection($target, originalRects, newRects, animate)
        : this.collapseAllSections(
            $target,
            originalRects,
            newRects,
            animate,
            true,
          );
    });
  }

  private mutateOwned(fn: EmptyFunction): void {
    const lifetime = this.lifetime;
    $$.mutate(() => { if (lifetime === this.lifetime) fn(); });
  }

  private deferOwned(fn: EmptyFunction): void {
    const lifetime = this.lifetime;
    $$.defer(() => { if (lifetime === this.lifetime) fn(); });
  }

  private $slottedChildren() {
    return DomUtils.slotChildren(this.$qs<HTMLSlotElement>("slot"));
  }

  private sidebarRects(): DOMRect[] {
    return [...this.$slottedChildren()].map(($section) =>
      $section.getBoundingClientRect(),
    );
  }

  private animationCompletion: Option<ReturnType<typeof setTimeout>>;
  private animationCompletionFns: EmptyFunction[] = [];
  private pushAnimationCompletion(completion: EmptyFunction) {
    this.animationCompletionFns.push(completion);
    if (this.animationCompletion != null) return;
    const lifetime = this.lifetime;
    this.animationCompletion = setTimeout(() => {
      this.animationCompletion = null;
      if (lifetime !== this.lifetime) return;
      const completions = this.animationCompletionFns;
      this.animationCompletionFns = [];
      this.mutateOwned(() => {
        for (const fn of completions) fn();
      });
    }, this.animationDurationMs);
  }

  private clearAnimationCompletions() {
    this.animationCompletion && clearTimeout(this.animationCompletion);
    this.animationCompletion = null;
    this.animationCompletionFns = [];
  }

  private collapseAllSections(
    $target: HTMLElement,
    originalRects: DOMRect[],
    newRects: DOMRect[],
    animate: boolean,
    fadeInSections: boolean,
  ) {
    const $root = this.$("root");
    const $sections = this.$slottedChildren();
    const deltas = newRects.map((r, i) => r.top - originalRects[i].top);

    $root.assignStyles({
      overflowY: "",
      height: "",
      marginTop: "",
      "--p-extra-height": null,
    });
    this.previousScrollTopPx && $root.scrollTop === this.previousScrollTopPx;

    let found = false;
    for (const [index, $section] of $sections.entries()) {
      const isTarget = $section === $target;
      if (isTarget) found = true;
      let transform = "";
      if (isTarget) {
        transform = "";
      } else if (!found) {
        transform = `translateY(${-120}px)`;
      } else {
        transform = `translateY(${120 - 76}px)`;
      }
      this.setStyle(
        $section,
        {
          transition: !isTarget ? "none" : "",
          transform,
          "--std-sidebar-section-bottom-margin": "0px",
          "--std-sidebar-section-overflow": "visible",
          "--additional-translate-y": `${-deltas[index]}px`,
          opacity: String(0),
        },
        {
          "--std-sidebar-section-overflow": "scroll",
        },
      );
      $section.toggleAttribute("expanded", false);
    }

    this.deferOwned(() => {
      for (const $section of $sections) {
        $section.assignStyles({
          pointerEvents: "",
          opacity: String(fadeInSections ? 1 : 0),
          transition: animate ? "" : "none",
          transform: "",
          height: "",
          "--additional-translate-y": null,
        });
      }
    });
  }

  private expandSection(
    $target: HTMLElement,
    originalRects: DOMRect[],
    newRects: DOMRect[],
    animate: boolean,
  ) {
    const $root = this.$("root");
    const $sections = this.$slottedChildren();

    let found = false;
    let foundIndexDeltaHeight = 0;
    const deltas = originalRects.map((r, i) => r.top - newRects[i].top);
    for (const [index, $section] of $sections.entries()) {
      const isTarget = $section === $target;
      if (isTarget) {
        foundIndexDeltaHeight =
          newRects[index].height - originalRects[index].height + 60;
        found = true;
      }
      $section.assignStyles({
        width: !isTarget ? originalRects[index].width + "px" : "",
        transition: "none",
        transform:
          found && !isTarget
            ? `translateY(${-foundIndexDeltaHeight}px)`
            : `translateY(${-deltas[index]}px)`,
        "--std-sidebar-section-bottom-margin": "0px",
        "--std-sidebar-section-overflow": "scroll",
      });
      $section.toggleAttribute("expanded", $section === $target);
    }

    this.mutateOwned(() => {
      const parent = $target.parentElement!.getBoundingClientRect();
      const r = $target.getBoundingClientRect();
      const originalScrollTop = $root.scrollTop;
      this.previousScrollTopPx = originalScrollTop;

      this.setStyle(
        $root,
        {
          height: "auto",
          marginTop: -originalScrollTop + "px",
          "--p-extra-height": originalScrollTop + "px",
          overflow: "visible",
        },
        {
          height: "",
          maxHeight: "100%",
          marginTop: "0px",
          "--p-extra-height": "0px",
          overflow: "hidden",
        },
      );

      // dev(
      //   "focus/transform/target",
      //   {
      //     parentTop: parent.top,
      //     rTop: r.top,
      //     originalScrollTop,
      //     $target,
      //   },
      //   deltas
      // );
      let found = false;
      for (const [index, $section] of $sections.entries()) {
        // dev(
        //   "focus/transform",
        //   `translateY(${-r.top + parent.top - deltas[index]}px)`
        // );
        if ($section === $target) {
          found = true;
          this.setStyle(
            $section,
            {
              transition: animate ? "" : "none",
              opacity: String(1),
              width: "",
              pointerEvents: "",
              transform: `translateY(calc(${
                -r.top + parent.top - deltas[index]
              }px + var(--additional-translate-y, 0px)))`,
              "--std-sidebar-section-bottom-margin": "72px",
            },
            {
              height: "100%",
              width: "",
            },
          );
          this.pushAnimationCompletion(() => $section.offsetHeight);
        } else if (!found) {
          this.setStyle(
            $section,
            {
              transition: animate ? "" : "none",
              opacity: String(0),
              pointerEvents: "none",
              transform: `translateY(calc(${
                -r.top + parent.top - deltas[index] - 120
              }px + var(--additional-translate-y, 0px))`,
            },
            {
              width: "",
            },
          );
        } else {
          this.setStyle(
            $section,
            {
              transition: animate ? "" : "none",
              opacity: String(0),
              pointerEvents: "none",
              transform: `translateY(calc(${
                -deltas[index] - foundIndexDeltaHeight + 120
              } + var(--additional-translate-y, 0px))`,
            },
            {
              width: "",
            },
          );
        }
      }
    });
  }

  setStyle(
    $e: HTMLElement,
    styles: CSSStyleWithVariables,
    onCompleteStyles: CSSStyleWithVariables,
  ) {
    $e.assignStyles(styles);
    this.pushAnimationCompletion(() =>
      $e.assignStyles(onCompleteStyles),
    );
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        --p-animation-duration: 0.45s;
        position: relative;
        display: block;
        height: 100%;
      }

      #root {
        margin: 0px 0px;
        position: relative;
        height: calc(100% - 0px + var(--p-extra-height, 0px));
        overflow-y: scroll;
      }

      slot::slotted(*) {
        transition: transform var(--p-animation-duration) ease,
          opacity var(--p-animation-duration) ease;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <slot></slot>
    </std-col>
    <slot name="floating"></slot>
  `;
}
