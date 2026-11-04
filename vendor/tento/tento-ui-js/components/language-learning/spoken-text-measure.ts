// Use the same vendored Pretext runtime as the shared plugin, bundled locally
// so an embedded transcript does not require a separate static asset server.
import { prepareWithSegments, layoutWithLines } from "../../../tento-plugins-js/pretext/src/lib/layout";

const widths = new Map<string, number>();

/** Measure only base characters: ruby pronunciation must not lengthen the underline. */
export function spokenTextWidth(text: string, font: string): number {
  const key = `${font}\0${text}`;
  const cached = widths.get(key);
  if (cached != null) return cached;
  const prepared = prepareWithSegments(text, font);
  const width = Math.max(0, ...layoutWithLines(prepared, 100000, 1).lines.map((line) => line.width));
  if (widths.size >= 2048) widths.clear();
  widths.set(key, width);
  return width;
}
