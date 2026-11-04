import { Storybook } from "../../ui/storybook";
import { ChartViewModel } from "./chart-view-model";
import { ChartPointerStore } from "./chart-pointer-store";
import { LineChart } from "./line-chart";
import { GraphData } from "@tento-core/chart/graph-data";
import { LineChartBody } from "./line-chart-body";

export class LineChartStoryBook extends Storybook.Default {
  title(): string {
    return "Line Chart";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Line Chart",
        render: async () => {
          const graphData = new GraphData.Generated();
          await graphData.populate({
            start: 0,
            end: 100,
          });
          return LineChart.make()
            .bind({
              vm: new ChartViewModel(
                new ChartPointerStore(),
                graphData.toCollection({
                  range: ChartViewModel.AxisRange.HALF_UNIT,
                }),
              ),
              xRange: { start: 0, end: 100 },
              yPadding: 20,
            })
            .assignStyles({
              height: "400px",
            });
        },
      },
      {
        title: "Line Chart (Flipped)",
        render: async () => {
          const graphData = new GraphData.Generated();
          await graphData.populate({
            start: 0,
            end: 100,
          });
          return LineChart.make()
            .bind({
              vm: new ChartViewModel(
                new ChartPointerStore(),
                graphData.toCollection({
                  range: ChartViewModel.AxisRange.HALF_UNIT,
                }),
                true /* Flip Axes */,
              ),
              xRange: { start: 0, end: 100 },
              yPadding: 20,
            })
            .assignStyles({
              height: "400px",
            });
        },
      },
    ];
  }
}

export namespace LineChartStoryBook {
  export class Points extends Storybook.Default {
    title(): string {
      return "Line Chart (Points)";
    }

    examples(): Storybook.Example[] {
      return [
        {
          title: "Line Chart (Points)",
          render: async () => {
            const graphData = new GraphData.Generated();
            await graphData.populate({
              start: 0,
              end: 100,
            });
            return LineChart.make()
              .bind({
                vm: new ChartViewModel(
                  new ChartPointerStore(),
                  graphData.toCollection({
                    range: ChartViewModel.AxisRange.HALF_UNIT,
                  }),
                ),
                xRange: { start: 0, end: 100 },
                renderer: [new LineChartBody.Renderer.Points()],
                yPadding: 20,
              })
              .assignStyles({
                height: "400px",
              });
          },
        },
      ];
    }
  }
}
