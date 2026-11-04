// Drives the autophys page on a running `autophys serve` in headless Chromium, both sources:
//
//   fixtures  /app?source=fixtures: the status line says so; Sine 0.44 Hz → Approve.
//   daemon    /app (the daemon answers): a seeded investigation renders; tab C watches the
//             proposal while tab B approves it and C sees "Approved by" arrive over SSE; tab A,
//             whose stream is blocked, approves too and shows the daemon's 409 as Not saved;
//             a device pairing is approved in the UI (O-3) and its key then attaches the
//             experiment's data, which C sees arrive over SSE.
//
//   deno run -A html/e2e/daemon-flow.ts <base-url> <screenshot-dir>
//
// The daemon must hold exactly one investigation with one proposal awaiting approval (the
// SDK seed in ui.md). Fails on any console error, page error, failed request or HTTP status
// >= 400 other than the ones a step provokes on purpose. Chromium comes from
// tento-headless-js (pipe transport, closed in finally), so it cannot outlive the script.
import type { ElementHandle, HTTPRequest, Page } from "npm:puppeteer-core@22.7.1";

const [base, outDir, emptyBase] = Deno.args;
if (!base || !outDir) throw new Error("usage: daemon-flow.ts <base-url> <screenshot-dir>");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || base.endsWith(":4794")) throw new Error(`refusing ${base}: a scratch loopback daemon only, never the live 4794`);
await Deno.mkdir(outDir, { recursive: true });
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);

async function chromeForHost(): Promise<string | undefined> {
  const explicit = Deno.env.get("AUTOPHYS_CHROME");
  if (explicit || Deno.build.arch !== "aarch64" || Deno.build.os !== "linux") return explicit;
  const root = `${Deno.env.get("HOME")}/.cache/ms-playwright`, builds: string[] = [];
  try { for await (const e of Deno.readDir(root)) if (e.name.startsWith("chromium-")) builds.push(`${root}/${e.name}/chrome-linux/chrome`); } catch { /* none */ }
  return builds.sort().at(-1);
}

const checks: string[] = [], errors: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`failed: ${what}`); checks.push(what); console.log(`ok   ${what}`); };
let shot = 0;
const snap = (page: Page, name: string) => page.screenshot({ path: `${outDir}/${String(++shot).padStart(2, "0")}-${name}.png` });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), { timeout: 8000 }).then(() => pause(150));
const text = async (page: Page, selector: string) => {
  const el = await page.$(`pierce/${selector}`);
  return el ? await el.evaluate((e) => e.textContent?.trim() ?? "") : "";
};
async function until(page: Page, what: string, ok: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ok()) return; await pause(100); }
  await snap(page, `timeout-${what.replace(/\W+/g, "-")}`);
  throw new Error(`failed: ${what} within ${ms} ms`);
}

/** Errors a page may log on purpose (a provoked 409, a stream the test blocked). */
function watch(page: Page, name: string, expected: RegExp[] = []) {
  const record = (line: string) => { if (!expected.some((re) => re.test(line))) errors.push(`[${name}] ${line}`); };
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") record(`console.${m.type()}: ${m.text()} ${m.location()?.url ?? ""}`); });
  page.on("pageerror", (e) => record(`pageerror: ${e}`));
  page.on("requestfailed", (r) => record(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) record(`http ${r.status()}: ${r.url()}`); });
}

