import "./chart-crosshair-overlay";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Storybook } from "../../ui/storybook";
import { ChartCrosshairOverlay } from "./chart-crosshair-overlay";
import { ChartPointerStore } from "./chart-pointer-store";
import { Point } from "@tento-core/point";

@component({
  name: "std-crosshair-demo-container",
})
class CrosshairDemoContainer extends LonaWebComponent {
  private pointerStore = new ChartPointerStore();
  private chartId = "";
  private showPoints = false;
  private points: Point[] = [];

  private $overlay: ChartCrosshairOverlay = this.hydrate("overlay");
  private $instructions: HTMLElement = this.$("instructions");
  private $pointsContainer: HTMLElement = this.$("points-container");

  bind(config: {
    chartId: string;
    instructions: string;
    showPoints?: boolean;
  }): void {
    this.chartId = config.chartId;
    this.showPoints = config.showPoints ?? false;
    this.$instructions.textContent = config.instructions;

    this.$overlay.bind(this.pointerStore);

    if (this.showPoints) {
      this.points = [
        { x: 150, y: 200 },
        { x: 250, y: 150 },
        { x: 350, y: 250 },
        { x: 450, y: 180 },
      ];
      this.renderPoints();
    }

    this.addEventListener("pointermove", this.handlePointerMove);
    this.addEventListener("pointerleave", this.handlePointerLeave);
  }

  private renderPoints(): void {
    for (const point of this.points) {
      const $point = document.createElement("div");
      $point.assignStyles({
        position: "absolute",
        left: point.x + "px",
        top: point.y + "px",
        width: "8px",
        height: "8px",
        background: "var(--blue)",
        borderRadius: "50%",
        transform: "translate(-50%, -50%)",
      });
      this.$pointsContainer.appendChild($point);
    }
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const rect = this.getBoundingClientRect();
    const globalX = e.clientX;
    const globalY = e.clientY;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const dataX = (localX / rect.width) * 100;
    const dataY = ((rect.height - localY) / rect.height) * 100;

    let hoveredPoint: Option<{ point: Point; canvas: Point }> = undefined;

    if (this.showPoints) {
      for (const point of this.points) {
        const dx = localX - point.x;
        const dy = localY - point.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 10) {
          hoveredPoint = {
            point: {
              x: (point.x / rect.width) * 100,
              y: ((rect.height - point.y) / rect.height) * 100,
            },
            canvas: point,
          };
          break;
        }
      }
    }

    this.pointerStore.updatePointer({
      chartId: this.chartId,
      global: { x: globalX, y: globalY },
      data: { x: dataX, y: dataY },
      chartBounds: rect,
      hovered: hoveredPoint,
    });
  };

  private handlePointerLeave = (): void => {
    this.pointerStore.clearPointer(this.chartId);
  };

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: relative;
        display: block;
        width: 100%;
        height: 400px;
        background: var(--bg);
        border: 1px solid var(--divider);
      }

      #instructions {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: var(--text-ter);
        pointer-events: none;
      }

      #points-container {
        position: absolute;
        inset: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p id="instructions"></p>
    <div id="points-container"></div>
    <std-chart-crosshair-overlay id="overlay"></std-chart-crosshair-overlay>
  `;
}

export class ChartCrosshairOverlayStoryBook extends Storybook.Default {
  title(): string {
    return "Chart Crosshair Overlay";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive Crosshair",
        render: () => {
          const $container = CrosshairDemoContainer.make();
          $container.bind({
            chartId: "demo-chart-1",
            instructions:
              "Move your mouse over the container to see the crosshair",
          });
          return $container;
        },
      },
      {
        title: "Crosshair with Hovered Point",
        render: () => {
          const $container = CrosshairDemoContainer.make();
          $container.bind({
            chartId: "demo-chart-2",
            instructions: "Move over the blue points to see hover labels",
            showPoints: true,
          });
          $container.$("instructions").assignStyles({
            top: "20px",
            transform: "translateX(-50%)",
          });
          return $container;
        },
      },
    ];
  }
}
