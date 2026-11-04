import "./line-chart-legend";
import "./line-chart-body";
import "./chart-crosshair-overlay";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { LineChartBody } from "./line-chart-body";
import { LineChartLegend } from "./line-chart-legend";
import { ChartViewModel } from "./chart-view-model";
import { NumRangeLike } from "@tento-core/range";
import { ChartCrosshairOverlay } from "./chart-crosshair-overlay";
import { LiveData } from "@tento-core/livedata";

@component({
  name: "std-line-chart",
})
export class LineChart extends LonaWebComponent {
  $legend: LineChartLegend = this.hydrate("legend");
  $body: LineChartBody = this.hydrate("body");
  $crosshair: ChartCrosshairOverlay = this.hydrate("crosshair");

  props: Option<LineChart.Props>;
  bodySize: Option<Size>;

  ro = new ResizeObserver(([entry]) => {
    const size = {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    };
    this.$body.rebindSize(size);

    if (!this.props) return;
    this.props.vm.bindSize(size, true);
    this.$legend.bind({
      vm: this.props.vm,
      yScaler: this.props.vm.graphData.defaultData.yScaler,
      yPadding: this.props.yPadding,
    });
  });

  connectedCallback() {
    super.connectedCallback();
    this.ro.observe(this.$("body"));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro.unobserve(this.$("body"));
    this.props?.vm.invalidates.removeListener(this);
  }

  bind(props: LineChart.Props): this {
    // Clean up listener from previous vm before rebinding
    this.props?.vm.invalidates.removeListener(this);

    this.props = props;

    this.$crosshair.bind(props.vm.pointer);
    this.props.vm.invalidates.addListener(
      this,
      () => {
        // this.$legend.bindTicks(this.props!.vm.generateTicks());
        this.$body.bind({
          vm: props.vm,
          xRange: props.xRange,
          renderer: props.renderer ?? LineChartBody.Renderer.DEFAULT,
          yPadding: this.props!.yPadding,
        });
      },
      LiveData.TriggerImmediately,
    );
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        height: 100%;
        width: 100%;
        height: 300px;
      }

      #root {
        height: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id=root>
      <std-line-chart-legend id=legend></std-line-chart-legend>
      <std-line-chart-body id=body>
        <std-chart-crosshair-overlay id=crosshair></std-chart-crosshair-overlay>
      </std-line-chart-body>
    </std-row>
  `;
}

export namespace LineChart {
  export type Props = {
    vm: ChartViewModel;
    xRange: NumRangeLike;
    yPadding: number;
    renderer?: Option<LineChartBody.Renderer[]>;
  };

  export type Legend = LineChartLegend;
  export const Legend = LineChartLegend;

  export type Body = LineChartBody;
  export const Body = LineChartBody;
}
