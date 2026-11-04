import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Column } from "../../component-builtin";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { ListCellLayout } from "../../components/list/list-cell-layout";
import { AppThemeTokens } from "./app-theme-tokens";
import { Lightbox } from "../../components/lightbox/lightbox";

// A flat-grid thumbnail of a single raw asset (NOT wrapped in
// std-feature-card-hero). The asset lays out at ITS OWN intrinsic size — we do
// not impose a width, height, or aspect-ratio — and we only apply a uniform
// transform:scale to fit the cell width. Three modes:
//  - "scale":      shrink-wrap the asset to its intrinsic size, measure it, and
//    uniform-scale it to the cell width (up or down). Cell height follows.
//  - "responsive": render at the cell width with NO scale (for components whose
//    getBoundingClientRect/transforms break under a scaled ancestor, e.g. the
//    spotlight).
//  - "natural":    render in flow at the asset's intrinsic size × `zoom`, no
//    fit-to-cell scaling (the /dev/campaigns productionized review, where real
//    typography/spacing judgments need placement-true sizes). `zoom: 1` shows
//    raw raster pixels; `zoom: 0.5` shows the PHYSICAL size of a 2× retina
//    asset. CSS zoom (not transform) so the layout box shrinks with it and a
//    max-content grid track sizes correctly.
// Clicking opens a full-screen lightbox (std-lightbox) of the same asset.
@component({ name: "std-asset-preview" })
export class AssetPreview extends LonaWebComponent {
  private $viewport: HTMLElement = this.$("viewport");
  private $stage: HTMLElement = this.$("stage");
  private $meta: HTMLElement = this.$("meta");
  private sizing: AssetPreview.Sizing = { kind: "scale" };
  private lightboxProps: Option<Lightbox.Props>;
  private resizeObserver: Option<ResizeObserver>;

  static makeWith(props: AssetPreview.Props): AssetPreview {
    return (AssetPreview.make() as AssetPreview).bind(props);
  }

  bind(props: AssetPreview.Props): this {
    this.sizing = props.sizing;
    this.toggleAttribute("responsive", props.sizing.kind === "responsive");
    this.toggleAttribute("natural", props.sizing.kind === "natural");
    // Meta is suppressible for hosts whose own header already carries the
    // label (e.g. an atom card) — label/src still feed the lightbox.
    const showMeta = props.showMeta ?? true;
    this.toggleAttribute("no-meta", !showMeta);
    DomUtils.clearChildren(this.$meta);
    if (showMeta) {
      this.$meta.appendChild(this.$metaCell(props));
    }

    DomUtils.clearChildren(this.$stage);
    this.$stage.appendChild(props.makeContent());
    // When the asset's intrinsic width is known (a screenshot), PIN the stage to
    // it so it can't collapse to a tiny box while the image loads — or if it
    // fails. A collapsed stage makes fit() scale the chrome UP (the scale(7x)
    // blow-up) instead of shrinking it (in natural mode it would collapse the
    // box outright). Live components with no known size keep `width: max-content`
    // (clear the inline width).
    const pinnedWidth =
      props.sizing.kind === "scale" || props.sizing.kind === "natural"
        ? props.intrinsicSize?.width ?? null
        : null;
    this.$stage.style.width = pinnedWidth != null ? `${pinnedWidth}px` : "";
    // Natural mode's display factor (zoom shrinks the layout box too, so the
    // pane takes the zoomed size). Cleared for the other modes.
    this.$stage.style.zoom =
      props.sizing.kind === "natural" && props.sizing.zoom !== 1
        ? String(props.sizing.zoom)
        : "";
    // The preview is non-interactive: inert content lets the click fall through
    // to the viewport's lightbox handler instead of the live component.
    this.$stage.toggleAttribute("inert", props.inertContent);

    if (props.enableLightbox) {
      this.lightboxProps = {
        label: props.label,
        nativeSize: this.intrinsicSize(),
        makeContent: props.makeContent,
        inertContent: props.inertContent,
      };
      this.setAttribute("interactive", "");
      GESTURE_MANAGER.addPointerEvent(this.$viewport, {
        onClick: () => this.openLightbox(),
      });
    }

    this.fit();
    return this;
  }

  // The size the component gives us (its own laid-out size).
  private intrinsicSize(): Size {
    return {
      width: Math.max(1, this.$stage.offsetWidth),
      height: Math.max(1, this.$stage.offsetHeight),
    };
  }

