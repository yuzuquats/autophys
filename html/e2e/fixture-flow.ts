// Adapts ops/check-flow.ts (the placeholder driver) to the autophys fixture UI.
// Preserves its 60 shell assertions, including desktop, phone, history and FLIP.
// Fails on any console
// error or warning, page error, failed request or HTTP status >= 400, phase
// by phase: header, deck, tutorial, sidebar, details, export, header-home,
// phone.
//
//   deno run -A html/e2e/fixture-flow.ts <base-url> <screenshot-dir> [<title>] [<app-id>]
//
// Uses tento-headless-js (pipe transport, temp profile, close in finally) so
// Chrome cannot outlive the script.
import type { Page } from "npm:puppeteer-core@22.7.1";

const [base, outDir, title = "Autophys", appId = "autophys"] = Deno.args;
if (!base || !outDir) throw new Error("usage: fixture-flow.ts <base-url> <screenshot-dir> [<title>] [<app-id>]");
await Deno.mkdir(outDir, { recursive: true });
const home = Deno.env.get("HOME")!;
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
// Chrome for Testing has no linux-arm64 build; on ARM use Playwright's
// aarch64 Chromium unless AUTOPHYS_CHROME names a binary.
async function chromeForHost(): Promise<string | undefined> {
  const explicit = Deno.env.get("AUTOPHYS_CHROME");
  if (explicit || Deno.build.arch !== "aarch64" || Deno.build.os !== "linux") return explicit;
  const root = `${home}/.cache/ms-playwright`;
  const builds: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith("chromium-")) builds.push(`${root}/${entry.name}/chrome-linux/chrome`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return builds.sort().at(-1);
}
const executablePath = await chromeForHost();

type Phase = { name: string; errors: string[]; checks: string[] };
const phases: Phase[] = [];
let phase: Phase = { name: "boot", errors: [], checks: [] };
const begin = (name: string) => phases.push(phase = { name, errors: [], checks: [] });
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`[${phase.name}] failed: ${what}`);
  phase.checks.push(what);
};
let shot = 0;
const snap = (page: Page, name: string) => page.screenshot({ path: `${outDir}/${String(++shot).padStart(2, "0")}-${name}.png` });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), { timeout: 5000 })
    .then(() => pause(120));
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? "");
const has = (page: Page, selector: string) => page.$(selector).then((el) => el !== null);
const stage = (page: Page) => page.evaluate(() => document.documentElement.dataset.ckStage);
const path = (page: Page) => new URL(page.url()).pathname;
const pane = (page: Page) => page.$eval(".ck-panels", (el) => (el as HTMLElement).dataset.mobile);

function watch(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") phase.errors.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => phase.errors.push(`pageerror: ${error}`));
  page.on("requestfailed", (req) => phase.errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) phase.errors.push(`http ${res.status()}: ${res.url()}`);
  });
}

