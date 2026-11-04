import { Storybook } from "../../ui/storybook";
import { WeatherTooltip } from "./weather-tooltip";

export class WeatherTooltipStoryBook extends Storybook.Default {
  title(): string {
    return "Weather Tooltip";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sunny Day",
        render: () => {
          return WeatherTooltip.makeWith({
            condition: { code: 1000 },
            avgtempF: 72,
            maxtempF: 80,
            mintempF: 65,
            avghumidity: 50,
            uv: 6,
          });
        },
      },
      {
        title: "Rainy Day",
        render: () => {
          return WeatherTooltip.makeWith({
            condition: { code: 1189 },
            avgtempF: 58,
            maxtempF: 62,
            mintempF: 54,
            avghumidity: 80,
            uv: 2,
          });
        },
      },
      {
        title: "Cloudy Day",
        render: () => {
          return WeatherTooltip.makeWith({
            condition: { code: 1006 },
            avgtempF: 65,
            maxtempF: 70,
            mintempF: 60,
            avghumidity: 65,
            uv: 3,
          });
        },
      },
      {
        title: "No Data",
        render: () => {
          return WeatherTooltip.makeWith(null);
        },
      },
    ];
  }
}
