import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";

@component({
  name: "std-chart-tick-mark",
})
export class ChartTickMark extends LonaWebComponent {
  bind(props: ChartTickMark.Props) {
    this.setAttribute("dbg", String(props.positionPx));
    this.style.bottom = props.positionPx - 0.5 + "px";
    const $label = this.$("label");
    $label.textContent = props.label;
  }

  static $labelStyle = css`
    .label {
      white-space: pre-wrap;
      font-family: monospace;
      text-align: end;
      /* Zero the inherited Typography paragraph margins — otherwise the
         asymmetric top/bottom margin shifts the label ~2-4px below the tick's
         centered anchor (it sat low vs the chart gridlines). */
      --margin-top: 0px;
      --margin-bottom: 0px;
    }
  `;

  static $styles: Style.Compat[] = [
    ChartTickMark.$labelStyle,
    css`
      :host {
        position: absolute;
        right: 0px;
        width: 100%;
        height: 1px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        font-size: 10px;
        /* Knob with the historical value as its fallback: a host (the sheet
           legend's condensed lane) may quiet the tick ink without reaching
           into this shadow tree. */
        color: var(--std-chart-tick-color, var(--text-sec));
      }

      #root {
        align-items: center;
        width: 100%;
        padding-left: 4px;
        background: var(--std-line-chart-legend-bg);
        padding-block: 8px;
        border-radius: 12px;
      }

      #dash {
        margin-left: 4px;
        width: 4px;
        height: 1px;
        background-color: var(--divider-pri);
        opacity: 1;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id=root>
      <std-spacer></std-spacer>
      <p id="label" class=small class=label></p>
      <div id="dash"></div>
    </std-row>
  `;
}

export namespace ChartTickMark {
  /**
   * Props for the ChartTickMark component
   * @property label - The text to display for this tick mark
   * @property positionPx - The vertical position in pixels from the top of the container
   * @property isRule - Whether this tick aligns with a horizontal rule in the chart (shows dash)
   * @property isCursor - Whether this tick is tracking cursor position (different styling)
   */
  export interface Props {
    label: string;
    positionPx: number;
  }
}
