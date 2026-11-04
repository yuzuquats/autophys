// Starts `autophys serve` on a spare loopback port, checks /api/healthz and
// the route shapes, then drives the page in headless Chromium: deck -> app ->
// a proposal -> Approve, on the fixtures Source. Fails on any console error,
// page error, failed request or HTTP status >= 400.
//
//   deno run -A e2e/approve.ts <autophys-binary> <screenshot-dir> [-- <serve args>]
//
// The script owns both children: the server is killed by PID and the browser
// (launched with pipe: true, so it exits with this process) is closed in a
// finally. Serve args default to `--addr 127.0.0.1:4795`; 4794 is the unit.
import puppeteer, { type Browser, type ElementHandle, type Page } from "npm:puppeteer-core@22.7.1";

const [bin, outDir, sep, ...rest] = Deno.args;
if (!bin || !outDir || (sep !== undefined && sep !== "--")) {
  throw new Error("usage: approve.ts <autophys-binary> <screenshot-dir> [-- <serve args>]");
}
const serveArgs = rest.length ? rest : ["--addr", "127.0.0.1:4795"];
const addr = serveArgs[serveArgs.indexOf("--addr") + 1];
if (!addr || !/^127\.0\.0\.1:\d+$/.test(addr) || addr.endsWith(":4794")) {
  throw new Error(`serve args need --addr 127.0.0.1:<port other than 4794>, got ${serveArgs.join(" ")}`);
}
const base = `http://${addr}`;
await Deno.mkdir(outDir, { recursive: true });

// Chrome for Testing has no linux-arm64 build: use Playwright's aarch64
// Chromium unless AUTOPHYS_CHROME names a binary.
async function chromium(): Promise<string> {
  const explicit = Deno.env.get("AUTOPHYS_CHROME");
  if (explicit) return explicit;
  const root = `${Deno.env.get("HOME")}/.cache/ms-playwright`;
  const builds: string[] = [];
  for await (const e of Deno.readDir(root)) if (e.name.startsWith("chromium-")) builds.push(`${root}/${e.name}/chrome-linux/chrome`);
  const found = builds.sort().at(-1);
  if (!found) throw new Error(`no Chromium under ${root}; set AUTOPHYS_CHROME`);
  return found;
}

