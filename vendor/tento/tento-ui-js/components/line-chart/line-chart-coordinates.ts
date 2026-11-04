/**
 * Static functions for all coordinate transformations in the line chart system.
 * This isolates all the math so we can test it independently of the UI.
 */

export namespace LineChartCoordinates {
  /** Chart configuration */
  export interface ChartConfig {
    canvasHeight: number;  // Height of canvas element
    domHeight: number;     // Height of DOM container
    yScale: number;        // Pixels per data unit (e.g., 600)
    horizontalRuleOffset: number; // Pixels from center to rules (e.g., 40)
  }

  /** Data range information */
  export interface DataRange {
    min: number;
    max: number;
    center: number;
  }

  /**
   * Convert a data value to canvas Y coordinate using the chart's rendering formula.
   * Formula: canvasY = yOffset + dataValue * yScale
   * 
   * Note: Canvas coordinates have origin at top-left, Y increases downward.
   */
  export function dataToCanvasY(dataValue: number, config: ChartConfig): number {
    const yOffset = config.canvasHeight / 2;
    return yOffset + dataValue * config.yScale;
  }

  /**
   * Convert canvas Y coordinate back to data value.
   * Inverse of dataToCanvasY.
   */
  export function canvasYToData(canvasY: number, config: ChartConfig): number {
    const yOffset = config.canvasHeight / 2;
    return (canvasY - yOffset) / config.yScale;
  }

  /**
   * Get the DOM Y positions where horizontal rules should be drawn.
   * These are visual positions in the DOM container.
   */
  export function getHorizontalRuleDomPositions(config: ChartConfig): {
    topRuleY: number;
    centerY: number;
    bottomRuleY: number;
  } {
    const centerY = config.domHeight / 2;
    return {
      topRuleY: centerY + config.horizontalRuleOffset,
      centerY: centerY,
      bottomRuleY: centerY - config.horizontalRuleOffset,
    };
  }

  /**
   * Calculate which data values appear at the horizontal rule positions.
   * This is the key function that determines what values the rules represent.
   */
  export function getHorizontalRuleDataValues(
    dataRange: DataRange,
    config: ChartConfig,
  ): {
    topRuleValue: number;
    centerValue: number;
    bottomRuleValue: number;
  } {
    // In the current implementation, rules are offset from the data center
    const centerValue = dataRange.center;
    const offsetInDataUnits = config.horizontalRuleOffset / config.yScale;
    
    return {
      topRuleValue: centerValue + offsetInDataUnits,
      centerValue: centerValue,
      bottomRuleValue: centerValue - offsetInDataUnits,
    };
  }

  /**
   * Convert a data value to legend Y position.
   * The legend should show the same visual relationships as the chart.
   */
  export function dataToLegendY(
    dataValue: number,
    dataRange: DataRange,
    legendHeight: number,
    config: ChartConfig,
  ): number {
    // Calculate offset from data center
    const offsetFromCenter = dataValue - dataRange.center;
    
    // Convert to pixels using the same scale as the chart
    const pixelOffset = offsetFromCenter * config.yScale;
    
    // Scale to legend height
    const scaleFactor = legendHeight / config.domHeight;
    const legendPixelOffset = pixelOffset * scaleFactor;
    
    // Apply to legend center (invert Y: positive data goes up = smaller Y)
    const legendCenter = legendHeight / 2;
    return legendCenter - legendPixelOffset;
  }

  /**
   * Debug function to trace all coordinate transformations for a data value.
   */
  export function debugDataValue(
    dataValue: number,
    dataRange: DataRange,
    config: ChartConfig,
    legendHeight: number,
  ): {
    dataValue: number;
    canvasY: number;
    offsetFromCenter: number;
    pixelOffset: number;
    legendY: number;
    description: string;
  } {
    const canvasY = dataToCanvasY(dataValue, config);
    const offsetFromCenter = dataValue - dataRange.center;
    const pixelOffset = offsetFromCenter * config.yScale;
    const legendY = dataToLegendY(dataValue, dataRange, legendHeight, config);
    
    let description = "";
    if (Math.abs(offsetFromCenter) < 0.001) {
      description = "center";
    } else if (Math.abs(offsetFromCenter - config.horizontalRuleOffset / config.yScale) < 0.001) {
      description = "top rule";
    } else if (Math.abs(offsetFromCenter + config.horizontalRuleOffset / config.yScale) < 0.001) {
      description = "bottom rule";
    }
    
    return {
      dataValue,
      canvasY,
      offsetFromCenter,
      pixelOffset,
      legendY,
      description,
    };
  }

  /**
   * Verify that canvas and DOM coordinate systems are aligned.
   * Returns true if they match, false with details if not.
   */
  export function verifyCoordinateAlignment(config: ChartConfig): {
    aligned: boolean;
    canvasCenter: number;
    domCenter: number;
    message: string;
  } {
    const canvasCenter = config.canvasHeight / 2;
    const domCenter = config.domHeight / 2;
    const aligned = Math.abs(canvasCenter - domCenter) < 0.001;
    
    return {
      aligned,
      canvasCenter,
      domCenter,
      message: aligned 
        ? "Canvas and DOM centers are aligned"
        : `Canvas center (${canvasCenter}) != DOM center (${domCenter})`,
    };
  }
}