async function treeRow(page: Page, label: string): Promise<ElementHandle<Element>> {
  let best: [ElementHandle<Element>, number] | null = null;
  for (const row of await page.$$("pierce/[role=treeitem]")) {
    const t = await row.evaluate((el) => el.textContent ?? "");
    if (t.includes(label) && (!best || t.length < best[1])) best = [row, t.length];
  }
  if (!best) throw new Error(`no tree row reading ${label}`);
  return best[0];
}
async function clickStill(h: ElementHandle<Element>) {
  await h.frame.page().bringToFront();
  let last = "";
  for (let i = 0; i < 40; i++) { const box = JSON.stringify(await h.boundingBox()); if (box === last) break; last = box; await pause(120); }
  await h.click();
}
async function openApp(page: Page, query = "") {
  await page.bringToFront();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/app${query}`, { waitUntil: "load" });
  await page.waitForSelector(".ck-panels[data-ready]");
  await page.waitForSelector("pierce/[role=treeitem]", { timeout: 20_000 });
  await page.waitForSelector(".ck-tour-dismiss", { timeout: 4000 }).catch(() => null);
  if (await page.$(".ck-tour-dismiss")) await page.click(".ck-tour-dismiss");
  await settle(page);
}
const statusLine = (page: Page) => page.$eval(".ck-status", (el) => el.textContent?.trim() ?? "");

try {
await withHeadless(async (browser: { newPage(): Promise<Page> }) => {
  if (emptyBase) {
    if (!/^http:\/\/127\.0\.0\.1:479[5-9][0-9]$/.test(emptyBase)) throw new Error("empty daemon must use a scratch loopback port");
    const empty = await browser.newPage();
    watch(empty, "empty daemon");
    await empty.setViewport({ width: 1280, height: 800 });
    await empty.goto(`${emptyBase}/app`, { waitUntil: "load" });
    await empty.waitForSelector(".ap-empty");
    if (await empty.$(".ck-tour-dismiss")) await empty.click(".ck-tour-dismiss");
    await settle(empty);
    check(await empty.$("#ap-switch") === null, "empty daemon has no blank project selector");
    check(await empty.$eval(".ap-side-notice std-empty-state", (el) => el.shadowRoot?.textContent?.includes("No projects yet") ?? false), "empty daemon explains a project");
    check(await empty.$(".ap-new-project button") !== null, "empty daemon offers the New project stepper");
    check((await text(empty, ".ck-details")).includes("Connect"), "empty daemon has useful device guidance");
    await snap(empty, "empty-daemon");
    await empty.close();
  }
  // What the daemon holds, read from a document-authenticated browser (AX-9).
const bootstrap = await browser.newPage();
await bootstrap.goto(`${base}/`, { waitUntil: "load" });
const session = (await bootstrap.cookies(`${base}/api/v1/workspace`)).find((c) => c.path === "/api");
if (session) check(session.httpOnly && session.sameSite === "Strict", "AX-9: document mints an HttpOnly SameSite=Strict session at /api");
console.log(`browser auth: ${session ? "session cookie" : "pre-cookie daemon; AX-9 not yet implemented"}`);
const { ok, ws } = await bootstrap.evaluate(async () => {
  const response = await fetch("/api/v1/workspace", { credentials: "same-origin" });
  return { ok: response.ok, ws: await response.json() };
});
await bootstrap.close();
check(ok && ws.investigations.length === 1 && ws.proposals.length === 1 && ws.proposals[0].status === "proposed", "the daemon holds one investigation with one proposal awaiting approval");
const inv = ws.investigations[0], proposal = ws.proposals[0];
const invName: string = ws.records.find((r: { kind: string }) => r.kind === "investigation").payload.title || inv.id;
const proposalRow = async (page: Page): Promise<ElementHandle<Element>> => {
  const row = await page.$(`pierce/[role=treeitem][data-id="${inv.id}/prop/${proposal.proposal_id}"] > .line`);
  if (!row) throw new Error("proposal row is missing");
  return row;
};
const config = ws.config_versions.find((c: { version: string }) => c.version === inv.config_version).config;
const channel: string = config.simulator.outputs[0];


  // ---------- fixtures ----------
  const fx = await browser.newPage();
  watch(fx, "fixtures");
  await openApp(fx, "?source=fixtures");
  await until(fx, "demo tree", async () => Boolean(await fx.$("pierce/[role=treeitem]")));
  check(await fx.$(".ck-export") === null, "the shell header has no Export action");
  await clickStill(await treeRow(fx, "Sine 0.44"));
  await fx.waitForSelector("pierce/#ap-action-approve");
  await settle(fx);
  await snap(fx, "fixtures-proposal");
  await clickStill((await fx.$("pierce/#ap-action-approve"))!);
  await until(fx, "fixture approval", async () => (await text(fx, "#ap-status")).startsWith("Approved by james"));
  check(true, "fixtures: Approve reads Approved by james");
  await snap(fx, "fixtures-approved");
  await fx.close();

  // ---------- daemon: three tabs ----------
  const a = await browser.newPage(), c = await browser.newPage(), b = await browser.newPage();
  watch(a, "A (stream blocked)", [/\/api\/v1\/stream/, /status of 409/, /http 409: .*\/approvals$/]);
  watch(c, "C (watcher)");
  watch(b, "B (approver)");
  // Keep the connection healthy but withhold records in this stale browser.
  // A broken stream now correctly pauses approvals, so aborting it cannot
  // exercise the daemon's concurrent-decision 409 anymore.
  await a.evaluateOnNewDocument(() => {
    const native = EventSource.prototype.addEventListener;
    (EventSource.prototype as any).addEventListener = function(type: string, listener: any, options: any) {
      if (type !== "record") native.call(this, type, listener, options);
    };
  });

  await openApp(c);
  check(await c.$eval(".ck-status", el => getComputedStyle(el).display === "none"), "connected daemon has no Live footer");
  check(await c.$(`pierce/[role=treeitem][data-id="${inv.id}"]`) !== null, "the seeded investigation renders with its stable ID");
  await snap(c, "daemon-investigation");
  await clickStill(await proposalRow(c));
  await c.waitForSelector("pierce/#ap-action-approve");
  await settle(c);
  check(/^Awaiting approval/.test(await text(c, "#ap-status")), "C: the proposal awaits approval");
  await snap(c, "daemon-proposal");

  await openApp(a);
  await clickStill(await proposalRow(a));
  await a.waitForSelector("pierce/#ap-action-approve");

  await openApp(b);
  await clickStill(await proposalRow(b));
  await b.waitForSelector("pierce/#ap-action-approve");
  await settle(b);
  await clickStill((await b.$("pierce/#ap-action-approve"))!);
  await until(b, "B approval", async () => (await text(b, "#ap-status")).startsWith("Approved by james"));
  check(true, "B: Approve posts to the daemon and reads Approved by james");

  await until(c, "C sees the approval over SSE", async () => (await text(c, "#ap-status")).startsWith("Approved by james"));
  check(await c.$("pierce/#ap-action-approve") === null, "C: the approval arrived over SSE; Approve is gone");
  await settle(c);
  await snap(c, "daemon-approved-over-sse");

  check(/^Awaiting approval/.test(await text(a, "#ap-status")), "A (no stream) still shows the proposal as awaiting");
  await clickStill((await a.$("pierce/#ap-action-approve"))!);
  await until(a, "A shows the 409", async () => (await text(a, ".ap-text.ap-t-danger")).includes("409 conflict"));
  check((await text(a, ".ap-text.ap-t-danger")).startsWith("Not saved: 409 conflict: proposal is approved"), `A: the daemon's 409 shows as Not saved ("${await text(a, ".ap-text.ap-t-danger")}")`);
  await settle(a);
  await snap(a, "daemon-409-not-saved");
  await a.close();
  await b.close();

  // ---------- pairing (O-3) and data over SSE ----------
  const start = await (await fetch(`${base}/api/v1/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "e2e laptop", client: "daemon-flow.ts" }) })).json();
  await c.click(".ap-devices");
  await until(c, "the pairing appears", async () => (await c.$(`pierce/[id="ap-action-pair-approve:${start.user_code}"]`)) !== null, 15_000);
  await settle(c);
  await snap(c, "daemon-pairing-pending");
  await clickStill((await c.$(`pierce/[id="ap-action-pair-approve:${start.user_code}"]`))!);
  await until(c, "the pairing leaves the list", async () => (await c.$(`pierce/[id="ap-action-pair-approve:${start.user_code}"]`)) === null);
  const poll = await fetch(`${base}/api/v1/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: start.device_code }) });
  const issued = await poll.json();
  check(poll.ok && typeof issued.api_key === "string", "the device's poll returns a key once the UI approved it (the key is not printed)");
  await snap(c, "daemon-pairing-approved");

  const keyed = (path: string, body: unknown) => fetch(`${base}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.api_key}` }, body: JSON.stringify(body) });
  const t = Array.from({ length: 50 }, (_, i) => i * 0.2);
  const m = await keyed(`/investigations/${inv.id}/measurements`, { id: `e2e-m-${Date.now()}`, kind: "measurement", payload: { version: 3, digest: "e2e",
    observation: { experiment: proposal.experiment, settings: proposal.settings, t, y: { [channel]: t.map((x) => 0.1 * Math.sin(2.76 * x)) }, sigma: { [channel]: 0.01 }, split: "train", source: "daemon-flow.ts", meta: {} } } });
  const dres = await keyed(`/investigations/${inv.id}/proposals/${proposal.proposal_id}/data`, { id: `e2e-d-${Date.now()}`, kind: "proposal", payload: { proposal_id: proposal.proposal_id, event: "data_attached", measurement_version: 3 } });
  check(m.ok && dres.ok, `the key attaches data (${m.status}, ${dres.status})`);
  await clickStill(await proposalRow(c));
  await until(c, "C sees the data over SSE", async () => (await (await proposalRow(c)).evaluate((el) => el.textContent ?? "")).includes("data in"));
  check(true, "C: the proposal row reads data in once the measurement arrives over SSE");
  await settle(c);
  await snap(c, "daemon-data-in");
  await c.close();

  // ---------- AX-9: renew an expired session, then enforce the reload guard ----------
  if (session) {
    const recovery = await browser.newPage();
    watch(recovery, "reauth", [/status of 401/, /http 401:/, /\/api\/v1\/stream/, /net::ERR_ABORTED/]);
    await openApp(recovery);
    let navigations = 0;
    recovery.on("request", (request) => { if (request.resourceType() === "document" && request.frame() === recovery.mainFrame()) navigations++; });
    const renew = recovery.waitForNavigation({ waitUntil: "load", timeout: 15_000 });
    const cookie = (await recovery.cookies(`${base}/api/v1/workspace`)).find((c) => c.path === "/api")!;
    await recovery.deleteCookie(cookie);
    await renew; // The app's next pairing read gets 401 and invokes the injected host callback.
    await recovery.waitForSelector(".ck-panels[data-ready]");
    await until(recovery, "reauth remints the session", async () => await recovery.$('pierce/[role=treeitem][data-id^="project:"]') !== null && await recovery.$(".ap-rail-connection:not([hidden])") === null);
    const renewed = (await recovery.cookies(`${base}/api/v1/workspace`)).find((c) => c.path === "/api")!;
    check(!!renewed?.httpOnly && navigations === 1, `AX-9: an expired cookie reloads the document once and reconnects (documents=${navigations}, session=${!!renewed?.httpOnly})`);
    check(await recovery.evaluate(() => Number(sessionStorage.getItem("autophys.reauth-at")) > 0), "AX-9: the host persists the per-tab reload guard");
    if (await recovery.$(".ck-tour-dismiss")) await recovery.click(".ck-tour-dismiss");
    await settle(recovery);
    await recovery.deleteCookie(renewed);
    await until(recovery, "reload guard exposes session failure", async () => (await recovery.$eval(".ap-rail-connection", el => el.title)).includes("Browser session expired"), 15_000);
    check(navigations === 1, "AX-9: a second 401 inside 30 seconds shows an error instead of reloading again");
    await snap(recovery, "daemon-session-expired-guard");
    await recovery.close();
  }
}, await chromeForHost().then((executablePath) => executablePath ? { executablePath, args: ["--no-sandbox"] } : undefined));

} finally {
for (const e of errors) console.log(`FAIL ${e}`);
console.log(`${checks.length} checks, ${errors.length} unexpected console/page/network errors; screenshots: ${outDir} (${shot})`);
}
if (errors.length) Deno.exit(1);
