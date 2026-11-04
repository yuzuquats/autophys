import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";
import { LazySync } from "@tento-ui/lazy";
import { Shimmer } from "../shimmer";
import { Typography } from "@tento-ui/ui/typography";

@component({
  name: "std-weather-tooltip",
})
export class WeatherTooltip extends LonaWebComponent {
  private static _instance = new LazySync(() => WeatherTooltip.make());
  static get instance(): WeatherTooltip {
    return WeatherTooltip._instance.get();
  }

  static makeWith(day: Option<WeatherTooltip.Day>): WeatherTooltip {
    const $w = WeatherTooltip.make();
    $w.bind(day);
    return $w;
  }

  /** Set the loading attribute before binding null to shimmer the existing reading layout. */
  bind(day: Option<WeatherTooltip.Day>): WeatherTooltip {
    const $attributes = this.$("attributes");
    DomUtils.clearChildren($attributes);
    const loading = this.hasAttribute("loading");
    if (!day && !loading) {
      this.$("hero").replaceChildren();
      $attributes.appendChild(Typography.small("No weather information"));
      return this;
    }

    const reading = loading ? null : day;
    const degreeF = "\u00B0F";
    const $temperature = Typography.h1(reading ? `${reading.avgtempF}${degreeF}` : "\u00A0", "h1");
    $temperature.classList.toggle("loading-reading", loading);
    $temperature.classList.toggle("loading-shimmer", loading);
    this.$("hero").replaceChildren($temperature);
    const readings: [string, string][] = [
      ["High", reading ? `${reading.maxtempF}${degreeF}` : "\u00A0"],
      ["Low", reading ? `${reading.mintempF}${degreeF}` : "\u00A0"],
      ["Humidity", reading ? `${reading.avghumidity}` : "\u00A0"],
      ["uv", reading ? `${reading.uv}` : "\u00A0"],
    ];
    for (const [label, value] of readings) {
      $attributes.appendChild(TooltipRow.makeWith({ label, value, loading }));
    }
    return this;
  }

  static $styles: Style.Compat[] = [
    Shimmer.$style,
    css`
      :host {
        pointer-events: none;
      }

      #root {
        margin-top: 4px;
        width: 178px;
        border-radius: 12px;
        padding: 2px;
        box-shadow: var(--box-shadow);
        background: var(--bg-elevated);
        color: var(--text-sec);
      }

      #hero {
        height: 120px;
        width: 100%;
        background: var(--bg-surface);
        color: var(--text-pri);
        border-radius: 10px;
        margin-bottom: 2px;
      }

      .loading-reading {
        width: 76px;
        border-radius: 5px;
      }

      .loading-shimmer {
        --shimmer-background: linear-gradient(100deg,
          var(--bg-hover-opaque) 15%, var(--bg-elevated) 45%,
          var(--bg-hover-opaque) 75%);
        background-size: 300% 100%;
        animation-duration: 4.8s;
        animation-name: weather-reading-shimmer;
      }

      @keyframes weather-reading-shimmer {
        from { background-position: 150% 0; }
        to { background-position: -150% 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        .loading-shimmer {
          animation: none;
        }
      }

      #attributes {
        padding: 10px;
      }

      #attributes * {
        padding-bottom: 7px;
        margin-bottom: 7px;
        border-bottom: 1px solid var(--divider);
      }

      #attributes *:last-child {
        padding-bottom: 0px;
        margin-bottom: 0px;
        border-bottom: unset;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-center id="hero"></std-center>
      <std-col id="attributes"></std-col>
    </std-col>
  `;
}

@component({
  name: "std-weather-tooltip-row",
})
class TooltipRow extends LonaWebComponent {
  static makeWith(props: { label: string; value: string; loading: boolean }): TooltipRow {
    return TooltipRow.make().bind(props);
  }

  bind(props: { label: string; value: string; loading: boolean }): TooltipRow {
    this.$("label").textContent = props.label;
    this.$("value").textContent = props.value;
    this.$("value").classList.toggle("loading-shimmer", props.loading);
    return this;
  }

  static $styles: Style.Compat[] = [
    Shimmer.$style,
    css`
      #root {
        justify-content: space-between;
      }

      #value.loading-shimmer {
        width: 44px;
        border-radius: 3px;
        --shimmer-background: linear-gradient(100deg,
          var(--bg-hover-opaque) 15%, var(--bg-elevated) 45%,
          var(--bg-hover-opaque) 75%);
        background-size: 300% 100%;
        animation-duration: 4.8s;
        animation-name: weather-reading-shimmer;
      }

      @keyframes weather-reading-shimmer {
        from { background-position: 150% 0; }
        to { background-position: -150% 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        #value.loading-shimmer {
          animation: none;
        }
      }

      #value {
        font-weight: 600;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<std-row id="root">
    <p class="small" id="label"></p>
    <p class="small" id="value"></p>
  </std-row>`;
}

export namespace WeatherTooltip {
  export interface Day {
    condition?: {
      code: number;
    };
    avgtempF: number;
    maxtempF: number;
    mintempF: number;
    avghumidity: number;
    uv: number;
  }
}
