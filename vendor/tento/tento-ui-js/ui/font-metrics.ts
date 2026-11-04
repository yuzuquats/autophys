import { nonnull } from "@tento-core/assert";

export interface FontMetricsContext {
  align: (baseline: CanvasTextBaseline) => void;
  text: (t: string) => void;
  pixelsFromTop: () => number;
  pixelsFromBottom: () => number;
  height: () => number;
  fontSizePx: () => number;
}

export class FontMetrics {
  private $canvas: HTMLCanvasElement = document.createElement("canvas");
  private context = nonnull(
    this.$canvas.getContext("2d", {
      willReadFrequently: true,
    }),
  );
  private paddingPx: number = 0;
  private fontSizePx: number = 0;

  measure<T = void>(
    config: {
      fontFamily: string;
      fontSizePx: number;
      fontWeight: string;
    },
    fn: (context: FontMetricsContext) => T,
  ) {
    this.paddingPx = config.fontSizePx * 0.5;
    this.$canvas.width = config.fontSizePx * 2;
    this.$canvas.height = config.fontSizePx * 2 + this.paddingPx;
    this.fontSizePx = config.fontSizePx;

    this.context.font =
      `${config.fontWeight} ${config.fontSizePx}px ${config.fontFamily}`;
    this.context.textBaseline = "top";
    this.context.textAlign = "center";

    return fn(this.fontContext);
  }

  private getPixels(): Uint8ClampedArray {
    return this.context.getImageData(
      0,
      0,
      this.$canvas.width,
      this.$canvas.height,
    ).data;
  }

  private pixelsFromTop(pixels: Uint8ClampedArray) {
    for (let i = 3, n = pixels.length; i < n; i += 4) {
      if (pixels[i] > 0) return (i - 3) / 4;
    }
    return pixels.length;
  }

  private pixelsFromBottom(pixels: Uint8ClampedArray) {
    for (let i = pixels.length - 1; i >= 3; i -= 4) {
      if (pixels[i] > 0) return i / 4;
    }
    return 0;
  }

  private fontContext: FontMetricsContext = ((self) => ({
    align: (baseline: CanvasTextBaseline) => {
      const ty = baseline === "bottom" ? self.$canvas.height : 0;
      self.context.setTransform(1, 0, 0, 1, 0, ty);
      self.context.textBaseline = baseline;
    },
    text: (t: string) => {
      self.context.clearRect(0, 0, self.$canvas.width, self.$canvas.height);
      self.context.fillText(
        t,
        self.$canvas.width / 2,
        this.paddingPx,
        self.$canvas.width,
      );
    },
    pixelsFromTop: () =>
      Math.round(self.pixelsFromTop(self.getPixels()) / self.$canvas.width) -
      self.paddingPx,
    pixelsFromBottom: () =>
      Math.round(self.pixelsFromBottom(self.getPixels()) / self.$canvas.width) -
      self.paddingPx,
    height: () => self.$canvas.height,
    fontSizePx: () => self.fontSizePx,
  }))(this);
}

export namespace FontMetricsContext {
  export type FullMetrics = {
    capHeight: number;
    baseline: number;
    xHeight: number;
    descent: number;
    bottom: number;
    ascent: number;
    tittle: number;
    top: number;
  };

  export function measureLineHeight(context: FontMetricsContext) {
    context.align("bottom");
    context.text("A");
    const gutter = context.height() - context.pixelsFromBottom();
    context.align("top");
    context.text("A");
    return context.pixelsFromBottom() + gutter;
  }

  export function normalize(
    metric: number,
    fontSizePx: number,
    baselineMetric: number,
  ) {
    return (metric - baselineMetric) / fontSizePx;
  }

  export function normalizeAll(
    context: FontMetricsContext,
    metrics: FullMetrics,
    baselineMetric: number,
  ): FullMetrics {
    const result = {};
    for (const key in metrics) {
      result[key] = normalize(
        metrics[key],
        context.fontSizePx(),
        baselineMetric,
      );
    }
    return result as FullMetrics;
  }

  export function getMetrics(context: FontMetricsContext): FullMetrics {
    context.text("S");
    const capHeight = context.pixelsFromTop();

    context.text("x");
    const xHeight = context.pixelsFromTop();

    context.text("p");
    const descent = context.pixelsFromBottom();

    context.align("top");
    context.text("h");
    const ascent = context.pixelsFromTop();

    context.align("top");
    context.text("i");
    const tittle = context.pixelsFromTop();

    context.text("n");
    const baseline = context.pixelsFromBottom();

    const bottom = measureLineHeight(context);

    return {
      capHeight,
      baseline,
      xHeight,
      descent,
      bottom,
      ascent,
      tittle,
      top: 0,
    };
  }
}
