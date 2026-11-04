import { Storybook } from "../../ui/storybook";
import "./landing-metric";
import { LandingMetric } from "./landing-metric";

export class LandingMetricStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Metric";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Metrics row",
        render: () => {
          const $row = document.createElement("div");
          $row.style.display = "flex";
          $row.style.flexWrap = "wrap";
          $row.style.gap = "10px";
          $row.style.alignItems = "center";
          $row.appendChild(LandingMetric.makeWith({ value: "100M+", label: "users reached" }));
          $row.appendChild(LandingMetric.makeWith({ value: "62%", label: "Fortune 100 usage" }));
          $row.appendChild(LandingMetric.makeWith({ value: "3.2x", label: "faster launches" }));
          return $row;
        },
      },
    ];
  }
}
