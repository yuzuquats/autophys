import type { TexturePalette } from "../palettes";
/** Paint only the contour marks; the host owns clearing, sizing and scheduling. */
export function drawContours(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  colors: Pick<TexturePalette, "art">,
): void {
  ctx.lineWidth = .8;
  for (let line = 0; line < 64; line++) {
    ctx.beginPath();
    ctx.strokeStyle = line % 5 === 0 ? colors.art[0] : colors.art[1];
    for (let s = 0; s <= 90; s++) {
      const x = s / 90 * (width + 180) - 90;
      const u = x / width;
      const y = height * .52 + (line - 32) * height / 54 +
        Math.sin(u * 5 + line * .055 + time * .12) * height * .18 +
        Math.sin(u * 2.7 - time * .09) * height * .12;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
/** Deterministic fallback while the optional p5 runtime loads or cannot be fetched. */
export function drawAsciiFallback(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  colors: { readonly art: readonly [string, string, string] },
): void {
  const step = width < 600 ? 12 : 14;
  const chars = " .:+=x#";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  for (let y = 8; y < height; y += 17) {
    for (let x = 6; x < width; x += step) {
      const u = x / width, v = y / height;
      const field = Math.sin(u * 9 + v * 5 + time * .16) *
        Math.cos(v * 8 - u * 3 - time * .12);
      const light = (field + 1) / 2;
      const char = chars[Math.min(6, Math.floor(light * 7))];
      if (char === " ") continue;
      ctx.fillStyle = light > .72
        ? colors.art[0]
        : light > .4
        ? colors.art[1]
        : colors.art[2];
      ctx.fillText(char, x, y);
    }
  }
}
