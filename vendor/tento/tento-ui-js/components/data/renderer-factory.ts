import { LineChartBody } from "@tento-ui/components/line-chart/line-chart-body";

type RendererAttributes = Record<string, unknown>;

/**
 * Converts data-renderer attributes → LineChartBody.Renderer instance.
 *
 * `attrs.type` is the mark KIND (`points`, `line`, `bar`, …), NOT a wire
 * `_type`. Callers derive it from the row's wire type or legacy attrs
 * (`@tento-lona/sheets/platform` `rendererMarkKindOf`) and pass it in here.
 */
export function createRenderer(
  attrs: RendererAttributes,
): Option<LineChartBody.Renderer> {
  const type = attrs["type"] as Option<string>;
  if (!type) return null;

  switch (type) {
    case "points":
      return new LineChartBody.Renderer.Points(
        str(attrs, "key", "default"),
        num(attrs, "radius", 2),
        str(attrs, "color", "#ddd"),
      );

    case "hrule":
      return new LineChartBody.Renderer.HRule(
        num(attrs, "offset", 0),
        offsetType(attrs),
      );

    case "hrule-all":
      return new LineChartBody.Renderer.HRuleAll(
        num(attrs, "offset", 0),
        offsetType(attrs),
        optNum(attrs, "center"),
        str(attrs, "color", "var(--divider)"),
      );

    case "regression-curve":
      return new LineChartBody.Renderer.RegressionCurve(
        str(attrs, "key", "default"),
        str(attrs, "color", "#666"),
      );

    case "regression-band":
      return new LineChartBody.Renderer.RegressionBand(
        str(attrs, "key", "default"),
        str(attrs, "color", "rgba(245, 158, 11, 0.1)"),
      );

    case "regression-fill":
      return new LineChartBody.Renderer.RegressionFill(
        str(attrs, "key", "default"),
        num(attrs, "offset", 0),
        offsetType(attrs),
        optNum(attrs, "center"),
        str(attrs, "topColor", "rgba(239, 68, 68, 0.3)"),
        str(attrs, "bottomColor", "rgba(59, 130, 246, 0.3)"),
      );

    case "regression-points":
      return new LineChartBody.Renderer.RegressionPoints(
        str(attrs, "key", "default"),
        str(attrs, "color", "rgb(255, 0, 0)"),
      );

    case "bar-chart-with-width":
      return new LineChartBody.Renderer.BarChartWithWidth(
        str(attrs, "key", "default"),
        str(attrs, "barColor", "var(--blue)"),
      );

    case "buckets":
      return new LineChartBody.Renderer.Buckets(
        str(attrs, "key", "default"),
        str(attrs, "barColor", "var(--blue)"),
      );

    default:
      return null;
  }
}

function str(attrs: RendererAttributes, key: string, fallback: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : fallback;
}

function num(attrs: RendererAttributes, key: string, fallback: number): number {
  const v = attrs[key];
  return typeof v === "number" ? v : fallback;
}

function optNum(attrs: RendererAttributes, key: string): Option<number> {
  const v = attrs[key];
  return typeof v === "number" ? v : null;
}

function offsetType(attrs: RendererAttributes): "pct" | "abs" {
  const v = attrs["offsetType"];
  return v === "abs" ? "abs" : "pct";
}
