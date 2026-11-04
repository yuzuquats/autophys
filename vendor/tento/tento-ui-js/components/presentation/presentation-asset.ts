import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { FeatureCardHero } from "../../brand/landing/feature-card-hero";
import { PresentationAssetRegistry } from "./presentation-asset-registry";

@component({ name: "std-presentation-asset" })
export class PresentationAsset extends LonaWebComponent {
  static observedAttributes = ["src", "alt", "fit", "decorative"];

  private $stage: HTMLElement = this.$("stage");
  private src: Option<string> = null;
  private alt: Option<string> = null;
  private fit: PresentationAsset.Fit = "contain";
  private decorative = false;
  private registry: PresentationAssetRegistry = PresentationAssetRegistry.DEFAULT;
  private reportedMissingSrc = false;

  static makeWith(props: PresentationAsset.Props): PresentationAsset {
    return (PresentationAsset.make() as PresentationAsset).bind(props);
  }

  bind(props: PresentationAsset.Props): this {
    this.src = PresentationAsset.requiredSrc(props.src);
    this.alt = props.alt ?? null;
    this.fit = props.fit ?? "contain";
    this.decorative = props.decorative ?? false;
    this.registry = props.registry ?? PresentationAssetRegistry.DEFAULT;
    this.render();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.src) this.render();
  }

  attributeChangedCallback(
    name: string,
    _oldValue: Option<string>,
    newValue: Option<string>,
  ): void {
    switch (name) {
      case "src":
        this.src = PresentationAsset.srcFromAttribute(newValue);
        break;
      case "alt":
        this.alt = newValue;
        break;
      case "fit":
        this.fit = PresentationAsset.fitFromAttribute(newValue);
        break;
      case "decorative":
        this.decorative = newValue !== null;
        break;
    }
    this.render();
  }

  onRecycle(): void {
    this.src = null;
    this.alt = null;
    this.fit = "contain";
    this.decorative = false;
    this.registry = PresentationAssetRegistry.DEFAULT;
    this.reportedMissingSrc = false;
    DomUtils.clearChildren(this.$stage);
    this.syncAccessibility(null);
  }

  private render(): void {
    DomUtils.clearChildren(this.$stage);
    this.$stage.setAttribute("data-fit", this.fit);
    this.toggleAttribute("feature-hero", false);

    const src = this.src;
    if (!src) {
      if (!this.reportedMissingSrc) {
        Tracing.err("ui")("presentation asset src required");
        this.reportedMissingSrc = true;
      }
      this.syncAccessibility("Missing presentation asset src");
      this.$stage.appendChild(this.$missing("Missing src"));
      return;
    }

    this.reportedMissingSrc = false;
    const resolved = this.registry.resolve(src);
    if (!resolved) {
      Tracing.warn("ui")("presentation asset missing", { src });
      this.syncAccessibility(null);
      this.$stage.appendChild(this.$missing(src));
      return;
    }

    this.toggleAttribute("feature-hero", resolved.kind === "hero");
    this.syncAccessibility(resolved.label);
    this.$stage.appendChild(this.$resolvedAsset(resolved));
  }

  private syncAccessibility(label: Option<string>): void {
    if (this.decorative) {
      this.setAttribute("aria-hidden", "true");
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
      return;
    }

    this.removeAttribute("aria-hidden");
    this.setAttribute("role", "img");
    this.setAttribute("aria-label", this.alt ?? label ?? this.src ?? "");
  }

  private $resolvedAsset(
    asset: PresentationAssetRegistry.ResolvedAsset,
  ): HTMLElement {
    switch (asset.kind) {
      case "element":
        return asset.$element;
      case "hero": {
        const $hero = FeatureCardHero.makeWith(asset.props);
        $hero.setAttribute("inert", "");
        return $hero;
      }
      case "image": {
        const $img = document.createElement("img");
        $img.src = asset.src;
        $img.alt = this.decorative ? "" : this.alt ?? asset.alt ?? "";
        $img.loading = "lazy";
        $img.decoding = "async";
        return $img;
      }
      case "video": {
        const $video = document.createElement("video");
        $video.src = asset.src;
        $video.muted = true;
        $video.loop = true;
        $video.playsInline = true;
        $video.autoplay = true;
        $video.controls = false;
        if (asset.poster) $video.poster = asset.poster;
        return $video;
      }
    }
  }

  private $missing(text: string): HTMLElement {
    const $missing = document.createElement("div");
    $missing.className = "missing";
    $missing.textContent = text;
    return $missing;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        color: var(--text-ter);
      }

      :host([feature-hero]) {
        min-height: var(--feature-card-hero-min-height, 200px);
      }

      /* Containment guard for heroes/media; a consumer whose assets never
         overflow (e.g. std-page-card's contain-fit illustrations) can set the
         var to \`visible\` so asset drop-shadows aren't clipped at the stage
         edge. */
      #stage {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: inherit;
        overflow: var(--presentation-asset-overflow, hidden);
      }

      #stage > img,
      #stage > video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      #stage[data-fit="cover"] > img,
      #stage[data-fit="cover"] > video {
        object-fit: cover;
      }

      #stage > std-feature-card-hero {
        width: 100%;
        height: 100%;
        min-height: 100%;
      }

      .missing {
        --font-size: var(--text-10px);
        max-width: 100%;
        color: var(--text-ter);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  static $html = html`<div id="stage"></div>`;
}

export namespace PresentationAsset {
  export type Fit = "contain" | "cover";

  export type Props = {
    src: string;
    alt: Option<string>;
    fit: Option<Fit>;
    decorative: Option<boolean>;
    registry: Option<PresentationAssetRegistry>;
  };

  export function fitFromAttribute(value: Option<string>): Fit {
    return value === "cover" ? "cover" : "contain";
  }

  export function requiredSrc(src: string): string {
    const trimmed = src.trim();
    if (!trimmed) {
      throw new Error("std-presentation-asset requires a non-empty src");
    }
    return trimmed;
  }

  export function srcFromAttribute(value: Option<string>): Option<string> {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed || null;
  }
}
