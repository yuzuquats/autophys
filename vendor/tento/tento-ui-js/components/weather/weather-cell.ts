import { NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

@component({
  name: "std-weather-cell",
})
export class WeatherCell extends LonaWebComponent {
  private $days: WeatherDay[] = [];

  onRecycle(): void {
    super.onRecycle();
    this.$days = [];
  }

  bind(props: WeatherCell.Props) {
    const { weathers } = props;

    // Grow: create missing days
    while (this.$days.length < weathers.length) {
      const $day = WeatherDay.make();
      this.$days.push($day);
      this.appendChild($day);
    }

    // Shrink: remove excess days
    while (this.$days.length > weathers.length) {
      const $day = this.$days.pop()!;
      $day.remove();
    }

    // Rebind all
    for (let i = 0; i < weathers.length; i++) {
      const { weather, date, loading } = weathers[i];
      this.$days[i].setAttribute("data-date", date.toString());
      this.$days[i].bind(weather, loading ?? false);
      this.$days[i].onpointerenter = () =>
        props.showTooltip({ weather, date, loading });
      this.$days[i].onpointerleave = () => props.hideTooltip(date);
    }
  }

  static $styles = [
    css`
      slot::slotted(*) {
        flex: 1;
      }

      #root {
        height: 100%;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <slot></slot>
    </std-row>
  `;
}

@component({
  name: "std-weather-day",
})
export class WeatherDay extends LonaWebComponent {
  $condition = this.$("condition");

  static makeWith(
    day: Option<WeatherCell.Day>,
    loading: boolean = false,
  ): WeatherDay {
    const $w = WeatherDay.make();
    $w.bind(day, loading);
    return $w;
  }

  bind(day: Option<WeatherCell.Day>, loading: boolean = false) {
    if (loading && day == null) {
      this.$condition.textContent = "";
      this.toggleAttribute("loading", true);
    } else {
      this.$condition.textContent = WeatherDay.conditionEmoji(day?.condition);
      this.toggleAttribute("loading", false);
    }
    this.style.removeProperty("pointer-events");
  }

  static $styles = [
    css`
      :host {
        cursor: default;
        position: relative;
      }

      :host(:hover)::before {
        content: "";
        position: absolute;
        border-radius: 6px;
        inset: 4px 6px;
        background: var(--bg-hover);
      }

      :host([loading]) #condition::before {
        content: "";
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--divider);
        animation: pulse 1.2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.8; }
      }

      #root {
        height: var(--height);
        justify-content: center;
        align-items: center;
        transform: scale(calc(1 / var(--scale, 1)))
      }

      #temp {
        --font-size: var(--small-size);
      }

      #condition {
        color: var(--text-ter);
        --font-size: var(--h5-size);
      }

      #condition-text {
        --margin-bottom: 6px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <p id="condition"></p>
    </std-col>
  `;
}

export namespace WeatherDay {
  const conditionMap = new Map([
    [1000, "☀️"], // sunny
    [1003, "⛅️"], // partly cloudy
    [1006, "☁️"], // cloudy
    [1009, "☁️"], // overcast
    // [1030, ""], // mist
    [1063, "🌧️"], // Patchy rain possible
    [1186, "🌧️"], // Moderate rain at times
    [1189, "🌧️"], // Moderate rain
    [1192, "🌧️"], // Heavy rain at times
    [1240, "🌧️"], // light rain shower
    [1243, "🌧️"], // Moderate or heavy rain shower
  ]);

  export function conditionEmoji(condition: Option<{ code: number }>): string {
    if (condition == null) return "·";
    const emoji = conditionMap.get(condition.code);
    if (emoji != null) return emoji;
    return "·";
  }

  export function temperatureDisplay(temp: Option<number>): string {
    if (temp == null) return "-";
    return `${temp}° F`;
  }
}

export namespace WeatherCell {
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

  export interface WeatherData {
    date: NaiveDate;
    weather: Option<Day>;
    loading?: boolean | undefined;
  }

  export type Props = {
    weathers: WeatherData[];
    showTooltip: (weather: WeatherData) => void;
    hideTooltip: (date: NaiveDate) => void;
  };
}
