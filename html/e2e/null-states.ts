/** Exercise null states against isolated empty + SDK-seeded daemons.
 * Network fault/delay and project-only responses are deliberate browser test inputs.
 * usage: deno run -A html/e2e/null-states.ts <seeded-base> <empty-base> <shots>
 */
import type { Page, HTTPRequest } from "npm:puppeteer-core@22.7.1";
const [base, emptyBase, out] = Deno.args;
for (const url of [base, emptyBase]) if (!/^http:\/\/127\.0\.0\.1:479[5-9][0-9]$/.test(url ?? "")) throw new Error("isolated loopback daemons required");
if (!out) throw new Error("screenshot directory required");
await Deno.mkdir(out, { recursive: true });
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [], checks: string[] = [], shots: string[] = [];
const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); checks.push(label); console.log(`ok ${label}`); };
const text = async (page: Page, selector: string) => (await page.$eval(selector, (el) => el.textContent ?? "").catch(() => ""));
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).every((a) => a.playState !== "running"), { timeout: 8000 });
  await pause(200);
}
async function shot(page: Page, name: string) {
  await settle(page);
  const file = `${name}.png`;
  await page.screenshot({ path: `${out}/${file}` }); shots.push(file);
}
async function row(page: Page, label: string) {
  const rows = await page.$$("pierce/[role=treeitem]");
  for (const el of rows) if ((await el.evaluate((e) => e.textContent ?? "")).includes(label)) {
    const line = await el.$(".line"); if (line) { await line.click(); return; }
  }
  throw new Error(`missing tree row ${label}`);
}
await withHeadless(async (browser) => {
  const boot = await browser.newPage();
  await boot.goto(`${base}/`, { waitUntil: "load" });
  const workspace = await boot.evaluate(async () => (await fetch("/api/v1/workspace")).json());
  await boot.close();
  const modes = ["empty", "project-empty", "project-unconfigured", "devices-none", "pairings-pending", "switcher", "single-project", "loading", "unreachable", "reauth-failed", "missing-fit", "missing-residuals", "missing-landscape", "missing-sensitivity", "missing-outlook", "demo"];
  for (const width of [1280, 390]) for (const mode of modes) {
    const page = await browser.newPage();
    const size = `${width}x${width === 390 ? 844 : 800}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 800, deviceScaleFactor: 1, isMobile: width === 390, hasTouch: width === 390 });
    page.on("pageerror", (err) => errors.push(`${mode}/${size}: ${err}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !(["unreachable", "reauth-failed"].includes(mode) && /status of (401|503)/.test(m.text()))) errors.push(`${mode}/${size}: ${m.text()}`);
    });
    const held: HTTPRequest[] = [];
    let recovered = false;
    let pairCode: string | undefined;
    try {
      if (mode === "reauth-failed") await page.evaluateOnNewDocument(() => sessionStorage.setItem("autophys.reauth-at", String(Date.now())));
      if (["project-empty", "project-unconfigured", "missing-outlook", "loading", "unreachable", "reauth-failed"].includes(mode)) {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          if (recovered || new URL(req.url()).pathname !== "/api/v1/workspace") { void req.continue(); return; }
          if (mode === "loading") { held.push(req); return; }
          const withoutOutlook = structuredClone(workspace);
          for (const record of withoutOutlook.records) if (record.kind === "proposal") delete record.payload.outlook;
          const response = ["project-empty", "project-unconfigured"].includes(mode) ? { ...workspace, config_versions: mode === "project-unconfigured" ? [] : workspace.config_versions, investigations: [], proposals: [], records: [] }
            : mode === "missing-outlook" ? withoutOutlook : { error: mode === "reauth-failed" ? "session_expired" : "unreachable", message: "The test daemon refused this connection." };
          void req.respond({ status: ["project-empty", "project-unconfigured", "missing-outlook"].includes(mode) ? 200 : mode === "reauth-failed" ? 401 : 503, contentType: "application/json", body: JSON.stringify(response) });
        });
      }
      const target = ["empty", "devices-none", "pairings-pending"].includes(mode) ? emptyBase : base;
      await page.goto(`${target}/app${["demo", "switcher"].includes(mode) ? "?source=fixtures" : ""}`, { waitUntil: "load" });
      await page.waitForSelector(".ck-panels[data-ready]");
      await page.waitForSelector(".ck-tour-dismiss", { timeout: 3000 }).catch(() => null);
      if (await page.$(".ck-tour-dismiss")) await page.click(".ck-tour-dismiss");
      if (["empty", "devices-none", "pairings-pending", "project-empty", "project-unconfigured"].includes(mode)) await page.waitForSelector(".ap-onboarding");
      else if (mode === "loading") await page.waitForSelector(".ap-state[aria-busy=true]");
      else if (["unreachable", "reauth-failed"].includes(mode)) await page.waitForSelector(".ap-connection");
      else await page.waitForSelector("pierce/[role=treeitem]");
      await settle(page);
      if (mode === "empty") {
        check(await page.$("#ap-switch") === null, `empty/${size}: no empty switcher`);
        check((await text(page, ".ap-code")).includes("ap.connect"), `empty/${size}: SDK instructions`);
        if (width === 1280) {
          await page.click('[data-ap-button="copy-sdk"] std-button');
          await page.waitForFunction(() => document.querySelector('[data-ap-button="copy-sdk"]')?.textContent?.includes("Copied"));
          check(true, "copy SDK recipe acknowledges success");
        }
      }
      if (["project-empty", "project-unconfigured"].includes(mode)) check((await text(page, ".ap-onboarding h2")) === "No investigations yet", `project-empty/${size}: actionable onboarding`);
      if (mode === "single-project") check(await page.$("std-select-input") === null && await page.$(".ap-project-label") !== null, `single-project/${size}: label replaces select`);
      if (mode === "switcher") {
        const select = await page.$("pierce/select[name=project]");
        check(!!select, `switcher/${size}: lona-js select`);
        await select!.select("1"); await settle(page);
        check((await text(page, ".ap-crumb")).includes("cell A"), `switcher/${size}: switches to second project`);
      }
      if (mode.startsWith("missing-")) {
        const labels: Record<string, string> = { "missing-fit": "Fit #1", "missing-residuals": "Residuals", "missing-landscape": "Landscape", "missing-sensitivity": "Sensitivity", "missing-outlook": "Sine" };
        if (width === 390) { await page.click(".ck-sidebar-toggle"); await settle(page); }
        if (mode === "missing-outlook") {
          const id = `${workspace.investigations[0].id}/prop/${workspace.proposals[0].proposal_id}`;
          await page.click(`pierce/[role=treeitem][data-id="${id}"] > .line`);
        } else await row(page, labels[mode]);
        await settle(page);
        check(await page.$("std-empty-state") !== null, `${mode}/${size}: shared Not recorded yet component`);
        if (mode === "missing-outlook") {
          check(await page.$(".ap-fields input") === null, `outlook/${size}: no editable inputs without a grid`);
          if (width === 390) { await page.click(".ck-details-toggle"); await settle(page); }
          check(await page.$eval(".ck-details .ap-gap std-empty-state", (el) => el.shadowRoot?.textContent?.includes("read-only") ?? false), `outlook/${size}: read-only explanation`);
        }
      }
      if (mode === "pairings-pending") {
        const response = await fetch(`${emptyBase}/api/v1/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "Calibration laptop", client: "null-state check" }) });
        pairCode = (await response.json()).user_code;
        await page.waitForSelector(`pierce/[id="ap-action-pair-approve:${pairCode}"]`, { timeout: 15000 });
        check(true, `pairings/${size}: pending request has approve + deny`);
        check(await page.$(`pierce/[id="ap-action-pair-deny:${pairCode}"]`) !== null, `pairings/${size}: deny action`);
      }
      if (["devices-none", "pairings-pending"].includes(mode) && width === 390) { await page.click(".ck-details-toggle"); await settle(page); }
      await shot(page, `${mode}-${size}`);
      if (["empty", "project-empty", "project-unconfigured", "loading", "switcher", "single-project", "pairings-pending"].includes(mode) && width === 390) {
        await page.keyboard.press("Escape"); await settle(page);
        await page.click(".ck-sidebar-toggle"); await shot(page, `${mode}-${size}-sidebar`);
      }
      if (pairCode) {
        await page.evaluate(async (code) => { await fetch(`/api/v1/pairings/${code}/deny`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }, pairCode);
      }
      if (mode === "reauth-failed") check((await text(page, ".ap-connection")).includes("session"), `reauth/${size}: guarded refusal stays visible`);
      if (["unreachable", "reauth-failed"].includes(mode)) {
        recovered = true;
        await page.click('[data-ap-button="retry"] std-button');
        await page.waitForSelector(".ap-project-label");
        check(await page.$(".ap-connection") === null, `retry/${mode}/${size}: reconnects to live data`);
      }
    } finally {
      for (const req of held) await req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) }).catch(() => {});
      if (held.length) await page.waitForSelector(".ap-project-label", { timeout: 5000 });
      await page.close();
    }
  }
}, { executablePath: Deno.env.get("AUTOPHYS_CHROME") ?? `${Deno.env.get("HOME")}/.cache/ms-playwright/chromium-1112/chrome-linux/chrome`, args: ["--no-sandbox"] });
await Deno.writeTextFile(`${out}/manifest.json`, JSON.stringify({ checks, errors, shots }, null, 2));
console.log(`${checks.length} checks, ${errors.length} errors, ${shots.length} screenshots`);
if (errors.length) throw new Error(errors.join("\n"));
