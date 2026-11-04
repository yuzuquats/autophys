import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

// A loading placeholder built from tokens. `shimmer.ts` is a `std-pulse` atom
// plus `.shimmer` classes in an opt-in sheet with hex literals, shown only by
// a `dev-` example; it is not adopted here. This one is a registered element
// with a shape — lines of text, a rectangle, a circle — a size, and an
// animation the reduced-motion preference switches off.
//
// Always `aria-hidden`: a skeleton is a picture of content that is not there
// yet, and the region it stands in is what says `aria-busy`.
@component({ name: "std-skeleton" })
export class Skeleton extends LonaWebComponent {
  /** Placeholders are eagerly rendered; larger documents need section placeholders. */
  static readonly maxLines = 1000;
  private $root: HTMLElement = this.$("root");

  bind(props: Skeleton.Props): this {
    const lines = props.lines ?? 3;
    if (props.shape === "text" && (!Number.isSafeInteger(lines) || lines < 0 || lines > Skeleton.maxLines)) {
      throw new RangeError(`Skeleton text lines must be an integer from 0 to ${Skeleton.maxLines}`);
    }
    const count = props.shape === "text" ? Math.max(1, lines) : 1;
    DomUtils.clearChildren(this.$root);
    this.setAttribute("aria-hidden", "true");
    this.setAttribute("shape", props.shape);
    this.toggleAttribute("animated", props.animated);
    const w = props.widthPx;
    const h = props.heightPx;
    if (w != null) this.style.setProperty("--skeleton-width", `${w}px`);
    else this.style.removeProperty("--skeleton-width");
    if (h != null) this.style.setProperty("--skeleton-height", `${h}px`);
    else this.style.removeProperty("--skeleton-height");
    for (let i = 0; i < count; i++) {
      const $bar = document.createElement("div");
      $bar.className = "bar";
      // The last line of a paragraph is short — a block of equal bars reads as
      // a table, not prose.
      if (props.shape === "text" && count > 1 && i === count - 1) $bar.classList.add("last");
      this.$root.appendChild($bar);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$root);
    for (const a of ["aria-hidden", "shape", "animated"]) this.removeAttribute(a);
  }

  static makeWith(props: Skeleton.Props): Skeleton {
    return Skeleton.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --skeleton-radius: var(--skeleton-radius-preset, 4px);
        --skeleton-line-gap: 8px;
        --skeleton-base: var(--bg-surface-light);
        --skeleton-sheen: var(--bg-hover-very-light);

        display: block;
        width: var(--skeleton-width, 100%);
      }

      #root {
        display: flex;
        flex-direction: column;
        gap: var(--skeleton-line-gap);
      }

      .bar {
        width: 100%;
        height: var(--skeleton-height, 1em);
        border-radius: var(--skeleton-radius);
        background: var(--skeleton-base);
      }

      :host([shape="text"]) .bar.last {
        width: 60%;
      }

      :host([shape="rect"]) .bar {
        height: var(--skeleton-height, 120px);
      }

      :host([shape="circle"]) {
        width: var(--skeleton-width, 40px);
      }

      :host([shape="circle"]) .bar {
        height: var(--skeleton-height, var(--skeleton-width, 40px));
        border-radius: 50%;
      }

      :host([animated]) .bar {
        background: linear-gradient(
          90deg,
          var(--skeleton-base) 0%,
          var(--skeleton-sheen) 50%,
          var(--skeleton-base) 100%
        );
        background-size: 200% 100%;
        animation: skeleton-sweep 1.4s ease-in-out infinite;
      }

      @keyframes skeleton-sweep {
        from {
          background-position: 200% 0;
        }
        to {
          background-position: -200% 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        :host([animated]) .bar {
          animation: none;
          background: var(--skeleton-base);
        }
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace Skeleton {
  export type Props = {
    shape: "text" | "rect" | "circle";
    /** Text only; default 3. */
    lines: Option<number>;
    widthPx: Option<number>;
    heightPx: Option<number>;
    animated: boolean;
  };
}
