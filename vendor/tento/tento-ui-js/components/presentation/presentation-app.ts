import "../round";
import "./presentation-header";
import "./presentation-footer";

import { html, LonaWebComponent } from "../../component";
import { $$, mutate } from "../../fastdom";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { InstanceUrl } from "@tento-core/instance-url";
import { Hotkeys } from "../../hotkeys";
import { Round } from "../round";
import { PresentationHeader } from "./presentation-header";
import { PresentationFooter } from "./presentation-footer";
import { Scrollbars } from "../scrollbars";

export type PresentationSlide = {
  title?: string;
  make: () => HTMLElement;
  images?: string[];
};

let manropeFontsLoaded = false;

function loadManropeFonts() {
  if (manropeFontsLoaded) return;
  manropeFontsLoaded = true;
  const faces: FontFace[] = [
    new FontFace("Manrope", `url(${InstanceUrl.staticUrl("/fonts/manrope-latin.woff2")})`, {
      weight: "300 700",
      style: "normal",
      display: "block",
      unicodeRange:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, " +
        "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, " +
        "U+2212, U+2215, U+FEFF, U+FFFD",
    }),
    new FontFace(
      "Manrope",
      `url(${InstanceUrl.staticUrl("/fonts/manrope-latin-ext.woff2")})`,
      {
        weight: "300 700",
        style: "normal",
        display: "block",
        unicodeRange:
          "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, " +
          "U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, " +
          "U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
      },
    ),
  ];
  for (const face of faces) {
    document.fonts.add(face);
    face.load();
  }
}

@component({ name: "std-presentation-app" })
export class PresentationApp extends LonaWebComponent {
  private slides: PresentationSlide[] = [];
  private currentSlideIndex: number = 0;
  private onClose: Option<() => void> = null;
  private headerLeft: string = "";
  private headerRight: string = "";

  private $slideContainer: HTMLElement = this.$("slide-container");
  private $currentSlide: Option<HTMLElement> = null;
  private _$bg = this.hydrate<Round>("bg")
    .bind({
      ...Round.Props.FLAT_CARD,
    })
    .setAnimates(false);
  private _$header: PresentationHeader =
    this.hydrate<PresentationHeader>("header");
  private _$footer: PresentationFooter =
    this.hydrate<PresentationFooter>("footer");

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.navigate(-1);
    } else if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      this.navigate(1);
    }
  };

  connectedCallback() {
    super.connectedCallback();
    loadManropeFonts();
    document.addEventListener("keydown", this.onKeyDown);
    Hotkeys.pushEscapeHandler(this, () => {
      this.onClose?.();
    });
    this.showSlide(this.currentSlideIndex);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this.onKeyDown);
    Hotkeys.clearEscapeHandler(this);
  }

  bind(props: PresentationApp.Props): this {
    this.slides = props.slides;
    this.onClose = props.onClose;
    this.headerLeft = props.headerLeft ?? "";
    this.headerRight = props.headerRight ?? "";
    this.currentSlideIndex = 0;
    this.prefetchImages(props.slides);
    return this;
  }

  private prefetchImages(slides: PresentationSlide[]) {
    for (const slide of slides) {
      for (const url of slide.images ?? []) {
        const img = new Image();
        img.src = url;
      }
    }
  }

  private navigate(delta: number) {
    const next = this.currentSlideIndex + delta;
    if (next < 0 || next >= this.slides.length) return;
    this.currentSlideIndex = next;
    this.showSlide(this.currentSlideIndex);
  }

  @mutate
  private showSlide(index: number) {
    if (this.slides.length === 0) return;

    const slide = this.slides[index];
    const $slide = slide.make();
    $slide.assignStyles({
      opacity: "0",
      position: "absolute",
      height: "100%",
      width: "100%",
    });
    this.$slideContainer.appendChild($slide);

    const prev = this.$currentSlide;
    this.$currentSlide = $slide;

    $$.mutate(() => {
      $slide.style.opacity = "1";
      if (!prev) return;
      prev.style.opacity = "0";
    });

    this.updateHUD();
  }

  private updateHUD() {
    const total = this.slides.length;
    const current = this.currentSlideIndex + 1;
    this._$header.bind(this.headerLeft, this.headerRight);
    this._$footer.bind(current, total);
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        display: block;
        width: calc(100% - var(--safe-area-inset-left) - var(--safe-area-inset-right)) !important;
        height: calc(100% + 0px);
        position: relative;
        overflow: hidden;
        margin-left: calc(var(--safe-area-inset-left));
        --cap-height: 0.163;
        --baseline: 0.1175;
        font-family: "Manrope", sans-serif;
      }

      #root {
        margin: 3px;
        margin-top: 3px;
        border-radius: 20px;
        height: calc(100% - 7px);
        width: calc(100% - 3px);
        position: relative;
      }

      std-presentation-header {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
      }

      #slide-container {
        position: absolute;
        top: 32px;
        left: 0px;
        right: 0px;
        bottom: 32px;
        overflow: hidden;
      }

      std-presentation-footer {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
      }
    `,
  ];

  static $html = html`
    <std-col id=root>
      <std-round id=bg floating></std-round>
      <std-presentation-header id="header"></std-presentation-header>
      <div id="slide-container"></div>
      <std-presentation-footer id="footer"></std-presentation-footer>
    </std-col>
  `;
}

export namespace PresentationApp {
  export type Props = {
    slides: PresentationSlide[];
    onClose: () => void;
    headerLeft?: string;
    headerRight?: string;
  };
}