try {
await withHeadless(async (browser) => {
  // ---------- desktop ----------
  const page = await browser.newPage();
  watch(page);
  await page.setViewport({ width: 1440, height: 900 });

  begin("header");
  await page.goto(`${base}/?source=fixtures`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".ck-deck-page");
  check(await text(page, ".ck-wordmark") === title, `wordmark reads ${title}`);
  check(await page.title() === title, `page title is ${title}`);
  check(await text(page, ".ck-open-link") === "Open app", "landing header offers Open app");
  check(!(await has(page, ".ck-header[data-app]")), "header starts in landing state");
  check(await stage(page) === "landing", "stage is landing");
  await snap(page, "header-and-deck-slide-1");

  begin("deck");
  check(await text(page, ".ck-deck-counter") === "1 / 6", "deck starts at 1 / 6");
  await page.click('.ck-deck-arrow[aria-label="Next slide"]');
  await pause(200);
  check(await has(page, ".ck-deck[data-moving]"), "pages recede into cards while moving");
  await snap(page, "deck-moving");
  await settle(page);
  check(!(await has(page, ".ck-deck[data-moving]")), "pages fill the screen again once settled");
  for (let i = 0; i < 4; i++) {
    await page.click('.ck-deck-arrow[aria-label="Next slide"]');
    await settle(page);
  }
  check(await text(page, ".ck-deck-counter") === "6 / 6", "forward to 6 / 6");
  check(await page.$eval('.ck-deck-arrow[aria-label="Next slide"]', (b) => (b as HTMLButtonElement).disabled), "next disabled on last slide");
  await snap(page, "deck-slide-6");
  await page.keyboard.press("ArrowLeft");
  await settle(page);
  check(await text(page, ".ck-deck-counter") === "5 / 6", "ArrowLeft steps back to 5 / 6");
  await page.click('.ck-deck-arrow[aria-label="Previous slide"]');
  await settle(page);
  check(await text(page, ".ck-deck-counter") === "4 / 6", "Previous steps back to 4 / 6");
  await snap(page, "deck-slide-4");
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowLeft");
    await settle(page);
  }
  check(await text(page, ".ck-deck-counter") === "1 / 6", "back to 1 / 6");
  await page.mouse.move(900, 500);
  await page.mouse.down();
  for (let x = 900; x >= 500; x -= 40) await page.mouse.move(x, 505);
  await page.mouse.up();
  await settle(page);
  check(await text(page, ".ck-deck-counter") === "2 / 6", "swipe left moves to 2 / 6");
  check(await page.evaluate(() => String(getSelection() ?? "")) === "", "swipe leaves no text selected");
  await page.keyboard.press("ArrowLeft");
  await settle(page);

  begin("tutorial");
  await page.click(".ck-open-link");
  await pause(300);
  await snap(page, "drawer-lowering");
  await page.waitForSelector(".ck-panels[data-ready]");
  await settle(page);
  check(path(page) === "/app", "URL is /app");
  check(await stage(page) === "tour", "stage is tour");
  check(await has(page, ".ck-header[data-app]"), "header in app state");
  check(await has(page, "pierce/[role=treeitem]"), "app mounted into the queue slot");
  const firstRow = await text(page, ".ap-crumb b");
  check(await text(page, ".ck-crumb-current") === firstRow, "breadcrumb names the selection");
  check(await text(page, ".ck-tour-title") === "The sidebar.", "tutorial step 1");
  await snap(page, "app-with-tutorial-step-1");
  await page.click(".ck-tour-show");
  await settle(page);
  check(await has(page, ".ck-target-ring"), "Show me rings the sidebar queue");
  await snap(page, "tutorial-show-sidebar");
  await page.click(".ck-tour-next");
  await settle(page);
  check(!(await has(page, ".ck-target-ring")), "ring clears on the next press");
  check(await text(page, ".ck-tour-title") === "Details.", "tutorial step 2");
  await page.click(".ck-tour-show");
  await settle(page);
  check(await has(page, ".ck-target-ring"), "Show me rings the details toggle");
  await snap(page, "tutorial-show-details-toggle");
  await page.click(".ck-tour-next");
  await settle(page);
  check(await text(page, ".ck-tour-title") === "Your way home.", "tutorial step 3");
  check((await text(page, ".ck-tour-next")).startsWith("Next"), "shell guide continues into the product guide");
  await page.click(".ck-tour-show");
  await settle(page);
  await snap(page, "tutorial-show-home");
  await page.click(".ck-tour-dismiss");
  await settle(page);
  check(await stage(page) === "app", "Dismiss lowers the tutorial out of the way");
  await snap(page, "app-full");

  begin("sidebar");
  const rows = [["config:bench-oscillators", "Configuration"], ["bench-a", "bench A"], ["bench-a/fit-1", "Fit #1"]];
  const queueRows = await page.$$("pierce/[role=treeitem]");
  check(queueRows.length >= 3, `queue lists ${queueRows.length} rows`);
  await page.click(`pierce/[role=treeitem][data-id="${rows[1][0]}"] > .line`);
  await pause(100);
  await snap(page, "sidebar-select-moving");
  await settle(page);
  check(await text(page, ".ap-crumb b") === rows[1][1], "main shows the selection");
  check(await text(page, ".ck-details-slot h3") === "Sine force", "investigation details show its decision");
  check(await text(page, ".ck-crumb-current") === rows[1][1], "breadcrumb follows");
  check(await page.$eval(`pierce/[role=treeitem][data-id="${rows[1][0]}"]`, (b) => b.getAttribute("aria-selected")) === "true", "aria-selected moves");
  await snap(page, "sidebar-row-2");
  await page.click(`pierce/[role=treeitem][data-id="${rows[2][0]}"] > .line`);
  await settle(page);
  check(await text(page, ".ap-crumb b") === rows[1][1] && await has(page, "#ap-bench-a-fit-1"), "third row opens the fit section on its investigation");
  check((await text(page, ".ck-status")).startsWith("Fixture data"), "status line names the fixture source");
  check(!(await has(page, ".ap-source")), "no demo-data strip in the main pane");

  begin("details");
  const mainBefore = await page.$eval(".ck-main", (el) => el.getBoundingClientRect().width);
  await page.click(".ck-details-toggle");
  await pause(120);
  check(await page.evaluate(() => document.getAnimations().some((a) => a.playState === "running")), "FLIP animations run on close");
  await snap(page, "details-closing");
  await settle(page);
  check(!(await has(page, ".ck-panels[data-details]")), "details closed");
  check(await page.$eval(".ck-details-toggle", (b) => b.getAttribute("aria-expanded")) === "false", "toggle reports collapsed");
  const mainAfter = await page.$eval(".ck-main", (el) => el.getBoundingClientRect().width);
  check(mainAfter > mainBefore + 200, `main widens (${mainBefore} -> ${mainAfter})`);
  await snap(page, "details-closed");
  await page.click(".ck-details-toggle");
  await settle(page);
  check(await has(page, ".ck-panels[data-details]"), "details reopened");
  await page.click(".ck-sidebar-toggle");
  await settle(page);
  check(!(await has(page, ".ck-panels[data-sidebar]")), "sidebar closed");
  await snap(page, "sidebar-closed");
  await page.click(".ck-sidebar-toggle");
  await settle(page);
  check(await has(page, ".ck-panels[data-sidebar]"), "sidebar reopened");

  begin("export");
  await page.evaluate(() => {
    const saved: string[] = [];
    (globalThis as { savedDownloads?: string[] }).savedDownloads = saved;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) saved.push(this.download);
      else click.call(this);
    };
  });
  await page.click(".ck-export");
  const saved = await page.evaluate(() => (globalThis as { savedDownloads?: string[] }).savedDownloads);
  check(JSON.stringify(saved) === JSON.stringify([`${appId}-export.json`]), `header Export saves ${appId}-export.json via app.export()`);

  begin("header-home");
  await page.keyboard.press("ArrowUp");
  await settle(page);
  check(await stage(page) === "tour", "ArrowUp raises the tutorial peek");
  await page.click(".ck-brand");
  await pause(250);
  await snap(page, "header-home-returning");
  await settle(page);
  check(await stage(page) === "landing", "wordmark returns to the deck");
  check(path(page) === "/", "URL is /");
  check(!(await has(page, ".ck-header[data-app]")), "header back in landing state");
  check(!(await has(page, "pierce/[role=treeitem]")), "app unmounted once the deck settled");
  await page.goBack();
  await page.waitForSelector(".ck-panels[data-ready]");
  await settle(page);
  check(await stage(page) === "tour" && path(page) === "/app", "Back reopens the app");
  check(await text(page, ".ap-crumb b") === rows[1][1], "remount keeps the investigation page");
  await page.keyboard.press("ArrowDown");
  await settle(page);
  check(await stage(page) === "app", "ArrowDown lowers the tutorial");
  await page.keyboard.press("ArrowUp");
  await settle(page);
  await page.keyboard.press("ArrowUp");
  await settle(page);
  check(await stage(page) === "landing", "ArrowUp twice returns to the deck");
  await page.close();

  // ---------- phone ----------
  begin("phone");
  const phone = await browser.newPage();
  watch(phone);
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.goto(`${base}/app?source=fixtures`, { waitUntil: "networkidle0" });
  await phone.waitForSelector(".ck-panels[data-ready]");
  await settle(phone);
  check(await stage(phone) === "tour", "deep link opens the app with the tutorial");
  check(!(await phone.evaluate(() => document.activeElement?.matches(".ck-brand"))), "deep link moves no focus");
  await snap(phone, "phone-app-tutorial");
  await phone.click(".ck-tour-dismiss");
  await settle(phone);
  check(await stage(phone) === "app", "close button dismisses the tutorial");
  await phone.click(".ck-sidebar-toggle");
  await settle(phone);
  check(await pane(phone) === "sidebar", "sidebar sheet opens");
  await snap(phone, "phone-sidebar-sheet");
  const phoneRows = await phone.$$eval("pierce/[role=treeitem]", (els) => els.map((el) => (el as HTMLElement).dataset.id!));
  await phone.click(`pierce/[role=treeitem][data-id="${phoneRows[0]}"] > .line`);
  await settle(phone);
  check(await pane(phone) === "main", "a pick returns to main (shell.onSelect)");
  await phone.click(".ck-details-toggle");
  await settle(phone);
  check(await pane(phone) === "details", "details sheet opens");
  await snap(phone, "phone-details-sheet");
  await phone.keyboard.press("Escape");
  await settle(phone);
  check(await pane(phone) === "main", "Escape closes the sheet");
  await phone.goBack();
  await settle(phone);
  check(await stage(phone) === "landing", "Back from a deep link lands on the deck");
  await snap(phone, "phone-deck");
  await phone.close();
}, executablePath ? {
  executablePath,
  // This host restricts unprivileged user namespaces (AppArmor), so the
  // Chromium sandbox cannot start; the page under test is our own loopback app.
  args: ["--no-sandbox"],
} : undefined);

} finally {
let failed = false;
for (const p of phases) {
  console.log(`${p.errors.length ? "FAIL" : "ok  "} ${p.name}: ${p.checks.length} checks, ${p.errors.length} console/page/network errors`);
  for (const e of p.errors) console.log(`       ${e}`);
  failed ||= p.errors.length > 0;
}
console.log(`${phases.reduce((n, p) => n + p.checks.length, 0)} checks, ${phases.reduce((n, p) => n + p.errors.length, 0)} errors; screenshots: ${outDir} (${shot})`);
if (failed) throw new Error("fixture flow logged browser errors");
}
