/** FLIP arithmetic, kept free of the DOM so it can be tested. */
export type Box = { left: number; top: number; width: number; height: number };
export type Mode = "move" | "box";

/** The transform that puts an element laid out at `last` back where it was
 * drawn at `first`. "move" translates only, so text never scales; "box" also
 * scales, for backgrounds whose size changes. Null when nothing moved. */
export function invert(first: Box, last: Box, mode: Mode): string | null {
  if (!first.width || !first.height || !last.width || !last.height) return null;
  const x = first.left - last.left, y = first.top - last.top;
  const sx = mode === "box" ? first.width / last.width : 1;
  const sy = mode === "box" ? first.height / last.height : 1;
  if (Math.abs(x) + Math.abs(y) + Math.abs(sx - 1) + Math.abs(sy - 1) < 0.01) return null;
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
}
