import { Plot } from "./plot";

/** The hanging baseline helper must only be run in the bounded process probe. */
export async function verifyPlotRanges(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  for (const [start, end] of [[0, 1], [-1, 1], [100000, 100001]]) {
    const ticks: { y: number; value: number }[] = [];
    Plot.visitGridOffsets({ start, end }, 200, (y, value) => ticks.push({ y, value }));
    if (ticks.length < 1 || ticks.length > 5 || ticks.some(t => !Number.isFinite(t.y) || t.y < 0 || t.y > 200 || t.value < start || t.value > end)) throw new Error("Plot visible tick bound");
    if (start <= 0 && end >= 0 && ticks.filter(t => t.value === 0).length !== 1) throw new Error("Plot ordinary zero axis must occur exactly once");
    const p = Plot.make(); p.style.display = "block"; p.style.width = "300px"; p.style.height = "200px";
    p.bind({ f: { r: { start: 0, end: 1 }, data: () => ({ x: 0, y: start + (end - start) / 2 }) },
      yRange: { start, end }, tooltipsProvider: () => ({ title: "Test", date: "", value: "", change: "" }) });
    document.body.append(p); await frame(); await frame();
    const canvas = p.shadowRoot!.querySelector("canvas")!;
    if (canvas.width < 300 || canvas.height < 200 || !canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data.some(v => v !== 0)) throw new Error("Plot actual canvas did not render");
    Plot.recycle(p); await frame();
  }
  for (const [start, end] of [[1, 1], [-1, -1], [1, 0], [0, Infinity], [NaN, 1], [1e16, 1e16 + 2]]) {
    let rejected = false;
    try { Plot.visitGridOffsets({ start, end }, 200, () => {}); } catch (error) { rejected = error instanceof RangeError; }
    if (!rejected) throw new Error("Plot invalid range did not promptly throw RangeError");
  }
  return ["Plot visible grid bound/zero axis and actual canvas", "Plot invalid and nonprogressing range contract"];
}
