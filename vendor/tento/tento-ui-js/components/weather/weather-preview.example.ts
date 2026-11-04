import { Storybook } from "../../ui/storybook";
import { WeatherPreview } from "./weather-preview";

export class WeatherPreviewStoryBook extends Storybook.Default {
  title(): string {
    return "Weather Preview";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Temperature",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "160px",
            height: "140px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({ label: "Temperature", value: "72°F" }),
          );
          return $container;
        },
      },
      {
        title: "Humidity",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "120px",
            height: "140px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({ label: "Humidity", value: "65%" }),
          );
          return $container;
        },
      },
      {
        title: "UV Index",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "160px",
            height: "160px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({ label: "UV", value: "6" }),
          );
          return $container;
        },
      },
      {
        title: "Condition",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "160px",
            height: "160px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({ label: "Condition", value: "Sunny" }),
          );
          return $container;
        },
      },
      {
        title: "Precipitation",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "160px",
            height: "160px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({
              label: "Precipitation",
              value: "0.2 in",
            }),
          );
          return $container;
        },
      },
      {
        title: "No Data",
        render: () => {
          const $container = WeatherPreview.Container.makeWith().assignStyles({
            width: "100%",
            maxWidth: "160px",
            height: "160px",
          });
          $container.appendChild(
            WeatherPreview.make().bind({
              label: "Temperature",
              value: "No Data",
            }),
          );
          return $container;
        },
      },
    ];
  }
}
