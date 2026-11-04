import "../image/lazy-image";
import "../aspect-ratio/aspect-ratio";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { AspectRatio } from "../aspect-ratio/aspect-ratio";
import { LazyImage } from "../image/lazy-image";

// An image at a size, cropped to a shape, with something to show when there
// is no image. `std-lazy-image` reserves its own space and stops there; this
// puts it in an `std-aspect-ratio`, sizes the box, chooses cover or contain,
// rounds the corners, and swaps in a fallback — initials or a glyph — on a
// null source or a load error.
//
// `alt` is mandatory and the empty string means decorative (rule R6): a
// thumbnail beside a title that already names the thing is decorative; a
// thumbnail that IS the content is not.
@component({ name: "std-thumbnail" })
export class Thumbnail extends LonaWebComponent {
  private $box: AspectRatio = this.hydrate("box");
  private $img: LazyImage = this.hydrate("img");
  private $fallback: HTMLElement = this.$("fallback");
  private props: Option<Thumbnail.Props>;

  bind(props: Thumbnail.Props): this {
    this.props = props;
    this.style.setProperty("--thumbnail-size", `${props.sizePx}px`);
    this.$box.bind({ ratio: props.ratio ?? 1 });
    this.setAttribute("fit", props.fit);
    this.bindFallback(props.fallback, props.alt);
    if (props.src == null) {
      this.showFallback(true);
    } else {
      this.showFallback(false);
      this.$img.bind({
        src: props.src,
        alt: props.alt,
        width: null,
        height: null,
        onSettled: null,
        onError: () => {
          this.showFallback(true);
          this.props?.onError?.();
        },
      });
    }
    return this;
  }

  private bindFallback(fallback: Option<Thumbnail.Fallback>, alt: string): void {
    DomUtils.clearChildren(this.$fallback);
    if (fallback == null) return;
    if ("initials" in fallback) {
      this.$fallback.textContent = fallback.initials;
    } else {
      this.$fallback.appendChild(LonaIcons.$svg(fallback.svg));
    }
    // The fallback stands in for the image, so it takes the image's name —
    // or none, when the image was decorative.
    if (alt === "") {
      this.$fallback.setAttribute("aria-hidden", "true");
      this.$fallback.removeAttribute("role");
      this.$fallback.removeAttribute("aria-label");
    } else {
      this.$fallback.removeAttribute("aria-hidden");
      this.$fallback.setAttribute("role", "img");
      this.$fallback.setAttribute("aria-label", alt);
    }
  }

  private showFallback(on: boolean): void {
    this.$fallback.toggleAttribute("hidden", !on);
    this.$img.toggleAttribute("hidden", on);
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.removeAttribute("fit");
    DomUtils.clearChildren(this.$fallback);
    this.showFallback(false);
  }

  static makeWith(props: Thumbnail.Props): Thumbnail {
    return Thumbnail.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --thumbnail-radius: var(--thumbnail-radius-preset, 8px);
        --thumbnail-bg: var(--thumbnail-bg-preset, var(--bg-surface-light));
        --thumbnail-fallback-color: var(--text-sec);

        display: inline-block;
        flex: none;
        /* The size lives on the BOX, not the host: a container that writes
           width on the host (the storybook card does) then neither
           stretches the image nor collapses it — the host shrink-wraps or
           overflows, the box stays its size. */
        max-width: var(--thumbnail-size, 64px);
      }

      #box {
        width: var(--thumbnail-size, 64px);
        border-radius: var(--thumbnail-radius);
        overflow: hidden;
        background: var(--thumbnail-bg);
      }

      #img {
        display: block;
        --lazy-image-height: 100%;
      }

      #img[hidden] {
        display: none;
      }

      :host([fit="cover"]) #img {
        --lazy-image-fit: cover;
      }

      :host([fit="contain"]) #img {
        --lazy-image-fit: contain;
      }

      #fallback {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: var(--thumbnail-fallback-color);
        font-weight: 600;
        font-size: calc(var(--thumbnail-size, 64px) * 0.35);
        letter-spacing: 0.02em;
        user-select: none;
      }

      #fallback[hidden] {
        display: none;
      }

      #fallback > svg {
        width: 45%;
        height: 45%;
        fill: currentColor;
      }
    `,
  ];

  static $html = html`
    <std-aspect-ratio id="box">
      <std-lazy-image id="img"></std-lazy-image>
      <div id="fallback" hidden></div>
    </std-aspect-ratio>
  `;
}

export namespace Thumbnail {
  export type Fallback = { initials: string } | { svg: LonaIcons.RawSvg };
  export type Props = {
    /** `null` shows the fallback without attempting a load. */
    src: Option<string>;
    /** Mandatory. The empty string means decorative (hidden from the tree). */
    alt: string;
    sizePx: number;
    /** width / height; `null` is a square. */
    ratio: Option<number>;
    fit: "cover" | "contain";
    fallback: Option<Fallback>;
    onError: Option<() => void>;
  };
}
