// Side-effect imports: register <std-geometry-field> + the storybook control elements. The
// classes below are referenced ONLY as types, so a bare named import would be elided at runtime
// and the element would never upgrade (`this.$field.bind is not a function`).
import "./geometry-field";
import "../../../components/controls/slider";
import "../../../components/controls/inline-select";

import { html, LonaWebComponent } from "../../../component";
import { component } from "../../../component-decorators";
import { css } from "../../../component-styles";
import { Storybook } from "../../../ui/storybook";
import { DefaultSlider } from "../../../components/controls/slider";
import { InlineSelect } from "../../../components/controls/inline-select";
import { PropertyList } from "../../../components/input/property-list";
import { ClusterGrowthSource } from "./cluster-growth-source";
import type { GeometryField } from "./geometry-field";

// Resizable preview of the BASELINE geometry source. Drag the handle to resize the frame: the
// blobs keep their absolute size while the count grows to fill — i.e. it re-generates at the new
// size instead of transform-scaling. Storybook controls (blob size, spread, colors) live in the
// card footer; the status line reports that mean radius tracks the blob-size knob regardless of
// the frame dimensions.
@component({ name: "std-geometry-field-preview" })
class GeometryFieldPreview extends LonaWebComponent {
  private $field: GeometryField = this.hydrate("field");
  private $frame: HTMLElement = this.$("frame");
  private $handle: HTMLElement = this.$("handle");

  private width = 360;
  private height = 240;
  private blobSizePx = ClusterGrowthSource.DEFAULT.blobSizePx;
  private spread = ClusterGrowthSource.DEFAULT.spread;
  private sizeJitter = ClusterGrowthSource.DEFAULT.sizeJitter;
  private sizeScaleFactor = ClusterGrowthSource.DEFAULT.sizeScaleFactor;

  // Composed status lines (width/height + live stats) pushed to the footer StatusLine.
  onStatus: Option<(lines: string[]) => void> = null;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private startWidth = 0;
  private startHeight = 0;

  static makeWith(): GeometryFieldPreview {
    return (GeometryFieldPreview.make() as GeometryFieldPreview).bind();
  }

  bind(): this {
    this.$field.onRender = (stats) => this.renderStatus(stats);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.$handle.addEventListener("pointerdown", this.handlePointerDown);
    this.$handle.addEventListener("pointermove", this.handlePointerMove);
    this.$handle.addEventListener("pointerup", this.handlePointerUp);
    this.$handle.addEventListener("pointercancel", this.handlePointerUp);
    this.applyFrameSize();
    this.applySource();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.$handle.removeEventListener("pointerdown", this.handlePointerDown);
    this.$handle.removeEventListener("pointermove", this.handlePointerMove);
    this.$handle.removeEventListener("pointerup", this.handlePointerUp);
    this.$handle.removeEventListener("pointercancel", this.handlePointerUp);
  }

  setBlobSize(px: number): void {
    this.blobSizePx = px;
    this.applySource();
  }

  setSpread(spread: number): void {
    this.spread = spread;
    this.applySource();
  }

  setSizeJitter(sizeJitter: number): void {
    this.sizeJitter = sizeJitter;
    this.applySource();
  }

  // How strongly blob size tracks the canvas dimension (0 = constant, 1 = proportional). Rebuilds
  // the source — blob size + count both depend on it.
  setSizeScale(factor: number): void {
    this.sizeScaleFactor = factor;
    this.applySource();
  }

  // Wash blur ↔ sharpness — a render-only knob on the field (no geometry rebuild), so the blobs
  // stay smooth; this controls how soft/crisp the gradient edges are in Wash mode.
  setBlur(frac: number): void {
    this.$field.setWashBlur(frac);
  }

  // How much of the wash resolves sharp (sub-blob patches) — render-only.
  setSharpen(amount: number): void {
    this.$field.setWashSharpen(amount);
  }

  setMode(mode: GeometryField.RenderMode): void {
    this.$field.setMode(mode);
  }

  // Rebuild the source from the current knob values; the resize handle only resizes the frame —
  // the field's own ResizeObserver re-generates at the new size (the whole point).
  private applySource(): void {
    this.$field.bind(
      ClusterGrowthSource.create({
        ...ClusterGrowthSource.DEFAULT,
        blobSizePx: this.blobSizePx,
        spread: this.spread,
        sizeJitter: this.sizeJitter,
        sizeScaleFactor: this.sizeScaleFactor,
      }),
    );
  }

