import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { ChartPointerStore } from "./chart-pointer-store";

@component({
  name: "std-chart-crosshair-overlay",
})
export class ChartCrosshairOverlay extends LonaWebComponent {
  private hideTimeout: Option<number> = undefined;
  private boundStore: Option<ChartPointerStore> = null;

  private $horizontal: HTMLElement = this.$("horizontal");
  private $vertical: HTMLElement = this.$("vertical");
  private $label: HTMLElement = this.$("label");
  private $xTick: HTMLElement = this.$("x-tick");
  private $xTickValue: HTMLElement = this.$("x-tick-value");

  bind(pointerStore: ChartPointerStore): void {
    // Idempotent: re-binding the same store is a no-op so a recycled/re-bound
    // host doesn't stack duplicate subscriptions. Switching stores unsubscribes
    // the previous one first.
    if (this.boundStore === pointerStore) return;
    this.boundStore?.unsubscribe(this);
    this.boundStore = pointerStore;
    pointerStore.subscribe(this, (state) => {
      if (state) {
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
        this.showCrosshairs(state);
      } else {
        if (this.hideTimeout) return;
        this.hideTimeout = setTimeout(() => {
          this.hideCrosshairs();
          this.hideTimeout = null;
        }, 500);
      }
    });
  }

  /** Drop the pointer-store subscription, cancel any pending hide, and hide. */
  unbind(): void {
    this.boundStore?.unsubscribe(this);
    this.boundStore = null;
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.hideCrosshairs();
  }

  private showCrosshairs(state: ChartPointerStore.PointerState): void {
    this.style.display = "block";

    const containerRect = this.getBoundingClientRect();
    const relativeX = state.global.x - containerRect.left;
    const relativeY = state.global.y - containerRect.top;

    this.$horizontal.assignStyles({
      top: relativeY - 0.5 + "px",
      display: "block",
    });

    this.$vertical.assignStyles({
      left: relativeX - 0.5 + "px",
      display: "block",
    });

    this.$xTick.assignStyles({
      left: relativeX + "px",
      transform: "translateX(-50%)",
      display: "flex",
    });

    this.$xTickValue.textContent = state.xDisplay
      ? state.xDisplay(state.data.x)
      : state.data.x.toFixed(1);

    if (state.hovered) {
      const xDisplayStr = state.xDisplay
        ? state.xDisplay(state.hovered.point.x)
        : state.hovered.point.x.toFixed(1);
      this.$label.assignStyles({
        left: relativeX + 10 + "px",
        top: relativeY - 35 + "px",
        display: "block",
      });
      this.$label.textContent = `Point: x=${xDisplayStr}, y=${state.hovered.point.y.toFixed(3)}`;
    } else {
      this.$label.style.display = "none";
    }
  }

  private hideCrosshairs(): void {
    this.style.display = "none";
    this.$horizontal.style.display = "none";
    this.$vertical.style.display = "none";
    this.$label.style.display = "none";
    this.$xTick.style.display = "none";
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 1000; /* ZIndex.FLOATING_PANEL */
      }

      #horizontal {
        position: absolute;
        left: 0;
        right: 0;
        height: 1px;
        background-image: linear-gradient(to right, var(--divider-pri) 50%, transparent 50%);
        background-size: 8px 1px;
        pointer-events: none;
        display: none;
      }

      #vertical {
        position: absolute;
        top: 0px;
        bottom: 28px;
        width: 1px;
        background-image: linear-gradient(to bottom, var(--divider-pri) 50%, transparent 50%);
        background-size: 1px 8px;
        pointer-events: none;
        display: none;
      }

      #label {
        position: absolute;
        padding: 4px 8px;
        border-radius: 3px;
        pointer-events: none;
        display: none;
        z-index: 1001; /* ZIndex.FLOATING_PANEL + 1 */
        background: var(--text-sec);
        color: white;
        font-size: var(--h6-size);
      }

      #x-tick {
        position: absolute;
        bottom: 4px;
        pointer-events: none;
        display: none;
        flex-direction: column;
        align-items: center;
      }

      #x-tick-line {
        width: 1px;
        height: 8px;
        background: var(--divider-pri);
        margin-bottom: 4px;
      }

      #x-tick-value {
        --font-size: var(--text-9px);
        font-family: monospace;
        color: var(--text-sec);
        padding: 2px 4px;
        white-space: nowrap;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="horizontal"></div>
    <div id="vertical"></div>
    <div id="label"></div>
    <div id="x-tick">
      <div id="x-tick-line"></div>
      <p id="x-tick-value"></p>
    </div>
  `;
}
