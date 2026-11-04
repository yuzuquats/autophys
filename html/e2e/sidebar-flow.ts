/// <reference lib="dom" />
/** Full browser-only project/run acceptance. Only scratch loopback daemons.
 * All project/config/run/approval writes are made by actual app controls.
 */
import type { Page, Browser } from "npm:puppeteer-core@22.7.1";
const [base, emptyBase, out] = Deno.args;
for (const origin of [base, emptyBase]) if (!/^http:\/\/127\.0\.0\.1:479[5-9][0-9]$/.test(origin)) throw new Error("scratch daemons on ports 47950..47999 required");
if (!out) throw new Error("sidebar-flow.ts <scratch-origin> <second-scratch-origin> <screenshots>");
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
async function fill(page: Page, name: string, value: string) {
  const selector = '[data-ap-name="setup:' + name + '"]';
  await page.waitForSelector(selector);
  await settle(page);
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
  await page.keyboard.press("Tab");
  const actual = await page.$eval(selector, el => (el as HTMLInputElement).value);
  check(actual === value, "typed " + name + ": expected " + value + ", got " + actual);
}
await withHeadless(async (browser: Browser) => {
  for (const [width, height, origin, decision] of [[1280,800,base,"approve"], [390,844,emptyBase,"reject"]] as const) {
    const page = await browser.newPage(); await page.setViewport({width,height});
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(origin + "/app", {waitUntil:"load"});
    await page.waitForSelector(".ck-panels[data-ready]");
    if (await page.$(".ck-tour-dismiss")) await page.click(".ck-tour-dismiss");
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
    const name = "Browser thermal " + width + " " + Date.now();
    await fill(page,"name",name);
    await screenshot(page,"new-project-model",width,height);
    await page.click("#ap-action-setup-next"); await page.waitForSelector('[data-ap-name="setup:c"]');
    await expectFocus(page, "ap-setup:c", width + ": Continue focuses first parameter, not Back");
    await orientation(page, width);
    check(await page.$$eval(".ap-setup-label", labels => labels.length === 4 && labels.every(label => {
      const range = document.createRange(); range.selectNodeContents(label.firstChild!);
      const text = range.getBoundingClientRect(), unit = label.querySelector(".ap-setup-unit")!;
      return Math.abs(text.top - unit.getBoundingClientRect().top) < 1 && getComputedStyle(unit).color !== getComputedStyle(label).color;
    })), width + ": all units sit beside labels in secondary colour");
    check(await page.$eval("std-stepper", el => getComputedStyle(el.shadowRoot!.querySelector("[aria-current=step] .step-head")!).backgroundColor === "rgba(0, 0, 0, 0.05)"), width + ": current header has translucent five-percent band");
    check(await page.$eval("std-stepper", el => {
      const done = el.shadowRoot!.querySelector(".step-item")!;
      return done.querySelector(".step-marker")!.textContent === "✓" && !done.classList.contains("muted") && !done.querySelector(".step-meta") && getComputedStyle(done, "::before").backgroundColor !== "rgba(0, 0, 0, 0)";
    }), width + ": completed step keeps plain checkmark, normal title and visible rail");
    await screenshot(page,"new-project-advanced",width,height);
    await page.click("#ap-action-setup-back");
    await expectFocus(page, "ap-setup:name", width + ": Back focuses project name");
    await page.$eval("#ap-action-setup-next", el => (el.shadowRoot!.querySelector("button") as HTMLButtonElement).focus());
    await page.keyboard.press("Enter");
    await expectFocus(page, "ap-setup:c", width + ": keyboard Continue focuses first field");
    check(await page.$eval('[id="ap-setup:c"]', el => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), width + ": keyboard field focus stays visible");
    await fill(page,"c","450"); await fill(page,"r","1.8"); await fill(page,"power","12"); await fill(page,"duration","800");
    await screenshot(page,"new-project-config",width,height);
    await page.click("#ap-action-setup-create"); await page.waitForSelector("#ap-action-setup-start:not([disabled])");
    await expectFocus(page, "ap-action-setup-start", width + ": Create project focuses Start investigation");
    await orientation(page, width);
    await screenshot(page,"new-project-ready",width,height);
    const saved = await page.evaluate(async (name) => {
      const ws = await (await fetch("/api/v1/workspace")).json();
      const project = ws.projects.find((p: {name:string}) => p.name === name);
      const config = ws.config_versions.find((c: {project_id:string}) => c.project_id === project.id);
      return {project,config};
    },name);
    check(saved.config.config.params.C.initial === 450 && saved.config.config.catalog.step.settings.power === 12, width + ": UI fields persisted as immutable configuration");
    await page.click("#ap-action-setup-start"); await page.waitForFunction(() => !document.querySelector("std-stepper"));
    await page.waitForFunction(async (pid) => {
      const ws = await (await fetch("/api/v1/workspace")).json();
      const inv = ws.investigations.find((i: {project_id:string}) => i.project_id === pid);
      return inv && ws.proposals.some((p: {investigation:string,status:string}) => p.investigation === inv.id && p.status === "proposed");
    },{timeout:60000},saved.project.id);
    const state = await page.evaluate(async (pid) => {
      const ws = await (await fetch("/api/v1/workspace")).json();
      const inv = ws.investigations.find((i: {project_id:string}) => i.project_id === pid);
      return { inv, proposal: ws.proposals.find((p: {investigation:string,status:string}) => p.investigation === inv.id && p.status === "proposed") };
    },saved.project.id);
    check(!!state.proposal, width + ": daemon actually ran fitting and proposed an experiment without SDK");
    await panel(page,"sidebar");
    const selector = 'pierce/[role=treeitem][data-id="' + state.inv.id + '/proposal:' + state.proposal.proposal_id + '"] > .line';
    // Use the UI's own generated node id, never synthesize a second id scheme.
    const proposalId = await page.$eval("std-tree-list.ap-tree", (el, pid) => {
      return [...el.shadowRoot!.querySelectorAll<HTMLElement>("[role=treeitem]")].find(n => n.dataset.id?.includes(pid))?.dataset.id;
    },state.proposal.proposal_id);
    if (!proposalId) throw new Error("proposal row missing");
    await page.click('pierce/[role=treeitem][data-id="' + proposalId + '"] > .line');
    await panel(page,"details");
    await page.waitForSelector("#ap-action-" + decision);
    await screenshot(page,"investigation-awaiting-approval",width,height);
    await page.click("#ap-action-" + decision);
    await page.waitForFunction(async (id) => {
      const ws = await (await fetch("/api/v1/workspace")).json();
      const outcomes = ws.records.filter((r: {investigation:string,kind:string}) => r.investigation === id && r.kind === "outcome");
      return outcomes.length && ["validated","inconclusive"].includes(outcomes.at(-1).payload.status);
    },{timeout:60000},state.inv.id);
    const completed = await page.evaluate(async (id) => {
      const ws = await (await fetch("/api/v1/workspace")).json();
      return { records: ws.records.filter((r: {investigation:string}) => r.investigation === id),
        proposal: ws.proposals.find((p: {investigation:string}) => p.investigation === id) };
    },state.inv.id);
    const kinds = completed.records.map((r: {kind:string}) => r.kind);
    check(kinds.includes("run") && kinds.includes("step") && kinds.includes("outcome"), width + ": durable fit, policy steps and outcome");
    check(completed.proposal.status === (decision === "approve" ? "data_attached" : "rejected"), width + ": " + decision + " resumed daemon loop");
    check(kinds.filter((k:string) => k === "measurement").length === (decision === "approve" ? 3 : 2), width + ": measurement attachment follows decision");
    await screenshot(page,"investigation-completed",width,height);
    // Verify persisted project is usable after a browser reload.
    await page.reload({waitUntil:"load"}); await page.waitForSelector(".ck-panels[data-ready]");
    if (await page.$(".ck-tour-dismiss")) await page.click(".ck-tour-dismiss");
    await panel(page,"sidebar");
    check(await page.$('pierce/[role=treeitem][data-id="project:' + saved.project.id + '"]') !== null, width + ": project survives reload");
    await screenshot(page,"workspace-completed",width,height);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ": no document overflow");
    await page.close();
  }
}, {executablePath:Deno.env.get("AUTOPHYS_CHROME") ?? Deno.env.get("HOME") + "/.cache/ms-playwright/chromium-1112/chrome-linux/chrome",args:["--no-sandbox"]});
check(errors.length === 0, "no browser errors: " + errors.join("; "));
await Deno.writeTextFile(out + "/receipt.json", JSON.stringify({checks,shots,origins:[base,emptyBase]},null,2));
console.log(checks.length + " checks; " + shots.length + " screenshots; " + out);
