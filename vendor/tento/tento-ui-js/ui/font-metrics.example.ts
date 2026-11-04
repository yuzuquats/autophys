import { Tracing } from "@tento-core/tracing";
import { FontMetricsContext } from "./font-metrics";

const SAMPLE_TEXT = "Sphinx";

export namespace FontMetricsExample {
  export function render(
    context: CanvasRenderingContext2D,
    fontFamily: string,
    fontWeight: string,
    metrics: FontMetricsContext.FullMetrics,
    size: Size,
  ) {
    const bottom = metrics.bottom;
    const fontSize = computeFontSize(
      context,
      fontFamily,
      fontWeight,
      metrics,
      size,
    );
    const lineHeight = bottom * fontSize;
    context.strokeStyle = "#fff";
    context.fillStyle = "#fff";
    context.textBaseline = "top";
    context.textAlign = "left";
    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

    const textMetrics = context.measureText(SAMPLE_TEXT);
    const textWidth = textMetrics.width;
    const centerX = size.width * 0.5;
    const centerY = size.height * 0.5;
    const offsetX = textWidth * -0.5;
    const offsetY = lineHeight * -0.5;
    context.globalAlpha = 1;
    context.translate(centerX + offsetX, centerY + offsetY);
    context.fillStyle = "#81d4fa";
    context.fillText(SAMPLE_TEXT, 0, 0);
    renderLabels(context, metrics, fontSize, lineHeight);
  }

  function renderLabels(
    context: CanvasRenderingContext2D,
    metrics: FontMetricsContext.FullMetrics,
    fontSizePx: number,
    lineHeightPx: number,
  ) {
    const {
      ascent,
      capHeight,
      tittle,
      xHeight,
      baseline,
      descent,
      top,
      bottom,
    } = metrics;
    const data = computeCharData(context);

    context.textAlign = "center";
    context.font = "10px Roboto Mono";
    context.fillStyle = "black";

    const render = (
      text: string,
      metric: number,
      textData: { x: number; width: number },
      above: boolean,
    ) =>
      renderLabel(
        context,
        text,
        metric,
        textData,
        fontSizePx,
        lineHeightPx,
        above,
      );

    Tracing.dev(capHeight, baseline);
    render("capHeight", capHeight, data.get("S")!, true);
    render("descent", descent, data.get("p")!, false);
    render("ascent", ascent, data.get("h")!, true);
    render("tittle", tittle, data.get("i")!, true);
    render("baseline", baseline, data.get("n")!, false);
    render("xHeight", xHeight, data.get("x")!, true);
    render("top", top, data.get("n")!, true);
    render("bottom", bottom, data.get("S")!, false);
  }

  function renderLabel(
    context: CanvasRenderingContext2D,
    text: string,
    metric: number,
    textData: { x: number; width: number },
    fontSize: number,
    lineHeight: number,
    above: boolean,
  ) {
    const { x, width } = textData;
    const y = metric * fontSize;
    const cx = x + width / 2;
    const ox = width * 0.4;
    const oy = above ? Math.min(y, -20) : lineHeight + 20;
    context.setLineDash([2, 2]);
    context.textBaseline = above ? "bottom" : "top";
    context.beginPath();
    context.moveTo(cx - ox, y);
    context.lineTo(cx + ox, y);
    context.moveTo(cx, y);
    context.lineTo(cx, oy);
    context.globalAlpha = 0.55;
    context.stroke();
    context.globalAlpha = 0.75;
    context.fillText(formatLabel(text), x + width / 2, oy);
  }

  function formatLabel(text: string) {
    return text.replace(/([A-Z])/g, " $1").toUpperCase();
  }

  function computeCharData(
    context: CanvasRenderingContext2D,
  ): Map<string, { x: number; width: number }> {
    const data: Map<string, { x: number; width: number }> = new Map();
    let x = 0;
    SAMPLE_TEXT.split("").forEach(function (char) {
      const width = context.measureText(char).width;
      data.set(char, { x, width });
      x += width;
    });
    Tracing.dev(data);
    return data;
  }

  function computeFontSize(
    context: CanvasRenderingContext2D,
    fontFamily: string,
    fontWeight: string,
    metrics: FontMetricsContext.FullMetrics,
    size: Size,
  ): number {
    const targetWidth = size.width * 0.75;
    const targetHeight = size.height * 0.5;
    const testSize = 100;
    context.font = fontWeight + " " + testSize + "px " + fontFamily;
    const textWidth = context.measureText(SAMPLE_TEXT).width;
    const textHeight = testSize * metrics.bottom;
    return (
      testSize * Math.min(targetWidth / textWidth, targetHeight / textHeight)
    );
  }
}
