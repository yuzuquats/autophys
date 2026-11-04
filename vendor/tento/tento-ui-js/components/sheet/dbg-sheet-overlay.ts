import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

@component({
  name: "std-debug-overlay",
})
export class SheetDebugOverlay extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");

  bind(props: SheetDebugOverlay.Props): this {
    this.$label.textContent = props.label;
    this.style.setProperty("--overlay-color", props.color);
    this.style.setProperty(
      "--overlay-width",
      `${Math.max(1, props.widthPx)}px`,
    );
    this.style.setProperty(
      "--overlay-height",
      `${Math.max(1, Math.round(props.heightPx))}px`,
    );
    return this;
  }

  static override $styles = [
    css`
      :host {
        display: block;
        pointer-events: none;
        box-sizing: border-box;
        box-shadow: inset 0 0 0 1px
          color-mix(in srgb, var(--overlay-color, var(--orange)) 30%, transparent);
        background: transparent;
        width: var(--overlay-width, 1px);
        height: var(--overlay-height, 1px);
        overflow: hidden;
        border-radius: 4px;
        z-index: 1000; /* ZIndex.FLOATING_PANEL */
      }

      #label {
        display: inline-block;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: var(--h6-size);
        line-height: 1.2;
        padding: 2px 4px;
        background: color-mix(
          in srgb,
          var(--overlay-color, var(--orange)) 30%,
          transparent
        );
        color: var(--text-pri);
      }
    `,
  ];

  static override $html = html`<div id="label"></div>`;
}

export namespace SheetDebugOverlay {
  export type Props = {
    label: string;
    color: string;
    widthPx: number;
    heightPx: number;
  };
}
