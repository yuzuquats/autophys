/// <reference lib="dom" />
/** One-page investigation acceptance on a private scratch daemon; no mutation of live data. */
import type { Page } from "npm:puppeteer-core@22.7.1";
const [base, out] = Deno.args;
if (!/^http:\/\/127\.0\.0\.1:479[67][0-9]$/.test(base) || !out) throw new Error("investigation-flow.ts <loopback:47960..47979> <evidence>");
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
await Deno.mkdir(out, { recursive: true });
const checks: string[] = [], errors: string[] = [], shots: string[] = [];
function check(ok: boolean, text: string) { if (!ok) throw new Error(text); checks.push(text); console.log("ok " + text); }
const settle = (p: Page) => p.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
async function pick(p: Page, id: string) {
  await p.evaluate(id => {
    const tree = document.querySelector("std-tree-list.ap-tree")?.shadowRoot;
    const row = tree?.querySelector<HTMLElement>('[data-id="' + CSS.escape(id) + '"] > .line');
    if (!row) throw new Error("Missing legacy sidebar row " + id);
    row.click();
  }, id);
  await settle(p);
}
async function dismissOpeningTour(p: Page) {
  await p.waitForSelector(".ck-panels[data-ready]");
  await p.waitForFunction(() => document.documentElement.dataset.ckStage === "tour" &&
    !!document.querySelector(".ck-tour-title")?.textContent);
  await p.click(".ck-tour-dismiss");
  await p.waitForFunction(() => document.documentElement.dataset.ckStage === "app");
  await p.waitForSelector(".ap-investigation-view");
  await settle(p);
}
async function open(p: Page, suffix = "") {
  await p.goto(base + "/app?source=fixtures" + suffix, { waitUntil: "load" });
  await dismissOpeningTour(p);
}
async function screenshot(p: Page, name: string) { await p.screenshot({path:out + "/" + name}); shots.push(name); }
await withHeadless(async browser => {
  const p = await browser.newPage();
  p.on("pageerror", e => errors.push(String(e)));
  p.on("console", m => { if(m.type() === "error") errors.push(m.text()); });
  await p.evaluateOnNewDocument(() => {
    sessionStorage.setItem("autophys.tour.seen.local.offered", "true");
    localStorage.setItem("autophys.tour.seen.local", "true");
  });
  for (const width of [1440, 1024]) {
    await p.setViewport({width, height:1000});
    await open(p);
    const waiting = await p.evaluate(() => {
      const view = document.querySelector(".ap-investigation-view")!;
      const cards = [...view.querySelectorAll(".ap-card-head h3")].map(e => e.textContent);
      return { cards, roundCount:view.querySelectorAll(".ap-round").length,
        dataCards:cards.filter(h => h === "Data").length, rows:view.querySelectorAll(".ap-measurement").length,
        expanded:view.querySelectorAll(".ap-measurement[open]").length,
        footer:!!document.querySelector("#ap-credit"), export:!!document.querySelector("#ap-action-export-investigation"),
        decision:document.querySelectorAll("#ap-action-approve,#ap-action-reject").length,
        provenance:document.querySelector(".ap-footnote")?.textContent,
        mainWidth:document.querySelector(".ck-main")!.clientWidth,
        wide:!!view.querySelector(".ap-fit-layout.ap-wide"),
        overflow:document.documentElement.scrollWidth > innerWidth };
    });
    check(waiting.roundCount === 1 && waiting.dataCards === 1 && waiting.rows === 1, width + ": one Data card, one inline measurement row");
    check(waiting.expanded === 0, width + ": measurement plot starts collapsed");
    check(!waiting.footer && !waiting.export && waiting.decision === 2 && !!waiting.provenance?.includes("config v2"), width + ": decision and provenance live in Details, without Export/footer");
    check(waiting.wide === (waiting.mainWidth >= 760), width + ": layout follows main-pane width");
    check(!waiting.overflow, width + ": no document overflow");
    await screenshot(p, "awaiting-" + width + ".png");
    await p.click(".ap-measurement > summary");
    check(await p.$eval(".ap-measurement", e => e.hasAttribute("open")), width + ": measurement row opens its own plot");
    await p.click(".ap-measurement > summary");
    const jump = await p.$("button[data-ap-jump$='proposal-p1']");
    await jump!.click();
    await settle(p);
    check(await p.evaluate(() => {
      const viewer = document.querySelector(".ap-viewer")!, card = viewer.querySelector<HTMLElement>('[id$="proposal-p1"]')!;
      return card.getBoundingClientRect().top < viewer.getBoundingClientRect().bottom && card.getBoundingClientRect().bottom > viewer.getBoundingClientRect().top
        && document.querySelector("[data-ap-jump][aria-current]")?.textContent === "Proposal";
    }), width + ": Proposal pill scrolls and highlights the matching card");
    await screenshot(p, "proposal-anchor-" + width + ".png");
    await pick(p, "bench-b");
    const validated = await p.evaluate(() => ({
      summary:document.querySelector(".ap-investigation-view > .ap-card")?.textContent,
      rounds:[...document.querySelectorAll(".ap-round")].map(e => [e.querySelector("summary b")?.textContent,e.hasAttribute("open")]),
      outcome:[...document.querySelectorAll(".ap-outcome .ap-card-head h3")].map(e => e.textContent),
      report:!!document.querySelector("#ap-action-report"),
      decision:!!document.querySelector("#ap-action-approve"),
      footer:!!document.querySelector("#ap-credit"),
    }));
    check(!!validated.summary?.includes("Validated") && validated.summary.includes("Held-out χ²/N") && validated.summary.includes("±"), width + ": verdict, held-out score and final uncertainties lead");
    check(JSON.stringify(validated.rounds) === JSON.stringify([["Round 2",true],["Round 1",false]]), width + ": newest round expanded, older round collapsed");
    check(JSON.stringify(validated.outcome) === JSON.stringify(["Validate","Ground truth"]), width + ": validation and ground truth lead the rounds");
    check(validated.report && !validated.decision && !validated.footer, width + ": result Details keeps Report and no footer");
    await screenshot(p, "validated-" + width + ".png");
    await pick(p, "bench-b/fit-1/residuals");
    check(await p.$eval('[id="ap-bench-b-round-1"]', e => e.hasAttribute("open")), width + ": older residual target expands Round 1");
    check(await p.evaluate(() => {
      const viewer = document.querySelector(".ap-viewer")!, fit = document.getElementById("ap-bench-b-round-1-fit")!;
      return Math.abs(fit.getBoundingClientRect().top - viewer.getBoundingClientRect().top) < 30;
    }), width + ": residuals anchor lands on Fit");
    await pick(p, "bench-b/data/free_response@1");
    check(await p.$eval('[id="ap-bench-b-round-1-measurement-free_response%401"]', e => e.hasAttribute("open")), width + ": legacy measurement expands its row in the older round");
    await p.reload({waitUntil:"load"}); await dismissOpeningTour(p);
    check(await p.$eval('[id="ap-bench-b-round-1-measurement-free_response%401"]', e => e.hasAttribute("open")), width + ": bookmarked measurement URL survives reload");
    await open(p, "#bench-b%2Ffit-1%2Flandscape");
    check(await p.$eval('[id="ap-bench-b-round-1"]', e => e.hasAttribute("open")), width + ": direct legacy hash opens its older round");
    await open(p, "&selection=bench-b%2Ftruth");
    check(await p.$eval(".ap-crumb b", e => e.textContent === "bench B"), width + ": direct query URL opens the same investigation");
  }
  await p.close();
}, { executablePath: Deno.env.get("AUTOPHYS_CHROME"), args:["--no-sandbox"] });
check(errors.length === 0, "no browser console or page errors: " + errors.join("; "));
await Deno.writeTextFile(out + "/investigation-receipt.json", JSON.stringify({checks,shots,errors}, null, 2));
console.log(checks.length + " checks; " + shots.length + " captures");
