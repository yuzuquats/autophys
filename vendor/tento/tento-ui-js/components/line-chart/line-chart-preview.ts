import { GraphData } from "@tento-core/chart/graph-data";

import { ChartPointerStore } from "./chart-pointer-store";
import { ChartViewModel } from "./chart-view-model";
import { LineChart } from "./line-chart";

export namespace LineChartPreview {
  const PERSONAL_ANALYTICS_CHART_WIDTH = 720;
  const PERSONAL_ANALYTICS_CHART_HEIGHT = 300;
  const PERSONAL_ANALYTICS_INSET = 10;
  const PERSONAL_ANALYTICS_X_RANGE = { start: 0, end: 100 };
  const PERSONAL_ANALYTICS_PADDED_RANGE = { start: -30, end: 130 };

  export function makePersonalAnalytics(): HTMLElement {
    const $stage = document.createElement("div");
    $stage.assignStyles({
      width: `${PERSONAL_ANALYTICS_CHART_WIDTH}px`,
      height: `${PERSONAL_ANALYTICS_CHART_HEIGHT}px`,
      display: "grid",
      placeItems: "center",
      boxSizing: "border-box",
    });

    const $chart = LineChart.make();
    $chart.assignStyles({
      display: "block",
      width: `${PERSONAL_ANALYTICS_CHART_WIDTH - PERSONAL_ANALYTICS_INSET * 2}px`,
      height: `${PERSONAL_ANALYTICS_CHART_HEIGHT - PERSONAL_ANALYTICS_INSET * 2}px`,
    });
    void bindPersonalAnalytics($chart);
    $stage.appendChild($chart);
    return $stage;
  }

  function personalAnalyticsPoints(): [number, number][] {
    const points: [number, number][] = [];
    for (
      let x = PERSONAL_ANALYTICS_PADDED_RANGE.start;
      x <= PERSONAL_ANALYTICS_PADDED_RANGE.end;
      x += 1
    ) {
      const trend = -0.34 + x * 0.0063;
      const weeklyCycle = Math.sin((x + 8) / 8) * 0.13;
      const contextCycle = Math.sin((x + 2) / 19) * 0.08;
      const jitter =
        deterministicNoise(x) * 0.78 +
        deterministicNoise(x + 37) * 0.34 +
        deterministicNoise(x + 89) * 0.18 +
        Math.sin(x * 2.8) * 0.18 +
        Math.sin(x * 6.3) * 0.1;
      const y = Math.max(
        -0.98,
        Math.min(0.98, trend + weeklyCycle + contextCycle + jitter),
      );
      points.push([x, y]);
    }
    return points;
  }

  function deterministicNoise(x: number): number {
    const raw = Math.sin(x * 12.9898) * 43758.5453;
    return raw - Math.floor(raw) - 0.5;
  }

  async function bindPersonalAnalytics($chart: LineChart): Promise<void> {
    const graphData = new GraphData.WithRegression(null, null);
    await graphData.populate(
      PERSONAL_ANALYTICS_X_RANGE,
      PERSONAL_ANALYTICS_PADDED_RANGE,
      personalAnalyticsPoints(),
      "gtm-personal-analytics",
      null,
    );
    $chart.bind({
      vm: new ChartViewModel(
        new ChartPointerStore(),
        graphData.toCollection({
          range: ChartViewModel.AxisRange.UNIT,
        }),
      ),
      xRange: PERSONAL_ANALYTICS_X_RANGE,
      yPadding: 20,
    });
  }
}
