/**
 * Canvas renderer for a horizontal strip of calendar day columns.
 *
 * Draws columns with fragment clipping, gridlines, event cells (with
 * text via pretext), and hover highlights. Pure rendering — no DOM
 * dependencies beyond CanvasRenderingContext2D.
 */

import { ColumnLayout } from "@tento-core/column-layout";
import { CanvasHitMap } from "@tento-core/canvas-hit-map";
import type { ColumnStrip } from "@tento-core/column-strip-props";
import type { Pretext } from "../ui/pretext-import";

const FONT_HEIGHT = 0.72; // 1 - cap-height(0.125) - baseline(0.155)
const CELL_BORDER_RADIUS = 8;
const CELL_PADDING_LEFT = 6;
const CELL_PADDING_TOP = 6;
const CELL_TEXT_PADDING = 12;
const MAX_TEXT_LINES = 3;
const HANDLE_HEIGHT = 4;

export namespace ColumnStripRenderer {
  export type DrawOptions = {
    /** Pretext module for text measurement + rendering */
    pretext: Pretext;
    /** Hit map to register cell rects into (for pointer event resolution) */
    hitMap: CanvasHitMap;
    /** Currently hovered cell id (null for none) */
    hoveredId: Option<string>;
    /** Hover highlight color */
    hoverColor: string;
    /** Colors for column dividers */
    dividerColors: { primary: string; secondary: string };
    /** Text color inside cells */
    textColor: string;
    /** Border color for overlapping cells */
    cellBorderColor: string;
    /** Handle overlay color (semi-transparent) */
    handleColor: string;
  };

  /** Draw the full column strip onto a canvas context. */
  export function draw(
    ctx: CanvasRenderingContext2D,
    props: ColumnStrip.Props,
    options: DrawOptions,
  ): void {
    const { columns, pxPerHour } = props;
    const canvasHeight = ctx.canvas.height / window.devicePixelRatio;

    for (const col of columns) {
      drawDivider(ctx, col, canvasHeight, options);
      const sortedFrags = [...col.fragments].sort((a, b) => a.zIndex - b.zIndex);
      for (const frag of sortedFrags) {
        drawFragment(ctx, col, frag, pxPerHour, options);
      }
    }
  }

  /** Draw a column's left divider line. */
  function drawDivider(
    ctx: CanvasRenderingContext2D,
    col: ColumnStrip.Column,
    canvasHeight: number,
    options: DrawOptions,
  ): void {
    if (col.divider === "none") return;
    ctx.fillStyle = col.divider === "primary"
      ? options.dividerColors.primary
      : options.dividerColors.secondary;
    ctx.fillRect(col.x - 0.5, 0, 1, canvasHeight);
  }

  /** Draw a single fragment: background, gridlines, cells, all clipped to the rounded rect. */
  function drawFragment(
    ctx: CanvasRenderingContext2D,
    col: ColumnStrip.Column,
    frag: ColumnStrip.Fragment,
    pxPerHour: number,
    options: DrawOptions,
  ): void {
    const fx = col.x;
    const fy = frag.y;
    const fw = col.width;
    const fh = frag.height;
    const br = frag.borderRadius;

    // Tzabbr badges behind the fragment (z-index: -1 in DOM)
    // Drawn first so the fragment covers the connector side
    if (frag.tzabbr) {
      if (br.tl > 0) drawTzabbr(ctx, fx, fy, fw, frag.tzabbr, "top", options);
      if (br.bl > 0) drawTzabbr(ctx, fx, fy + fh, fw, frag.tzabbr, "bottom", options);
    }

    // Partial-edge shadows on the underlay (behind the fragment)
    drawPartialShadows(ctx, fx, fy, fw, fh, br);

    // Clip to fragment bounds
    ctx.save();
    roundRectPerCorner(ctx, fx, fy, fw, fh, br.tl, br.tr, br.br, br.bl);
    ctx.clip();

    // Background
    ctx.fillStyle = frag.background;
    ctx.fillRect(fx, fy, fw, fh);

    // Gridlines
    drawGridlines(ctx, fx, fy, fw, fh, frag.gridlines);

    // Cells sorted by z-index
    const sorted = [...frag.cells].sort((a, b) => a.zIndex - b.zIndex);
    for (const cell of sorted) {
      drawCell(ctx, col, frag, cell, pxPerHour, options);
    }

    ctx.restore();
  }

