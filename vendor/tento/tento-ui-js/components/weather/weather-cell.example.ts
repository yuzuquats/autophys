import { Storybook } from "../../ui/storybook";
import { NaiveDate } from "@tento-chrono";
import { WeatherCell } from "./weather-cell";

export class WeatherCellStoryBook extends Storybook.Default {
  title(): string {
    return "Weather Cell";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Weather Cell - Sunny",
        render: () => {
          const today = NaiveDate.today();
          const $cell = WeatherCell.make();
          $cell.assignStyles({
            "--height": "48px",
            width: "100%",
            maxWidth: "240px",
          });
          $cell.bind({
            weathers: [
              {
                date: today,
                weather: {
                  condition: { code: 1000 },
                  avgtempF: 72,
                  maxtempF: 80,
                  mintempF: 65,
                  avghumidity: 50,
                  uv: 6,
                },
              },
            ],
            showTooltip: (weather) => {
              console.log("Show tooltip for:", weather.date.toString());
            },
            hideTooltip: (date) => {
              console.log("Hide tooltip for:", date.toString());
            },
          });
          return $cell;
        },
      },
      {
        title: "Weather Cell - Rainy",
        render: () => {
          const today = NaiveDate.today();
          const $cell = WeatherCell.make();
          $cell.assignStyles({
            "--height": "48px",
            width: "100%",
            maxWidth: "240px",
          });
          $cell.bind({
            weathers: [
              {
                date: today,
                weather: {
                  condition: { code: 1189 },
                  avgtempF: 58,
                  maxtempF: 62,
                  mintempF: 54,
                  avghumidity: 80,
                  uv: 2,
                },
              },
            ],
            showTooltip: (weather) => {
              console.log("Show tooltip for:", weather.date.toString());
            },
            hideTooltip: (date) => {
              console.log("Hide tooltip for:", date.toString());
            },
          });
          return $cell;
        },
      },
      {
        title: "Weather Cell - With Outline",
        render: () => {
          const today = NaiveDate.today();
          const $cell = WeatherCell.make();
          $cell.assignStyles({
            "--height": "48px",
            width: "100%",
            maxWidth: "240px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
          $cell.bind({
            weathers: [
              {
                date: today,
                weather: {
                  condition: { code: 1003 },
                  avgtempF: 68,
                  maxtempF: 75,
                  mintempF: 62,
                  avghumidity: 60,
                  uv: 5,
                },
              },
            ],
            showTooltip: (weather) => {
              console.log("Show tooltip for:", weather.date.toString());
            },
            hideTooltip: (date) => {
              console.log("Hide tooltip for:", date.toString());
            },
          });
          return $cell;
        },
      },
      {
        title: "Weather Cell - No Data",
        render: () => {
          const today = NaiveDate.today();
          const $cell = WeatherCell.make();
          $cell.assignStyles({
            "--height": "48px",
            width: "100%",
            maxWidth: "240px",
          });
          $cell.bind({
            weathers: [
              {
                date: today,
                weather: undefined,
              },
            ],
            showTooltip: (weather) => {
              console.log("Show tooltip for:", weather.date.toString());
            },
            hideTooltip: (date) => {
              console.log("Hide tooltip for:", date.toString());
            },
          });
          return $cell;
        },
      },
    ];
  }
}
