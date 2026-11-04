import "@tento-ui/components/line-chart/line-chart-body";

import { DateTime, Utc } from "@tento-chrono";
import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { LineChartBody } from "@tento-ui/components/line-chart/line-chart-body";
import { css, Style } from "@tento-ui/component-styles";
import { SpanColumn } from "./span-column";
import { $$ } from "@tento-ui/fastdom";

@component({
  name: "std-span-chart",
})
export class SpanChart extends LonaWebComponent {
  $chart: LineChartBody = this.hydrate("chart");

  /** Retained bind, so a flex-driven width change (count/sidebar/viewport) can
   *  re-measure and re-size the canvas instead of leaving it at a stale (or
   *  zero) width. Must SURVIVE disconnect: the sheet re-parents span cells
   *  during re-layout without re-calling bindGraph (staticContent binds once),
   *  and the reattach-time ResizeObserver notification is what re-sizes the
   *  canvas. Cleared only on onRecycle (pooling). */
  #lastBind: Option<{ props: LineChartBody.Props; heightPx: number }> = null;
  #lastWidthPx: Option<number> = null;

  onSizeChange = (): void => {
    if (!this.#lastBind) return;
    $$.measure(() => {
      const bind = this.#lastBind;
      if (!bind) return;
      const widthPx = this.offsetWidth;
      if (widthPx === 0 || widthPx === this.#lastWidthPx) return;
      $$.mutate(() => this.#applyBind(bind.props, bind.heightPx, widthPx));
    });
  };

  bindDebug(time: DateTime.Range<Utc>) {
    this.$("dbg").textContent = time.start.toString();
  }

  bindGraph(props: LineChartBody.Props, heightPx: number): this {
    this.#lastBind = { props, heightPx };
    $$.measure(() => {
      const widthPx = this.offsetWidth;
      $$.mutate(() => this.#applyBind(props, heightPx, widthPx));
    });
    return this;
  }

  #applyBind(
    props: LineChartBody.Props,
    heightPx: number,
    widthPx: number,
  ): void {
    this.#lastWidthPx = widthPx;
    props.vm.bindSize({ width: widthPx, height: heightPx }, false);
    this.$chart.bind(props);
  }

  onRecycle(): void {
    super.onRecycle();
    this.#lastBind = null;
    this.#lastWidthPx = null;
  }

  static $styles: Style.Compat[] = [
    SpanColumn.$inThePast,
    css`
        :host {
          /* $inThePast's calc(100% - 4px) is the event-chip gap; a chart
             subcolumn must reach the calendar's bottom edge, and bindGraph
             sizes the canvas to the full day height — the shorter host
             would clip its last 4px. */
          height: 100%;
        }

        #root {
          height: 100%;
          width: 100%;
        }

        :host([hide-icon]) #icon {
          display: none;
        }

        :host([show-on-hover]) {
          opacity: 0;
        }

        #dbg {
          top: 0px;
          left: 0px;
          position: absolute;
          pointer-events: none;
          --font-size: 0.5rem;
          color: var(--text-ter);
        }
      `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-line-chart-body id=chart></std-line-chart-body>
      <div id=icon></div>
      <p id=dbg></p>
    </std-col>
  `;
}