  /** Draw gridlines inside a fragment. */
  function drawGridlines(
    ctx: CanvasRenderingContext2D,
    fx: number,
    fy: number,
    fw: number,
    fh: number,
    gridlines: ColumnStrip.Fragment["gridlines"],
  ): void {
    ctx.strokeStyle = gridlines.color;
    ctx.lineWidth = 0.5;
    for (let gy = gridlines.offsetPx; gy < fh; gy += gridlines.spacingPx) {
      ctx.beginPath();
      ctx.moveTo(fx, fy + gy);
      ctx.lineTo(fx + fw, fy + gy);
      ctx.stroke();
    }
  }

  /** Draw a single event cell with background, border, text, and hover state. */
  function drawCell(
    ctx: CanvasRenderingContext2D,
    col: ColumnStrip.Column,
    frag: ColumnStrip.Fragment,
    cell: ColumnStrip.Cell,
    pxPerHour: number,
    options: DrawOptions,
  ): void {
    const cr = ColumnLayout.cellRect(
      cell.layout,
      cell.startTimeHrs,
      cell.durationMins,
      col.width,
      pxPerHour,
    );
    const cellX = col.x + cr.x;
    const cellY = frag.y + pxPerHour * (cell.startTimeHrs - frag.windowedStartHrs);
    const cellW = cr.width;
    const cellH = cr.height;
    const isHovered = cell.id === options.hoveredId;

    // Background
    ctx.fillStyle = isHovered ? options.hoverColor : cell.color;
    roundRect(ctx, cellX, cellY, cellW, cellH, CELL_BORDER_RADIUS);
    ctx.fill();

    // Border for overlapping cells
    if (cell.border) {
      ctx.strokeStyle = options.cellBorderColor;
      ctx.lineWidth = 1;
      roundRect(ctx, cellX, cellY, cellW, cellH, CELL_BORDER_RADIUS);
      ctx.stroke();
    }

    // Text (clipped to cell)
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, cellX, cellY, cellW, cellH, CELL_BORDER_RADIUS);
    ctx.clip();
    drawCellText(ctx, cell, cellX, cellY, cellW, cellH, options);
    ctx.restore();

    // Hover resize handles
    if (isHovered) {
      drawHandles(ctx, cellX, cellY, cellW, cellH, options);
    }

