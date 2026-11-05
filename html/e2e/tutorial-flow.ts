/// <reference lib="dom" />
/** Guided-tour acceptance against a scratch daemon: the cookbook tutorial running the Autophys
 * steps on demo data. Browser lifetime belongs to withHeadless. */
import type { Page } from "npm:puppeteer-core@22.7.1";
const [base, out] = Deno.args;
if (!/^http:\/\/127\.0\.0\.1:479[6-9][0-9]$/.test(base) || !out) throw new Error("tutorial-flow.ts <loopback:47960..47999> <evidence>");
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
await Deno.mkdir(out, { recursive: true });
const checks: string[] = [], shots: string[] = [], errors: string[] = [];
function check(ok: boolean, text: string) { if (!ok) throw new Error(text); checks.push(text); console.log("ok " + text); }
/** Polls from the test side. Puppeteer's in-page poller can stall after a tour exit (its timers
 * stop firing), while a fresh evaluate each time always answers. */
async function until<A extends unknown[]>(p: Page, fn: (...args: A) => boolean, ...args: A) {
  const end = Date.now() + 30000;
  // deno-lint-ignore no-explicit-any
  while (!(await p.evaluate(fn as any, ...args))) {
    if (Date.now() > end) throw new Error("timed out waiting for " + fn.toString().slice(0, 120));
    await new Promise(r => setTimeout(r, 100));
  }
}
const settle = (p: Page) => until(p, () => document.getAnimations().every(a => a.playState !== "running"));
const stage = (p: Page) => p.evaluate(() => document.documentElement.dataset.ckStage);
/** The step is drawn: its title shows, the highlight has followed and the preview is filled. */
async function ready(p: Page, title: string) {
  await until(p, (t: string) => document.querySelector(".ck-tour-title")?.textContent === t &&
    document.querySelectorAll(".ck-target-ring").length > 0 &&
    (() => {
      const image = document.querySelector<HTMLImageElement>(".ck-tour-preview img.ap-tour-image");
      return !!image?.complete && image.naturalWidth > 0;
    })(), title);
  await settle(p);
}
async function snapshot(p: Page) {
  return await p.evaluate(() => {
    const tree = document.querySelector("std-tree-list.ap-tree")?.shadowRoot;
    const scroll: [string, number, number][] = [];
    const walk = (root: Element | ShadowRoot, path: string) => {
      if (root instanceof HTMLElement && (root.scrollTop || root.scrollLeft)) scroll.push([path, root.scrollTop, root.scrollLeft]);
      if (root instanceof Element && root.shadowRoot) walk(root.shadowRoot, path + "#");
      [...root.children].forEach((e, i) => walk(e, path + "/" + i));
    };
    walk(document.querySelector(".ck-panels")!, "panels");
    const panels = document.querySelector<HTMLElement>(".ck-panels")!;
    return { selected: [...tree?.querySelectorAll('[aria-selected="true"]') ?? []].map(e => (e as HTMLElement).dataset.id),
      expanded: [...tree?.querySelectorAll('[aria-expanded="true"]') ?? []].map(e => (e as HTMLElement).dataset.id),
      sidebar: panels.hasAttribute("data-sidebar"), details: panels.hasAttribute("data-details"), mobile: panels.dataset.mobile,
      text: document.querySelector(".ck-main")?.textContent, detailText: document.querySelector(".ck-details-slot")?.textContent, scroll };
  });
}
/** Out of the tour with Esc, back in the app stage with nothing animating. On phones the first
 * Esc closes the panel sheet a step opened (the cookbook's order), so press until the tour ends. */
