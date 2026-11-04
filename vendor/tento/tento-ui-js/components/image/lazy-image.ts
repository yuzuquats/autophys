import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// A single lazily-loaded image that reserves its own space. The intrinsic
// width/height go on the `<img>` as ATTRIBUTES (not CSS), which is what lets
// the browser compute the aspect box before a byte arrives — a masonry or
// column layout can therefore lay the image out correctly on first paint
// instead of reflowing once every image lands.
//
// `onSettled` fires once the pixels are actually there — including the case
// where the image was already complete before insertion (a warm cache resolves
// `load` before the listener is attached, which is how a "just wait for onload"
// consumer silently never reflows).
@component({ name: "std-lazy-image" })
export class LazyImage extends LonaWebComponent {
  private $img: HTMLImageElement = this.$("img");

  private vm: Option<LazyImage.ViewModel> = null;

  constructor() {
    super();
    this.$img.loading = "lazy";
    this.$img.decoding = "async";
    this.$img.onload = () => this.vm?.onSettled?.(this.$img.currentSrc);
    this.$img.onerror = () => this.vm?.onError?.(this.$img.src);
  }

  static makeWith(vm: LazyImage.ViewModel): LazyImage {
    return LazyImage.make().bind(vm);
  }

  bind(vm: LazyImage.ViewModel): this {
    this.vm = vm;
    this.$img.alt = vm.alt;
    if (vm.width != null) this.$img.width = vm.width;
    else this.$img.removeAttribute("width");
    if (vm.height != null) this.$img.height = vm.height;
    else this.$img.removeAttribute("height");
    this.$img.src = vm.src;
    if (this.$img.complete) vm.onSettled?.(this.$img.currentSrc);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.vm = null;
    this.$img.removeAttribute("src");
    this.$img.removeAttribute("width");
    this.$img.removeAttribute("height");
    this.$img.alt = "";
  }

  static $styles = [
    css`
      :host {
        display: block;
        box-sizing: border-box;
        width: 100%;
      }

      /* Two knobs for a caller that puts the image in a box of its own: the
         thumbnail fills its aspect box and chooses cover or contain. The
         defaults are what the image did before the knobs existed. */
      #img {
        display: block;
        width: 100%;
        height: var(--lazy-image-height, auto);
        object-fit: var(--lazy-image-fit, fill);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<img id="img" alt="" />`;
}

export namespace LazyImage {
  export interface ViewModel {
    src: string;
    alt: string;
    // Intrinsic pixel dimensions, when the source knows them: they reserve the
    // aspect box pre-load. Null renders correctly but reflows on arrival.
    width: Option<number>;
    height: Option<number>;
    onSettled: Option<(src: string) => void>;
    onError: Option<(src: string) => void>;
  }
}
