import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-landing-metric" })
export class LandingMetric extends LonaWebComponent {
  static makeWith(props: LandingMetric.Props): LandingMetric {
    return (LandingMetric.make() as LandingMetric).bind(props);
  }

  bind(props: LandingMetric.Props): this {
    {
      const $value = document.createElement("p");
      $value.className = "metric-value";
      $value.slot = "value";
      $value.textContent = props.value;
      this.appendChild($value);
    }

    {
      const $label = document.createElement("p");
      $label.className = "kicker";
      $label.slot = "label";
      $label.textContent = props.label;
      this.appendChild($label);
    }

    return this;
  }

  static $html = html`
    <std-col id="inner">
      <slot name="value"></slot>
      <slot name="label"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: inline-block;
        border-radius: 14px;
        padding: 20px 24px;
        background: var(--bg);
        border: 1px solid var(--divider);
      }

      #inner {
        gap: 6px;
      }

      ::slotted(.metric-value) {
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      ::slotted(.kicker) {
        text-transform: uppercase;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }
    `,
  ];
}

export namespace LandingMetric {
  export type Props = {
    value: string;
    label: string;
  };
}