  private applyFrameSize(): void {
    this.$frame.style.width = `${this.width}px`;
    this.$frame.style.height = `${this.height}px`;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.startWidth = this.width;
    this.startHeight = this.height;
    this.$handle.setPointerCapture(event.pointerId);
    this.$handle.style.background = "var(--blue-dimmed)";
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) return;
    this.width = Math.max(140, this.startWidth + event.clientX - this.dragStartX);
    this.height = Math.max(120, this.startHeight + event.clientY - this.dragStartY);
    this.applyFrameSize();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.isDragging) return;
    this.isDragging = false;
    if (this.$handle.hasPointerCapture(event.pointerId)) {
      this.$handle.releasePointerCapture(event.pointerId);
    }
    this.$handle.style.background = "var(--blue)";
  };

  private renderStatus(stats: GeometryField.Stats): void {
    this.onStatus?.([
      `${this.width} × ${this.height} · ${stats.count} blobs`,
      `r ≈ ${stats.meanRadius}px (target ${stats.blobSizePx}) · coverage ${
        Math.round(stats.coverage * 100)
      }%`,
    ]);
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }

      #stage {
        min-height: 360px;
        display: grid;
        place-items: center;
        padding: 26px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background:
          linear-gradient(
            90deg,
            color-mix(in srgb, var(--divider) 48%, transparent) 1px,
            transparent 1px
          ),
          linear-gradient(
            color-mix(in srgb, var(--divider) 48%, transparent) 1px,
            transparent 1px
          ),
          color-mix(in srgb, var(--bg) 94%, var(--text-pri) 6%);
        background-size: 24px 24px;
      }

      #frame {
        position: relative;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--divider) 72%, transparent);
        box-shadow: 0 16px 34px color-mix(in srgb, var(--text-pri) 12%, transparent);
        background: var(--bg);
      }

      #field {
        display: block;
        width: 100%;
        height: 100%;
      }

      #handle {
        position: absolute;
        right: -7px;
        bottom: -7px;
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: var(--blue);
        cursor: nwse-resize;
        box-shadow: 0 2px 8px color-mix(in srgb, var(--text-pri) 26%, transparent);
        touch-action: none;
      }
    `,
  ];

  static $html = html`
    <div id="stage">
      <div id="frame">
        <std-geometry-field id="field"></std-geometry-field>
        <div id="handle"></div>
      </div>
    </div>
  `;
}

// Storybook controls, built the way the Round example does it: a PropertyList of labeled
// controls wired straight to the preview's setters (slider value is continuous, so spread rides
// a percentage range).
namespace Controls {
  export type State = {
    blobSizePx: number;
    sizeScaleFactor: number; // blob size ↔ canvas (0 = constant, 1 = proportional)
    spread: number;
    sizeJitter: number;
    washBlur: number; // wash softness fraction (blur ↔ sharpness)
    washSharpen: number; // 0..1 how much of the wash resolves sharp
    mode: GeometryField.RenderMode;
  };

  const MODES: ReadonlyArray<{ id: GeometryField.RenderMode; label: string }> = [
    { id: "geometry", label: "Geometry" },
    { id: "colored", label: "Colored" },
    { id: "wash", label: "Wash" },
  ];

  function renderSelect(state: State, $preview: GeometryFieldPreview): InlineSelect<GeometryField.RenderMode> {
    const $select = InlineSelect.make() as InlineSelect<GeometryField.RenderMode>;
    $select.assignStyles({ width: "160px" });
    $select.bind({
      items: MODES.map((m) =>
        InlineSelect.Text({
          id: m.id,
          label: m.label,
          data: m.id,
          selected: m.id === state.mode,
        })
      ),
      onSelect: (item) => $preview.setMode(item.data),
    });
    return $select;
  }

  export function build(
    state: State,
    $preview: GeometryFieldPreview,
  ): PropertyList.Items {
    return {
      blobSize: {
        $e: DefaultSlider.make()
          .setBounds({ start: 24, end: 90 }, state.blobSizePx)
          .addOnChange((value) => $preview.setBlobSize(Math.round(value)))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Blob size",
        order: 0,
      },
      sizeScale: {
        $e: DefaultSlider.make()
          .setBounds({ start: 0, end: 100 }, state.sizeScaleFactor * 100)
          .addOnChange((value) => $preview.setSizeScale(value / 100))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Size ↔ canvas",
        order: 1,
      },
      spread: {
        $e: DefaultSlider.make()
          .setBounds({ start: 100, end: 250 }, state.spread * 100)
          .addOnChange((value) => $preview.setSpread(value / 100))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Spread",
        order: 2,
      },
      sizeVariance: {
        $e: DefaultSlider.make()
          .setBounds({ start: 0, end: 80 }, state.sizeJitter * 100)
          .addOnChange((value) => $preview.setSizeJitter(value / 100))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Size variance",
        order: 3,
      },
      washBlur: {
        $e: DefaultSlider.make()
          .setBounds({ start: 8, end: 55 }, state.washBlur * 100)
          .addOnChange((value) => $preview.setBlur(value / 100))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Blur (wash)",
        order: 4,
      },
      washSharpen: {
        $e: DefaultSlider.make()
          .setBounds({ start: 0, end: 100 }, state.washSharpen * 100)
          .addOnChange((value) => $preview.setSharpen(value / 100))
          .assignStyles<DefaultSlider>({ marginTop: "17px", width: "200px" }),
        label: "Sharpen (wash)",
        order: 5,
      },
      mode: {
        $e: renderSelect(state, $preview),
        label: "Render",
        order: 6,
      },
    };
  }
}

export class GeometryFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Geometry Field — cluster-growth (baseline)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Resize → constant blob size, count fills the area",
        render: () => {
          const $preview = GeometryFieldPreview.makeWith();
          const $status = Storybook.Card.StatusLine.make();
          $preview.onStatus = (lines) => $status.bindText(lines);
          const state: Controls.State = {
            blobSizePx: ClusterGrowthSource.DEFAULT.blobSizePx,
            sizeScaleFactor: ClusterGrowthSource.DEFAULT.sizeScaleFactor,
            spread: ClusterGrowthSource.DEFAULT.spread,
            sizeJitter: ClusterGrowthSource.DEFAULT.sizeJitter,
            washBlur: 0.28, // seeds the slider; matches GeometryField's default WASH_SOFTNESS_FRAC
            washSharpen: 0.4, // seeds the slider; matches GeometryField's WASH_SHARPEN_DEFAULT
            mode: "geometry",
          };
          return {
            $status,
            $controls: PropertyList.makeWith(Controls.build(state, $preview)),
            $content: $preview,
          };
        },
      },
    ];
  }
}