  private openLightbox(): void {
    if (this.lightboxProps) {
      this.lightboxProps = {
        ...this.lightboxProps,
        nativeSize: this.intrinsicSize(),
      };
      Lightbox.show(this.lightboxProps);
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.$viewport);
    this.resizeObserver.observe(this.$stage);
    this.fit();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  // Uniform-scale the intrinsic asset to the cell width; size the cell to the
  // scaled height. No aspect-ratio is imposed — the asset keeps its own.
  // Only `scale` mode transforms; `responsive` and `natural` render in flow.
  private fit(): void {
    if (this.sizing.kind !== "scale") return;

    const cellWidth = this.$viewport.clientWidth;
    const naturalWidth = this.$stage.offsetWidth;
    const naturalHeight = this.$stage.offsetHeight;
    if (cellWidth <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return;

    const scale = cellWidth / naturalWidth;
    const transform = `scale(${scale})`;
    if (this.$stage.style.transform !== transform) {
      this.$stage.style.transform = transform;
    }
    const height = `${naturalHeight * scale}px`;
    if (this.$viewport.style.height !== height) {
      this.$viewport.style.height = height;
    }
  }

  private $metaCell(props: AssetPreview.Props): ListCellLayout<HTMLElement> {
    const $content = Column.make();
    $content.classList.add("list-cell-content");
    $content.style.alignItems = "start";
    $content.style.marginBlock = "0px";

    const $title = Typography.p(props.label, "small");
    $title.classList.add("text");
    $title.assignStyles({
      display: "-webkit-box",
      overflow: "hidden",
      textOverflow: "ellipsis",
      overflowWrap: "anywhere",
    });
    $title.style.setProperty("-webkit-box-orient", "vertical");
    $title.style.setProperty("-webkit-line-clamp", "1");

    const $caption = ListCellLayout.$caption(props.src);
    $caption.classList.add("text");
    // One ellipsized line — the full src (often a long unbreakable URL) shows
    // as the native tooltip instead of widening the host.
    $caption.title = props.src;
    $caption.assignStyles({
      "--margin-top": "4px",
      display: "block",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      // In the start-aligned content column, fit-content would floor at the
      // nowrap URL's min-content width; the cap makes hidden/ellipsis engage.
      maxWidth: "100%",
    });

    $content.append($title, $caption);

    const $cell = ListCellLayout.makeWith({ $content }, "small");
    $cell.classList.add("asset-preview-meta");
    $cell.assignStyles({
      "--list-cell-padding": "0px",
      "--list-cell-background-color": "transparent",
      "--list-cell-layout-hover-color": "transparent",
    });
    return $cell;
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      /* Live components bring their own (rounded) surface — the cell is just a
         transparent sizing container so a card's shadow can show. */
      #viewport {
        position: relative;
        width: 100%;
        overflow: visible;
      }

      :host([interactive]) #viewport {
        cursor: zoom-in;
      }

      /* Scale mode: the stage shrink-wraps the asset's intrinsic size (out of
         flow); fit() sets the viewport height to the scaled size. */
      #stage {
        position: absolute;
        top: 0;
        left: 0;
        width: max-content;
        transform-origin: top left;
        /* Render the asset in the native app LIGHT theme. The global app design
           system (colors.css / theme-base.css) is already inherited here; we only
           force its light-dark() tokens to resolve LIGHT, instead of overriding
           them with ad-hoc values. Scoped to the asset, not the cell/page. */
        color-scheme: light;
      }

      /* Responsive mode: render at the cell width in natural flow, no scale. */
      :host([responsive]) #stage {
        position: relative;
        top: auto;
        left: auto;
        width: 100%;
        transform: none;
      }

      /* Natural mode: render in flow at the asset's intrinsic size, no scale —
         width stays max-content (or the pinned intrinsic width from bind()). */
      :host([natural]) #stage {
        position: relative;
        top: auto;
        left: auto;
        transform: none;
      }

      /* Inert content is a non-interactive preview: let the click fall through
         to the viewport's lightbox handler instead of being swallowed. */
      #stage[inert] {
        pointer-events: none;
      }

      /* Hosts wrapping the preview in their own card chrome can inset the meta
         while the viewport runs full-bleed (custom properties pierce the
         shadow boundary; default keeps meta flush with the asset). Inline-size
         containment zeroes meta's intrinsic-width contribution so a long
         label/src can never widen the host past the asset — the text
         clamps/ellipsizes to the width the viewport establishes. */
      #meta {
        display: block;
        padding: var(--asset-preview-meta-inset, 0);
        contain: inline-size;
      }

      :host([no-meta]) #meta {
        display: none;
      }

      .asset-preview-meta {
        display: block;
      }

      .asset-preview-meta .list-cell-content {
        gap: 2px;
        /* Flex item in the cell row: without this, min-width:auto floors the
           cell at the caption's nowrap min-content and the ellipsis never
           engages — the URL just overflows the host. */
        min-width: 0;
        max-width: 100%;
      }
    `,
    // Re-establish the app palette on the asset stage (see AppThemeTokens) so a
    // brand surface (the landing's loaf DS) doesn't recolour the live preview.
    AppThemeTokens.stage,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="meta"></div>
    <div id="viewport"><div id="stage"></div></div>
  `;
}

export namespace AssetPreview {
  export type Sizing =
    | { kind: "scale" }
    | { kind: "responsive" }
    // zoom: display factor for the in-flow intrinsic render — 1 = raw raster
    // pixels, 0.5 = physical size of a 2× retina asset.
    | { kind: "natural"; zoom: number };

  export type Props = {
    label: string;
    src: string;
    makeContent: () => HTMLElement;
    enableLightbox: boolean;
    inertContent: boolean;
    sizing: Sizing;
    /**
     * Render the meta cell (label + src) above the asset. Defaults to true;
     * pass false when the host's own header already carries the label.
     */
    showMeta?: Option<boolean>;
    /**
     * The asset's intrinsic { width, height } in px, when known (e.g. a
     * screenshot). In `scale` mode this pins the stage width so it never
     * collapses while the image loads/fails — preventing fit() from upscaling
     * the chrome. Omit for live components that should shrink-wrap themselves.
     */
    intrinsicSize?: Option<Size>;
  };
}