const errors: string[] = [];
const warnings: string[] = [];
const checks: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`failed: ${what}`);
  checks.push(what);
};
let shot = 0;
const shots: string[] = [];
const snap = async (page: Page, name: string) => {
  const path = `${outDir}/${String(++shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path });
  shots.push(path);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The ui renders inside the cookbook's slots, some behind shadow roots: query with pierce/.
const text = async (page: Page, selector: string) => {
  const el = await page.$(`pierce/${selector}`);
  return el ? await el.evaluate((e) => e.textContent?.trim() ?? "") : "";
};
const settle = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), { timeout: 8000 })
    .then(() => pause(150));

async function waitHealthy(child: Deno.ChildProcess): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000; // a dev serve bundles first
  let exited = false;
  child.status.then(() => (exited = true));
  while (Date.now() < deadline) {
    if (exited) throw new Error("autophys serve exited before it was healthy");
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) return await res.json();
      await res.body?.cancel();
    } catch { /* not listening yet */ }
    await pause(200);
  }
  throw new Error(`no healthz on ${base} within 120 s`);
}

// The innermost tree row whose text includes `label` (a parent row's text
// includes its children's).
async function treeRow(page: Page, label: string): Promise<ElementHandle<Element>> {
  let best: [ElementHandle<Element>, number] | null = null;
  for (const row of await page.$$("pierce/[role=treeitem]")) {
    const text = await row.evaluate((el) => el.textContent ?? "");
    if (text.includes(label) && (!best || text.length < best[1])) best = [row, text.length];
  }
  if (!best) throw new Error(`no tree row reading ${label}`);
  return best[0];
}

// Click once the element has stopped moving: the drawer and panels FLIP into
// place, and a box read mid-transition lands the click on another row.
async function clickWhenStill(handle: ElementHandle<Element>) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const box = JSON.stringify(await handle.boundingBox());
    if (box === last) break;
    last = box;
    await pause(150);
  }
  await handle.click();
}

const server = new Deno.Command(bin, { args: ["serve", ...serveArgs], stdout: "inherit", stderr: "inherit" }).spawn();
let browser: Browser | null = null;
try {
  const health = await waitHealthy(server);
  check(health.ok === true && typeof health.version === "string" && typeof health.commit === "string" && typeof health.tento_commit === "string",
    `healthz is {ok, version, commit, tento_commit}: ${JSON.stringify(health)}`);
  const deep = await fetch(`${base}/app/bench-a`);
  check(deep.status === 200 && (await deep.text()).includes("/index.root.js"), "/app/<item> answers the shell");
  const api = await fetch(`${base}/api/v1/workspace`);
  const apiBody = await api.json();
  check(api.status === 404 && apiBody.ok === false, "/api/v1/* is a JSON 404 until the store lands");

  browser = await puppeteer.launch({
    executablePath: await chromium(),
    pipe: true,
    // This host restricts unprivileged user namespaces (AppArmor), so the
    // Chromium sandbox cannot start; the page under test is our own loopback app.
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    else if (msg.type() === "warn") warnings.push(`console.warn: ${msg.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`));
  page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
  });
  await page.setViewport({ width: 1440, height: 900 });

  // deck
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".ck-deck-page");
  check(await page.title() === "Autophys", "page title is Autophys");
  check(await page.evaluate(() => document.documentElement.dataset.ckStage) === "landing", "stage is landing");
  await snap(page, "deck");
  await page.click('.ck-deck-arrow[aria-label="Next slide"]');
  await settle(page);
  await snap(page, "deck-slide-2");

  // app
  await page.click(".ck-open-link");
  await page.waitForSelector(".ck-panels[data-ready]");
  await page.waitForSelector("pierce/.ap-svg", { timeout: 20_000 });
  await settle(page);
  check(new URL(page.url()).pathname.startsWith("/app"), `URL is under /app (${page.url()})`);
  check(await page.$('.ck-app[data-cookbook="autophys"]') !== null, "the autophys app is mounted in the cookbook");
  await snap(page, "app");
  // Lower the first-visit tutorial out of the way.
  await page.waitForSelector(".ck-tour-dismiss", { timeout: 5000 }).catch(() => null);
  if (await page.$(".ck-tour-dismiss")) {
    await page.click(".ck-tour-dismiss");
    await settle(page);
  }
  check(await page.evaluate(() => document.documentElement.dataset.ckStage) === "app", "the tutorial is dismissed");

  // a proposal
  await clickWhenStill(await treeRow(page, "Sine 0.44"));
  await page.waitForSelector("pierce/#ap-action-approve", { timeout: 10_000 }).catch(async (error) => {
    await snap(page, "no-approve-button");
    throw error;
  });
  await settle(page);
  const before = await text(page, "#ap-status");
  check(/awaiting approval/i.test(before), `the proposal awaits approval ("${before}")`);
  await snap(page, "proposal");

  // Approve
  await clickWhenStill((await page.$("pierce/#ap-action-approve"))!);
  for (let i = 0; i < 50 && !(await text(page, "#ap-status")).startsWith("Approved by "); i++) await pause(100);
  await settle(page);
  const after = await text(page, "#ap-status");
  check(after.startsWith("Approved by james"), `details read "${after}"`);
  check(await page.$("pierce/#ap-action-approve") === null, "Approve is gone once approved");
  check(await page.$("pierce/#ap-action-withdraw") !== null, "Withdraw approval is offered");
  check((await (await treeRow(page, "Sine 0.44")).evaluate((el) => el.textContent ?? "")).includes("approved"), "the tree row's trail reads approved");
  await snap(page, "approved");
  await page.close();
} finally {
  await browser?.close();
  try {
    server.kill("SIGTERM");
  } catch { /* already gone */ }
  const status = await server.status;
  console.log(`autophys serve exited ${status.code}${status.signal ? ` (${status.signal})` : ""}`);
}

for (const c of checks) console.log(`ok   ${c}`);
for (const w of warnings) console.log(`warn ${w}`);
for (const e of errors) console.log(`FAIL ${e}`);
console.log(`${checks.length} checks, ${errors.length} console/page/network errors, ${warnings.length} warnings`);
console.log(`screenshots: ${shots.join(" ")}`);
if (errors.length) Deno.exit(1);
