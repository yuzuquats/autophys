/// <reference lib="dom" />
/** Regenerate the ten native-size tour crops. This captures assets; it runs no tests.
 * Start an isolated daemon built from this checkout on a free port in 47980..47989.
 * deno run -A html/e2e/capture-tour-images.ts http://127.0.0.1:47980 <evidence-dir>
 */
import { withHeadless } from "../../vendor/tento/tento-headless-js/mod.ts";
const [base, evidence] = Deno.args;
if (!/^http:\/\/127\.0\.0\.1:4798[0-9]$/.test(base) || !evidence) {
  throw new Error("capture-tour-images.ts <loopback:47980..47989> <evidence-dir>");
}
const assets = new URL("../routes/tour-images/", import.meta.url);
await Deno.mkdir(assets, { recursive: true });
await Deno.mkdir(evidence, { recursive: true });
const names = ["workspace", "configuration", "investigation", "measured-data", "fit", "residuals", "sensitivity", "proposal", "validation", "start"];
const captures: { name: string; title: string; bytes: number }[] = [];
await withHeadless(async browser => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.goto(base + "/app?source=fixtures", { waitUntil: "networkidle0" });
  if (await page.$eval("html", el => el.getAttribute("data-ck-stage") !== "tour")) {
    await page.evaluate(() => document.dispatchEvent(new Event("ap-tour-start")));
  }
  // Hide tour chrome only for the asset capture, never in the shipped UI.
  await page.addStyleTag({ content: ".ck-tour-peek,.ck-target-ring,.ap-tour-chip { visibility:hidden!important }" });
  for (let index = 0; index < names.length; index++) {
    // Capture after the existing panel slide, at native layout and font sizes.
    await new Promise(resolve => setTimeout(resolve, 450));
    const region = await page.evaluate((index: number) => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const row = (id: string) => document.querySelector("std-tree-list.ap-tree")!.shadowRoot!.querySelector('[data-id="' + id + '"] > .line')!;
      const cards = [...document.querySelectorAll(".ap-viewer .ap-card")];
      const card = (label: string) => cards.find(c => c.textContent?.startsWith(label))!;
      let el: Element, yOffset = -16;
      if (index === 0) { el = row("config:bench-oscillators"); yOffset = -56; }
      else if (index === 1) el = row("config:bench-oscillators");
      else if (index === 2) el = row("bench-a");
      else if (index === 3 || index === 4) {
        const parent = card(index === 3 ? "Data" : "Fit #1");
        el = [...parent.querySelectorAll("svg")].find(svg => svg.textContent?.includes("Displacement"))!;
        yOffset = -8;
      } else if (index === 5) {
        el = [...card("Fit #1").querySelectorAll("svg")].find(svg => svg.textContent?.includes("measured − model"))!;
        yOffset = -40;
      } else if (index === 6) el = card("Identifiability");
      else if (index === 7) { el = document.querySelector(".ck-decision")!; yOffset = -112; }
      else if (index === 8) el = card("Validate");
      else el = document.querySelector(".ap-new-project")!;
      const r = rect(el);
      // Large charts are cropped to the left-hand axis and early samples;
      // no chart or label is scaled down. Keep 16px horizontal context.
      const x = Math.max(0, Math.min(innerWidth - 320, r.left - 16));
      const y = Math.max(80, Math.min(innerHeight - 166, r.top + yOffset));
      return { x: Math.floor(x), y: Math.floor(y), width: 320, height: 166,
        title: document.querySelector(".ck-tour-title")!.textContent! };
    }, index);
    const { title, ...clip } = region;
    const name = names[index];
    const bytes = await page.screenshot({ type: "webp", quality: 88, clip });
    await Deno.writeFile(new URL(name + ".webp", assets), bytes);
    captures.push({ name, title, bytes: bytes.length });
    console.log(name, bytes.length, JSON.stringify(clip));
    if (index < names.length - 1) await page.evaluate(() => (document.querySelector(".ck-tour-next") as HTMLButtonElement).click());
  }
  // A portable visual receipt; assets are displayed at their native CSS size.
  const tiles = await Promise.all(captures.map(async (c, i) => {
    const bytes = await Deno.readFile(new URL(c.name + ".webp", assets));
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    return `<figure><figcaption>${i + 1}. ${c.title}</figcaption><img width="320" height="166" src="data:image/webp;base64,${btoa(binary)}"></figure>`;
  }));
  const sheet = await browser.newPage();
  await sheet.setViewport({ width: 736, height: 1110, deviceScaleFactor: 1 });
  await sheet.setContent(`<html><style>body{margin:24px;background:#fafafa;font:14px system-ui;color:#222}main{display:grid;grid-template-columns:320px 320px;gap:20px 32px}figure{margin:0}figcaption{height:28px;font-weight:600}img{display:block;border-radius:8px;box-shadow:0 0 0 1px #ddd}</style><main>${tiles.join("")}</main></html>`);
  await sheet.screenshot({ path: evidence + "/contact-sheet.png", fullPage: true });
  await Deno.writeTextFile(evidence + "/captures.json", JSON.stringify(captures, null, 2));
}, {
  executablePath: Deno.env.get("HOME") + "/.cache/ms-playwright/chromium-1148/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
