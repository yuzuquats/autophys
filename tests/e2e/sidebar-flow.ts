/// <reference lib="dom" />
/** Sidebar and New project (UI-27) acceptance against scratch loopback daemons only.
 * New project is walked end to end: the stepper's commands, a real `autophys connect` device
 * approved (and, on the phone run, first denied) inside the stepper, then the repository's
 * Python SDK seed run with that device's saved key, whose investigation the stepper opens.
 *
 *   deno run -A tests/e2e/sidebar-flow.ts <scratch-origin> <second-scratch-origin> <screenshots> <autophys-binary>
 *
 * AUTOPHYS_PYTHON (default python3) needs NumPy and SciPy; AUTOPHYS_CHROME picks Chromium.
 */
import type { Page, Browser } from "npm:puppeteer-core@22.7.1";
const [base, emptyBase, out, autophys] = Deno.args;
for (const origin of [base, emptyBase]) if (!/^http:\/\/127\.0\.0\.1:479[5-9][0-9]$/.test(origin)) throw new Error("scratch daemons on ports 47950..47999 required");
if (!out || !autophys) throw new Error("sidebar-flow.ts <scratch-origin> <second-scratch-origin> <screenshots> <autophys-binary>");
const repo = new URL("../../", import.meta.url).pathname;
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
await Deno.mkdir(out, { recursive: true });
const checks: string[] = [], shots: string[] = [], errors: string[] = [];
const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); checks.push(label); console.log("ok " + label); };
const settle = async (page: Page) => { await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running")); };
async function screenshot(page: Page, label: string, width: number, height: number) {
  await settle(page); const name = label + "-" + width + "x" + height + ".png";
  await page.screenshot({ path: out + "/" + name }); shots.push(name);
}
async function expectFocus(page: Page, id: string, label: string) {
  await page.waitForFunction(id => document.activeElement?.id === id, {}, id);
  check(await page.evaluate(id => {
    const el = document.activeElement;
    return el?.id === id && (el instanceof HTMLInputElement || el.shadowRoot?.activeElement?.tagName === "BUTTON");
  }, id), label);
}
async function orientation(page: Page, width: number) {
  await settle(page);
  check(await page.$eval(".ap-project-setup", el => {
    const viewport = el.getBoundingClientRect(), heading = el.querySelector("h2")!.getBoundingClientRect();
    const current = el.querySelector("std-stepper")!.shadowRoot!.querySelector("[aria-current=step]")!;
    const previous = current.previousElementSibling?.querySelector(".step-head")?.getBoundingClientRect();
    const head = current.querySelector(".step-head")!.getBoundingClientRect();
    return heading.top >= viewport.top && heading.bottom <= viewport.bottom && !!previous && previous.top >= viewport.top && previous.bottom <= head.top && head.bottom <= viewport.bottom;
  }), width + ": wizard heading and completed step remain visible above current header");
}
async function panel(page: Page, name: "sidebar" | "details") {
  if (await page.evaluate(() => matchMedia("(max-width:639px)").matches)) {
    if (await page.$eval(".ck-panels", (el, n) => (el as HTMLElement).dataset.mobile !== n, name)) await page.click(".ck-" + name + "-toggle");
    await settle(page);
  } else if (name === "details" && !await page.$eval(".ck-panels", el => el.hasAttribute("data-details"))) {
    await page.click(".ck-details-toggle"); await settle(page);
  }
}
async function command(page: Page) {
  return await page.$eval(".ap-setup-command", el => el.textContent ?? "");
}
async function currentStep(page: Page) {
  return await page.$eval("std-stepper", el => [...el.shadowRoot!.querySelectorAll(".step-item")].findIndex(item => item.getAttribute("aria-current") === "step") + 1);
}
async function pendingCard(page: Page, code: string, width: number) {
  await page.waitForSelector('.ap-project-setup [id="ap-action-pair-approve:' + code + '"]', { timeout: 15000 });
  check(await page.$eval(".ap-project-setup .ap-pair-code", el => el.textContent) === code && await page.$(".ap-setup-waiting") === null,
    width + ": the device's card in the stepper shows the code its terminal printed");
}
const children = new Set<Deno.ChildProcess>();
/** A real device: `autophys connect` with its own config directory; resolves its code once printed. */
async function connect(origin: string, name: string, configDir: string) {
  const child = new Deno.Command(autophys, { args: ["connect", origin, "--name", name, "--json"], env: { AUTOPHYS_CONFIG_DIR: configDir },
    stdin: "null", stdout: "piped", stderr: "piped" }).spawn();
  children.add(child);
  const stdout = new Response(child.stdout).text();
  const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let progress = "", code: string | undefined;
  while (!code) {
    const { value, done } = await reader.read();
    if (done) throw new Error("autophys connect exited before printing a code: " + progress);
    progress += value; code = /enter code: (\S+)/.exec(progress)?.[1];
  }
  void (async () => { while (!(await reader.read()).done) { /* drain */ } })();
  const done = Promise.all([child.status, stdout]).then(([status, text]) => { children.delete(child); return { code: status.code, stdout: text }; });
  return { code, done };
}
await withHeadless(async (browser: Browser) => {
  for (const [width, height, origin, decision] of [[1280,800,base,"approve"], [390,844,emptyBase,"reject"]] as const) {
    const page = await browser.newPage(); await page.setViewport({width,height});
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(origin + "/app", {waitUntil:"load"});
    await page.waitForSelector(".ck-panels[data-ready]");
    // The walkthrough may still be entering; dismiss it through its own control.
    await page.waitForSelector(".ck-tour-dismiss", { timeout: 4000 }).catch(() => null);
    await page.$eval(".ck-tour-dismiss", el => (el as HTMLElement).click()).catch(() => {});
    await settle(page);
    await panel(page,"sidebar");
    check(await page.$(".ck-header .ck-export") === null, width + ": no header Export");
    check(await page.$eval(".ck-status", el => getComputedStyle(el).display === "none"), width + ": no Live footer");
    check(await page.$eval(".ap-devices", el => el.getBoundingClientRect().top >= document.querySelector(".ap-new-project")!.getBoundingClientRect().bottom - 1), width + ": Devices directly below New project");
    // Create one pending device request solely to exercise the pinned red badge.
    const expectedCount = await page.$eval(".ap-devices", el => Number(el.querySelector(".ap-badge")?.textContent ?? 0) + 1);
    const pairing = await page.evaluate(async () => (await fetch("/api/v1/pair/start", {
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({device_name:"Browser acceptance device",client:"sidebar-flow"})
    })).json());
    await page.waitForFunction(n => Number(document.querySelector(".ap-devices .ap-badge")?.textContent) === n, {timeout:15000}, expectedCount);
    check(await page.$eval(".ap-devices", (el, expected) => {
      const badge = el.querySelector(".ap-badge") as HTMLElement;
      const rgb = getComputedStyle(badge).backgroundColor.match(/\d+/g)!.map(Number);
      return Number(badge.textContent) === expected && rgb[0] > rgb[1] * 1.5 && !!badge.getAttribute("aria-label");
    }, expectedCount), width + ": pending pairing has red accessible count");
    await screenshot(page,"devices-pending",width,height);
    await page.evaluate(async code => { await fetch(`/api/v1/pairings/${code}/deny`, { method:"POST",headers:{"content-type":"application/json"},body:"{}" }); }, pairing.user_code);
    await page.click(".ap-new-project button"); await page.waitForSelector("std-stepper");
    check(await page.$eval("std-stepper", el => !!el.shadowRoot?.querySelector("[aria-current=step]")), width + ": stepper announces current step");
    check(await page.$eval(".ck-details", el => getComputedStyle(el).display === "none" && (el as HTMLElement).inert), width + ": New project hides Details and its focus targets");
    check(await page.$eval(".ap-project-setup", el => el.querySelector("h2")!.textContent === "New project" && el.querySelector(".ap-intro")!.textContent ===
      "Bring your own simulator. It runs on your machine through the SDK, and this workbench shows and approves its investigations."), width + ": heading and intro");
    check(await page.$(".ap-project-setup input") === null && !(await page.$eval(".ap-project-setup", el => el.textContent!)).match(/thermal/i), width + ": no Thermal wizard fields or copy");
    await expectFocus(page, "ap-action-setup-next", width + ": opening focuses I've done this");
    check(await command(page) === "autophys new my-project --lang python\ncd my-project", width + ": Python create command");
    await screenshot(page, "new-project-1-create", width, height);
    // Keyboard: the pressed option keeps focus while its command block is replaced.
    await page.focus('[id="ap-action-setup-lang:rust"]'); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".ap-setup-command")?.textContent?.includes("--lang rust"));
    const toggled = await page.evaluate(() => [document.activeElement?.id, document.querySelector('[id="ap-action-setup-lang:rust"]')?.getAttribute("aria-pressed")].join(" "));
    check(toggled === "ap-action-setup-lang:rust true", width + ": Rust toggle keeps focus and reads pressed (" + toggled + ")");
    await screenshot(page, "new-project-1-create-rust", width, height);
    await page.click('[id="ap-action-setup-lang:python"]');
    await page.waitForFunction(() => document.querySelector(".ap-setup-command")?.textContent?.includes("--lang python"));
    await page.click("#ap-action-setup-next");
    await page.waitForFunction(() => document.querySelector(".ap-setup-waiting")?.textContent === "Waiting for a device…");
    await expectFocus(page, "ap-setup-copy-2", width + ": I've done this focuses the connect command's Copy");
    await orientation(page, width);
    check(await command(page) === "autophys connect " + origin + " --name my-device", width + ": connect names this page's own origin");
    await screenshot(page, "new-project-2-waiting", width, height);
    const configDir = await Deno.makeTempDir({ prefix: "autophys-ui27-device-" });
    try {
      if (decision === "reject") {
        const denied = await connect(origin, "Denied phone device", configDir);
        await pendingCard(page, denied.code, width);
        await page.click('[id="ap-action-pair-deny:' + denied.code + '"]');
        const result = await denied.done;
        check(result.code !== 0, width + ": a denied device's autophys connect fails (exit " + result.code + ")");
        await page.waitForFunction(() => document.querySelector(".ap-setup-waiting")?.textContent === "Waiting for a device…");
        check(await page.$(".ap-project-setup .ap-pairing") === null && await currentStep(page) === 2, width + ": denial returns the stepper to waiting");
      }
      const device = await connect(origin, "UI-27 device " + width, configDir);
      await pendingCard(page, device.code, width);
      await screenshot(page, "new-project-2-pending", width, height);
      await page.click('[id="ap-action-pair-approve:' + device.code + '"]');
      await page.waitForFunction(() => document.querySelector(".ap-setup-waiting")?.textContent?.includes("first investigation"), { timeout: 15000 });
      check(await currentStep(page) === 3, width + ": approving the device in place advances to Run your first investigation");
      const connected = await device.done;
      check(connected.code === 0 && JSON.parse(connected.stdout).credentials === configDir + "/credentials", width + ": autophys connect saved the approved device's key");
      await page.waitForFunction(() => document.activeElement?.id === "ap-setup-step-3");
      check(true, width + ": the step-3 body takes focus");
      await screenshot(page, "new-project-3-waiting", width, height);
      const python = Deno.env.get("AUTOPHYS_PYTHON") ?? "python3";
      const run = await new Deno.Command(python, { args: ["-I", repo + "tests/e2e/seed.py", origin, "--connected", repo + "sdks/python/src"], cwd: repo,
        env: { AUTOPHYS_CONFIG_DIR: configDir }, stdout: "piped", stderr: "piped" }).output();
      const seeded = new TextDecoder().decode(run.stdout);
      if (!run.success) throw new Error("seed failed: " + new TextDecoder().decode(run.stderr).slice(-2000));
      const inv = JSON.parse(seeded.trim().split("\n").at(-1)!).investigation as string;
      await page.waitForFunction(() => !document.querySelector("std-stepper"), { timeout: 30000 });
      await page.waitForSelector(".ap-investigation-view");
      const opened = await page.$eval(".ap-investigation-view", el => el.getAttribute("data-ap-page") ?? "");
      check(opened.includes(inv), width + ": the first investigation opens when it appears (" + opened + ")");
      check(await page.$eval(".ap-new-project button", el => el.getAttribute("aria-pressed") === "false"), width + ": New project is no longer pressed");
      await screenshot(page, "new-project-opened-investigation", width, height);
    } finally { await Deno.remove(configDir, { recursive: true }).catch(() => {}); }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ": no document overflow");
    await page.close();
  }
}, {executablePath:Deno.env.get("AUTOPHYS_CHROME") ?? Deno.env.get("HOME") + "/.cache/ms-playwright/chromium-1112/chrome-linux/chrome",args:["--no-sandbox"]}).finally(() => { for (const child of children) { try { child.kill(); } catch { /* exited */ } } });
check(errors.length === 0, "no browser errors: " + errors.join("; "));
await Deno.writeTextFile(out + "/receipt.json", JSON.stringify({checks,shots,origins:[base,emptyBase]},null,2));
console.log(checks.length + " checks; " + shots.length + " screenshots; " + out);
