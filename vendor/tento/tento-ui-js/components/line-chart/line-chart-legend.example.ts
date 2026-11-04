import { Storybook } from "../../ui/storybook";
import { ChartViewModel, castData } from "./chart-view-model";
import { ChartPointerStore } from "./chart-pointer-store";
import { LineChartLegend } from "./line-chart-legend";
import { GraphData } from "@tento-core/chart/graph-data";

export class LineChartLegendStoryBook extends Storybook.Default {
  title(): string {
    return "Line Chart Legend";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Legend with Mock Data",
        render: async () => {
          const graphData = new GraphData.Generated();
          await graphData.populate({
            start: 0,
            end: 100,
          });
          const vm = new ChartViewModel(
            new ChartPointerStore(),
            graphData.toCollection({
              range: ChartViewModel.AxisRange.HALF_UNIT,
            }),
          );
          vm.bindSize(
            {
              height: 400,
              width: 0,
            },
            false,
          );

          const $legend = LineChartLegend.make();
          $legend.bind({
            vm,
            yScaler: new ChartViewModel.LinearYScaler({
              range: {
                min: castData(-1),
                max: castData(1),
                center: castData(0),
              },
            }, null),
            yPadding: 20,
          });
          $legend.style.height = "400px";

          return $legend;
        },
      },
      // {
      //   title: "Legend with Placeholder (No Data)",
      //   render: () => {
      //     const pointerStore = new ChartPointerStore();

      //     const $legend = LineChartLegend.make();
      //     $legend.bind({
      //       heightPx: 400,
      //       pointerStore,
      //       yRange: {
      //         min: 0,
      //         max: 100,
      //         center: 50,
      //       },
      //     });
      //     $legend.style.height = "400px";

      //     return $legend;
      //   },
      // },
      // {
      //   title: "Interactive Legend with Cursor Tracking",
      //   render: () => {
      //     const pointerStore = new ChartPointerStore();

      //     const $legend = LineChartLegend.make();
      //     $legend.bind({
      //       heightPx: 400,
      //       pointerStore,
      //       yScale: 600,
      //       horizontalRuleOffset: 40,
      //       yRange: { min: 20, max: 100, center: 60 },
      //     });

      //     // Create container with button to simulate pointer events
      //     const $container = Column.make();
      //     $container.style.gap = "16px";

      //     const $card = Card.makeWith($legend, "flat").assignStyles({
      //       "--card-padding": "16px",
      //       background: "var(--bg)",
      //       height: "450px",
      //       width: "100px",
      //     });

      //     const $button = Button.makeWith("Simulate Cursor at Y=75", {
      //       style: "secondary",
      //       onClick: () => {
      //         pointerStore.updatePointer({
      //           chartId: "test-chart",
      //           globalX: 100,
      //           globalY: 200,
      //           dataX: 50,
      //           dataY: 75,
      //           yRange: { min: 20, max: 100, center: 60 },
      //           chartBounds: new DOMRect(0, 0, 800, 600),
      //         });
      //       },
      //     });

      //     const $clearButton = Button.makeWith("Clear Cursor", {
      //       style: "secondary",
      //       onClick: () => {
      //         pointerStore.clearPointer("test-chart");
      //       },
      //     });

      //     const $buttonRow = Column.make();
      //     $buttonRow.style.gap = "8px";
      //     $buttonRow.appendChild($button);
      //     $buttonRow.appendChild($clearButton);

      //     $container.appendChild($card);
      //     $container.appendChild($buttonRow);

      //     return $container;
      //   },
      // },
      // {
      //   title: "Legend with Different Y Ranges",
      //   render: () => {
      //     const pointerStore = new ChartPointerStore();

      //     const $legend = LineChartLegend.make();
      //     $legend.bind({
      //       heightPx: 400,
      //       pointerStore,
      //       yScale: 600,
      //       horizontalRuleOffset: 40,
      //       yRange: { min: -120, max: 80, center: -20 },
      //     });
      //     $legend.style.height = "400px";

      //     return $legend;
      //   },
      // },
    ];
  }
}