async function leaveTour(p: Page) {
  for (let press = 0; press < 3 && await stage(p) !== "app"; press++) {
    await p.keyboard.press("Escape");
    await new Promise(r => setTimeout(r, 300));
  }
  await until(p, () => document.documentElement.dataset.ckStage === "app");
  await settle(p); await new Promise(r => setTimeout(r, 420));
}
async function takeTour(p: Page, first: string) { await p.evaluate(() => document.dispatchEvent(new Event("ap-tour-start"))); await ready(p, first); }
// The crumb names the project's Configuration, or the investigation for every page inside it.
const sequence = [
  ["Your workspace", "config:bench-oscillators", "Configuration"],
  ["A project's configuration", "config:bench-oscillators", "Configuration"],
  ["Open an investigation", "bench-a", "bench A"],
  ["Read the measured data", "bench-a/data/free_response@1", "bench A"],
  ["Read a fit", "bench-a/fit-1/fit", "bench A"],
  ["Check the residuals", "bench-a/fit-1/residuals", "bench A"],
  ["See what the data pins down", "bench-a/sens", "bench A"],
  ["Decide the next experiment", "bench-a/prop/p1", "bench A"],
  ["Check the validation", "bench-a/validate", "bench A"],
  ["Start your own", "config:bench-oscillators", "Configuration"],
] as const;
await withHeadless(async b => {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const p = await b.newPage(); await p.setViewport({ width, height });
    if (width === 390) await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    p.on("pageerror", e => errors.push(String(e)));
    p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await p.evaluateOnNewDocument(() => localStorage.removeItem("autophys.tour.seen.local"));
    // Opening the app by URL starts the tour; leave it to set up a non-default view first.
    await p.goto(base + "/app?source=fixtures", { waitUntil: "load" });
    await ready(p, sequence[0][0]);
    check(await stage(p) === "tour", width + ": opening the app starts the tour");
    await leaveTour(p);
    if (width < 640) await p.click(".ck-sidebar-toggle");
    await settle(p);
    await p.evaluate(() => (document.querySelector("std-tree-list.ap-tree")?.shadowRoot?.querySelector('[data-id="bench-a/fit-1/landscape"] > .line') as HTMLElement).click());
    await settle(p);
    if (width >= 640 && await p.$eval(".ck-details-toggle", e => e.getAttribute("aria-pressed") === "true")) await p.click(".ck-details-toggle");
    await p.evaluate(() => {
      const rail = document.querySelector("std-rail")?.shadowRoot?.querySelector("#body") as HTMLElement;
      if (rail) rail.scrollTop = 67;
      const main = document.querySelector(".ap-viewer") as HTMLElement;
      if (main) main.scrollTop = 83;
    });
    await settle(p);
    const before = await snapshot(p);
    await takeTour(p, sequence[0][0]);
    for (let i = 0; i < sequence.length; i++) {
      const [title, expected, leaf] = sequence[i];
      await ready(p, title);
      const state = await p.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".ck-tour-peek")!.getBoundingClientRect();
        const tree = document.querySelector("std-tree-list.ap-tree")?.shadowRoot;
        const rings = [...document.querySelectorAll<HTMLElement>(".ck-target-ring")].map(r => {
          const a = r.getBoundingClientRect();
          return { clear: a.bottom - 4 <= sheet.top + 1 && a.top + 4 >= 56, width: a.width };
        });
        return {
          selected: tree?.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.id,
          rings, bars: [...document.querySelectorAll<HTMLElement>(".ck-tour-bars b")].map(b => b.style.width),
          chip: !document.querySelector<HTMLElement>(".ap-tour-chip")!.hidden,
          decisions: [...document.querySelectorAll<HTMLButtonElement>("#ap-action-approve,#ap-action-reject")].map(b => b.disabled),
          back: !document.querySelector<HTMLButtonElement>(".ck-tour-back")!.hidden,
          next: document.querySelector(".ck-tour-next")?.textContent,
        };
      });
      check(state.selected === expected, `${width}: "${title}" selects the real row (${state.selected})`);
      const crumb = await p.$eval(".ap-crumb", e => e.textContent ?? "");
      check(crumb.includes(leaf), `${width}: Main follows the selected ${leaf} row`);
      check(state.rings.length > 0 && state.rings.every(r => r.clear), `${width}: "${title}" highlights its component above the sheet ${JSON.stringify(state.rings)}`);
      check(state.chip, `${width}: demo source is clearly labeled`);
      check(state.bars.length === 9, `${width}: nine progress bars, the two-part step sharing one`);
      if (i === 4 || i === 5) check(state.bars[4] === (i === 4 ? "50%" : "100%"), `${width}: the two-part step fills its shared bar (${state.bars[4]})`);
      if (title === "Decide the next experiment") check(state.decisions.length === 2 && state.decisions.every(Boolean), `${width}: demo Approve and Reject are disabled`);
      if (i === sequence.length - 1) check(state.rings.length === 2 && state.next === "Done", `${width}: the last step highlights both entry rows and offers Done`);
      check(state.back === (i > 0), `${width}: Back shows from the second step`);
      const name = `step-${i + 1}-${width}x${height}.png`;
      await p.screenshot({ path: out + "/" + name }); shots.push(name);
      if (i < sequence.length - 1) await p.keyboard.press("ArrowRight");
    }
    // Back replays the earlier steps' enter actions (selection and panels).
    await p.keyboard.press("ArrowLeft"); await ready(p, sequence[8][0]);
    await p.keyboard.press("ArrowLeft"); await ready(p, sequence[7][0]);
    check(await p.evaluate(() => document.querySelector("std-tree-list.ap-tree")?.shadowRoot?.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.id) === "bench-a/prop/p1", `${width}: Back replays the step's selection`);
    await leaveTour(p);
    check(JSON.stringify(await snapshot(p)) === JSON.stringify(before), `${width}: Esc restores selection, expansions, panels, scroll and source view exactly`);
    check(await p.evaluate(() => !localStorage.getItem("autophys.tour.seen.local")), `${width}: Esc does not mark the tour seen`);
    await takeTour(p, sequence[0][0]); await p.click(".ck-tour-dismiss");
    await until(p, () => document.documentElement.dataset.ckStage === "app"); await settle(p); await new Promise(r => setTimeout(r, 420));
    check(JSON.stringify(await snapshot(p)) === JSON.stringify(before), `${width}: close restores the same snapshot`);
    await takeTour(p, sequence[0][0]);
    for (let i = 1; i < sequence.length; i++) { await p.keyboard.press("ArrowRight"); await ready(p, sequence[i][0]); }
    await p.click(".ck-tour-next");
    await until(p, () => document.documentElement.dataset.ckStage === "app"); await settle(p); await new Promise(r => setTimeout(r, 420));
    check(JSON.stringify(await snapshot(p)) === JSON.stringify(before), `${width}: Done restores the same snapshot`);
    check(await p.evaluate(() => localStorage.getItem("autophys.tour.seen.local") === "true"), `${width}: Done records the tour seen`);
    // An empty live workspace offers the tour, and leaving it puts the live view back.
    await p.goto(base + "/app", { waitUntil: "load" }); await ready(p, sequence[0][0]); await leaveTour(p);
    await settle(p);
    const empty = await snapshot(p);
    await takeTour(p, sequence[0][0]); await leaveTour(p);
    check(JSON.stringify(await snapshot(p)) === JSON.stringify(empty), `${width}: a tour from the live workspace restores the live data source`);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal document overflow`);
    await p.close();
  }
}, { executablePath: Deno.env.get("AUTOPHYS_CHROME") ?? Deno.env.get("HOME") + "/.cache/ms-playwright/chromium-1112/chrome-linux/chrome", args: ["--no-sandbox"] });
check(errors.length === 0, "no browser console or page errors: " + errors.join("; "));
await Deno.writeTextFile(out + "/tutorial-flow.json", JSON.stringify({ checks, shots }, null, 1));
console.log(`${checks.length} checks, ${shots.length} captures`);
