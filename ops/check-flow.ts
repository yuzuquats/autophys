// Drives the autophys shell in headless Chrome and fails on any console
// error, page error, failed request or HTTP error, phase by phase.
//
//   deno run -A ops/check-flow.ts http://127.0.0.1:4794 <screenshot-dir>
//
// Uses tento-headless-js (pipe transport, temp profile, close in finally) so
// Chrome cannot outlive the script.
import type { Page } from "npm:puppeteer-core@22.7.1";

const [base, outDir] = Deno.args;
if (!base || !outDir) throw new Error("usage: check-flow.ts <base-url> <screenshot-dir>");
await Deno.mkdir(outDir, { recursive: true });
const home = Deno.env.get("HOME")!;
const { withHeadless } = await import(`file://${home}/workspace/tento/tento-headless-js/mod.ts`);
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
const snap = async (page: Page, name: string) => {
  const path = `${outDir}/${String(++shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path });
  return path;
};
const settle = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), {
    timeout: 5000,
  })
    .then(() => new Promise((r) => setTimeout(r, 120)));
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? "");
const has = (page: Page, selector: string) => page.$(selector).then((el) => el !== null);
const stage = (page: Page) => page.evaluate(() => document.documentElement.dataset.stage);

function watch(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      phase.errors.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (error) => phase.errors.push(`pageerror: ${error}`));
  page.on(
    "requestfailed",
    (req) => phase.errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) phase.errors.push(`http ${res.status()}: ${res.url()}`);
  });
}

await withHeadless(
  async (browser) => {
    // ---------- desktop ----------
    const page = await browser.newPage();
    watch(page);
    await page.setViewport({ width: 1440, height: 900 });

    begin("header");
    await page.goto(`${base}/`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".deck-page");
    check(await text(page, ".wordmark") === "autophys", "wordmark reads autophys");
    check(await text(page, ".open-link") === "Open app", "landing header offers Open app");
    check(!(await has(page, ".site-header[data-app]")), "header starts in landing state");
    check(await stage(page) === "landing", "stage is landing");
    await snap(page, "header-and-deck-slide-1");

    begin("deck");
    check(await text(page, ".deck-counter") === "1 / 6", "deck starts at 1 / 6");
    await page.click('.deck-arrow[aria-label="Next slide"]');
    await new Promise((r) => setTimeout(r, 200));
    check(await has(page, ".deck[data-moving]"), "pages recede into cards while moving");
    await snap(page, "deck-moving");
    await settle(page);
    check(!(await has(page, ".deck[data-moving]")), "pages fill the screen again once settled");
    for (let i = 0; i < 4; i++) {
      await page.click('.deck-arrow[aria-label="Next slide"]');
      await settle(page);
    }
    check(await text(page, ".deck-counter") === "6 / 6", "forward to 6 / 6");
    check(
      await page.$eval('.deck-arrow[aria-label="Next slide"]', (b) => (b as HTMLButtonElement).disabled),
      "next disabled on last slide",
    );
    await snap(page, "deck-slide-6");
    await page.keyboard.press("ArrowLeft");
    await settle(page);
    check(await text(page, ".deck-counter") === "5 / 6", "ArrowLeft steps back to 5 / 6");
    await page.click('.deck-arrow[aria-label="Previous slide"]');
    await settle(page);
    check(await text(page, ".deck-counter") === "4 / 6", "Previous steps back to 4 / 6");
    await snap(page, "deck-slide-4");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowLeft");
      await settle(page);
    }
    check(await text(page, ".deck-counter") === "1 / 6", "back to 1 / 6");
    // Swipe: drag left past a fifth of the width.
    await page.mouse.move(900, 500);
    await page.mouse.down();
    for (let x = 900; x >= 500; x -= 40) await page.mouse.move(x, 505);
    await page.mouse.up();
    await settle(page);
    check(await text(page, ".deck-counter") === "2 / 6", "swipe left moves to 2 / 6");
    await page.keyboard.press("ArrowLeft");
    await settle(page);

    begin("tutorial");
    await page.click(".open-link");
    await new Promise((r) => setTimeout(r, 300));
    await snap(page, "drawer-lowering");
    await page.waitForSelector(".panels[data-ready]");
    await settle(page);
    check(new URL(page.url()).pathname === "/app/untitled-1", "URL is /app/untitled-1");
    check(await stage(page) === "tour", "stage is tour");
    check(await has(page, ".site-header[data-app]"), "header in app state");
    check(await text(page, ".crumb-current") === "Untitled 1", "breadcrumb names the item");
    check(await text(page, ".tour-title") === "The sidebar.", "tutorial step 1");
    await snap(page, "app-with-tutorial-step-1");
    await page.click(".tour-show");
    await settle(page);
    check(await has(page, ".target-ring"), "Show me rings the sidebar list");
    await snap(page, "tutorial-show-sidebar");
    await page.click(".tour-next");
    await settle(page);
    check(!(await has(page, ".target-ring")), "ring clears on the next press");
    check(await text(page, ".tour-title") === "Details.", "tutorial step 2");
    await page.click(".tour-show");
    await settle(page);
    check(await has(page, ".target-ring"), "Show me rings the details toggle");
    await snap(page, "tutorial-show-details-toggle");
    await page.click(".tour-next");
    await settle(page);
    check(await text(page, ".tour-title") === "Your way home.", "tutorial step 3");
    check(await text(page, ".tour-next") === "Done", "last step offers Done");
    await page.click(".tour-show");
    await settle(page);
    await snap(page, "tutorial-show-home");
    await page.click(".tour-next");
    await settle(page);
    check(await stage(page) === "app", "Done lowers the tutorial out of the way");
    await snap(page, "app-full");

    begin("sidebar");
    await page.click('.nav-item[data-id="untitled-2"]');
    await new Promise((r) => setTimeout(r, 120));
    await snap(page, "sidebar-select-moving");
    await settle(page);
    check(new URL(page.url()).pathname === "/app/untitled-2", "URL follows the selection");
    check(await text(page, ".main-title") === "Untitled 2", "main shows the selection");
    check(await text(page, ".detail-name") === "Untitled 2", "details show the selection");
    check(await text(page, ".crumb-current") === "Untitled 2", "breadcrumb follows");
    check(
      await page.$eval('.nav-item[data-id="untitled-2"]', (b) => b.getAttribute("aria-current")) === "true",
      "aria-current moves",
    );
    await snap(page, "sidebar-untitled-2");
    await page.click('.nav-item[data-id="untitled-3"]');
    await settle(page);
    check(await text(page, ".main-title") === "Untitled 3", "third item");
    check(/Server ok · 0\.1\.0 · /.test(await text(page, ".health")), "status line reads healthz");
    check(await page.evaluate(() => history.length) >= 2, "history has the landing entry");

    begin("details");
    const mainBefore = await page.$eval(".main", (el) => el.getBoundingClientRect().width);
    await page.click(".details-toggle");
    await new Promise((r) => setTimeout(r, 120));
    check(
      await page.evaluate(() => document.getAnimations().some((a) => a.playState === "running")),
      "FLIP animations run on close",
    );
    await snap(page, "details-closing");
    await settle(page);
    check(!(await has(page, ".panels[data-details]")), "details closed");
    check(
      await page.$eval(".details-toggle", (b) => b.getAttribute("aria-expanded")) === "false",
      "toggle reports collapsed",
    );
    const mainAfter = await page.$eval(".main", (el) => el.getBoundingClientRect().width);
    check(mainAfter > mainBefore + 200, `main widens (${mainBefore} → ${mainAfter})`);
    await snap(page, "details-closed");
    await page.click(".details-toggle");
    await settle(page);
    check(await has(page, ".panels[data-details]"), "details reopened");
    await page.click(".sidebar-toggle");
    await settle(page);
    check(!(await has(page, ".panels[data-sidebar]")), "sidebar closed");
    await snap(page, "sidebar-closed");
    await page.click(".sidebar-toggle");
    await settle(page);
    check(await has(page, ".panels[data-sidebar]"), "sidebar reopened");

    begin("header-home");
    await page.keyboard.press("ArrowUp");
    await settle(page);
    check(await stage(page) === "tour", "ArrowUp raises the tutorial peek");
    await page.click(".brand");
    await new Promise((r) => setTimeout(r, 250));
    await snap(page, "header-home-returning");
    await settle(page);
    check(await stage(page) === "landing", "wordmark returns to the deck");
    check(new URL(page.url()).pathname === "/", "URL is /");
    check(!(await has(page, ".site-header[data-app]")), "header back in landing state");
    await page.goBack();
    await page.waitForSelector(".panels[data-ready]");
    await settle(page);
    check(
      await stage(page) === "tour" && new URL(page.url()).pathname === "/app/untitled-3",
      "Back reopens the app on the same item",
    );
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
    await phone.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await phone.goto(`${base}/app/untitled-2`, { waitUntil: "networkidle0" });
    await phone.waitForSelector(".panels[data-ready]");
    await settle(phone);
    check(await stage(phone) === "tour", "deep link opens the app with the tutorial");
    check(await text(phone, ".main-title") === "Untitled 2", "deep link selects the item");
    await snap(phone, "phone-app-tutorial");
    await phone.click(".tour-dismiss");
    await settle(phone);
    check(await stage(phone) === "app", "close button dismisses the tutorial");
    await phone.click(".sidebar-toggle");
    await settle(phone);
    check(
      await phone.$eval(".panels", (el) => (el as HTMLElement).dataset.mobile) === "sidebar",
      "sidebar sheet opens",
    );
    await snap(phone, "phone-sidebar-sheet");
    await phone.click('.nav-item[data-id="untitled-1"]');
    await settle(phone);
    check(
      await phone.$eval(".panels", (el) => (el as HTMLElement).dataset.mobile) === "main",
      "selecting returns to main",
    );
    check(await text(phone, ".main-title") === "Untitled 1", "phone selection");
    await phone.click(".details-toggle");
    await settle(phone);
    await snap(phone, "phone-details-sheet");
    await phone.keyboard.press("Escape");
    await settle(phone);
    check(
      await phone.$eval(".panels", (el) => (el as HTMLElement).dataset.mobile) === "main",
      "Escape closes the sheet",
    );
    await phone.goBack();
    await settle(phone);
    check(await stage(phone) === "landing", "Back from a deep link lands on the deck");
    await snap(phone, "phone-deck");
    await phone.close();
  },
  executablePath
    ? {
      executablePath,
      // This host restricts unprivileged user namespaces (AppArmor), so the
      // Chromium sandbox cannot start; the page under test is our own loopback app.
      args: ["--no-sandbox"],
    }
    : undefined,
);

let failed = false;
for (const p of phases) {
  console.log(
    `${
      p.errors.length ? "FAIL" : "ok  "
    } ${p.name}: ${p.checks.length} checks, ${p.errors.length} console/page/network errors`,
  );
  for (const e of p.errors) console.log(`       ${e}`);
  failed ||= p.errors.length > 0;
}
console.log(`screenshots: ${outDir} (${shot})`);
if (failed) Deno.exit(1);