    // Register for hit testing
    options.hitMap.add({
      id: cell.id,
      rect: { x: cellX, y: cellY, width: cellW, height: cellH },
      zIndex: cell.zIndex,
    });
  }

  /** Draw text lines inside a cell using pretext for measurement. */
  function drawCellText(
    ctx: CanvasRenderingContext2D,
    cell: ColumnStrip.Cell,
    cellX: number,
    cellY: number,
    cellW: number,
    cellH: number,
    options: DrawOptions,
  ): void {
    const capheightPx = cell.durationMins <= 15 ? 6 : 8;
    const rFontSize = capheightPx / FONT_HEIGHT;
    const font = `${rFontSize}px Helvetica Neue, Helvetica, sans-serif`;
    const textMaxWidth = cellW - CELL_TEXT_PADDING;

    const prepared = options.pretext.prepareWithSegments(cell.title, font);
    const layout = options.pretext.layoutWithLines(prepared, textMaxWidth, rFontSize);
    const maxLines = Math.min(
      layout.lines.length,
      MAX_TEXT_LINES,
      Math.floor((cellH - CELL_TEXT_PADDING) / capheightPx),
    );

    ctx.font = font;
    ctx.fillStyle = options.textColor;
    ctx.textBaseline = "top";
    for (let i = 0; i < maxLines; i++) {
      let text = layout.lines[i].text;
      if (i === maxLines - 1 && layout.lines.length > maxLines) {
        text = text.trimEnd() + "\u2026";
      }
      ctx.fillText(
        text,
        cellX + CELL_PADDING_LEFT,
        cellY + CELL_PADDING_TOP + i * rFontSize,
        textMaxWidth,
      );
    }
  }

  /** Draw semi-transparent resize handle zones at top and bottom of cell. */
  function drawHandles(
    ctx: CanvasRenderingContext2D,
    cellX: number,
    cellY: number,
    cellW: number,
    cellH: number,
    options: DrawOptions,
  ): void {
    ctx.fillStyle = options.handleColor;
    // Top handle
    roundRectPerCorner(
      ctx, cellX, cellY, cellW, HANDLE_HEIGHT,
      CELL_BORDER_RADIUS, CELL_BORDER_RADIUS, 0, 0,
    );
    ctx.fill();
    // Bottom handle
    roundRectPerCorner(
      ctx, cellX, cellY + cellH - HANDLE_HEIGHT, cellW, HANDLE_HEIGHT,
      0, 0, CELL_BORDER_RADIUS, CELL_BORDER_RADIUS,
    );
    ctx.fill();
  }

  /**
   * Draw soft inset shadows at partial-day edges.
   * Matches CSS: box-shadow: 0px 0px 12px 9px var(--black20)
   * Rendered as a gradient fade from rgba(0,0,0,0.12) to transparent.
   */
  function drawPartialShadows(
    ctx: CanvasRenderingContext2D,
    fx: number,
    fy: number,
    fw: number,
    fh: number,
    borderRadius: ColumnStrip.Fragment["borderRadius"],
  ): void {
    const partialTop = borderRadius.tl > 0;
    const partialBottom = borderRadius.bl > 0;
    if (!partialTop && !partialBottom) return;

    const shadowHeight = 20;

    if (partialTop) {
      const grad = ctx.createLinearGradient(0, fy - shadowHeight, 0, fy + shadowHeight);
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
      grad.addColorStop(0.5, "rgba(0, 0, 0, 0.12)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(fx, fy - shadowHeight, fw, shadowHeight * 2);
    }

    if (partialBottom) {
      const grad = ctx.createLinearGradient(0, fy + fh - shadowHeight, 0, fy + fh + shadowHeight);
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
      grad.addColorStop(0.5, "rgba(0, 0, 0, 0.12)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(fx, fy + fh - shadowHeight, fw, shadowHeight * 2);
    }
  }

  /**
   * Draw a timezone abbreviation badge at the top or bottom of a fragment.
   *
   * Matches the DOM's #tzabbr-top / #tzabbr-bottom:
   * - Black pill, 4px border-radius, centered horizontally
   * - Top: positioned -14px above fragment, flat bottom corners (connects to fragment)
   * - Bottom: positioned -14px below fragment, flat top corners
   * - White text, ~8px actual font size (0.375rem capheight = 6px / 0.72)
   */
  /**
   * Draw a timezone abbreviation badge behind a fragment edge.
   *
   * The pill extends from outside the fragment and its connector side
   * tucks under the fragment's rounded corner (drawn before fragment).
   *
   * DOM reference: #tzabbr-top at top: -14px, padding-bottom: 8px,
   * #tzabbr-bottom at bottom: -14px, padding-top: 8px. Both z-index: -1.
   */
  function drawTzabbr(
    ctx: CanvasRenderingContext2D,
    fx: number,
    edgeY: number,
    fw: number,
    text: string,
    position: "top" | "bottom",
    options: DrawOptions,
  ): void {
    const fontSize = 6 / FONT_HEIGHT;
    const font = `${fontSize}px Helvetica Neue, Helvetica, sans-serif`;
    const paddingX = 8;
    const paddingY = 4;
    const connectorOverlap = 8; // how far the pill extends behind the fragment
    const radius = 4;

    ctx.font = font;
    const textWidth = ctx.measureText(text).width;
    const pillWidth = textWidth + paddingX * 2;
    const textHeight = paddingY * 2 + fontSize;
    const pillHeight = textHeight + connectorOverlap;
    const pillX = fx + (fw - pillWidth) / 2;

    ctx.fillStyle = "black";
    let hitRect: CanvasHitMap.Rect;
    if (position === "top") {
      const pillY = edgeY - textHeight;
      roundRectPerCorner(ctx, pillX, pillY, pillWidth, pillHeight,
        radius, radius, 0, 0);
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.textBaseline = "top";
      ctx.fillText(text, pillX + paddingX, pillY + paddingY);
      hitRect = { x: pillX, y: pillY, width: pillWidth, height: textHeight };
    } else {
      const pillY = edgeY - connectorOverlap;
      roundRectPerCorner(ctx, pillX, pillY, pillWidth, pillHeight,
        0, 0, radius, radius);
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.textBaseline = "top";
      ctx.fillText(text, pillX + paddingX, pillY + connectorOverlap + paddingY);
      hitRect = { x: pillX, y: edgeY, width: pillWidth, height: textHeight };
    }

    options.hitMap.add({
      id: `tzabbr:${text}:${position}`,
      rect: hitRect,
      zIndex: 1000,
      tag: "tzabbr",
    });
  }
}

/** Uniform border-radius rounded rect path. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  roundRectPerCorner(ctx, x, y, w, h, r, r, r, r);
}

/** Per-corner border-radius rounded rect path (clockwise). */
function roundRectPerCorner(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  tl: number, tr: number, br: number, bl: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}
