/// <reference lib="dom" />
/** Guided-tour acceptance against a scratch daemon. Browser lifetime belongs to withHeadless. */
import type { Page } from "npm:puppeteer-core@22.7.1";
const [base, out] = Deno.args;
if (!/^http:\/\/127\.0\.0\.1:479[89][0-9]$/.test(base) || !out) throw new Error("tutorial-flow.ts <loopback:47980..47999> <evidence>");
const { withHeadless } = await import(new URL("../../vendor/tento/tento-headless-js/mod.ts", import.meta.url).href);
await Deno.mkdir(out,{recursive:true});
const checks: string[] = [], shots: string[] = [], errors: string[] = [];
function check(ok: boolean, text: string) { if (!ok) throw new Error(text); checks.push(text); console.log("ok " + text); }
const settle = async (p: Page) => { await p.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running")); };
async function ready(p: Page, step: number, substep = 0) {
  await p.waitForFunction((n,s) => { const e = document.querySelector<HTMLElement>(".ap-guided-tour"); return !e?.hidden && e?.dataset.step === String(n) && e.dataset.substep === String(s) && e.dataset.ready === "true"; },{},step,substep);
  await settle(p);
}
async function snapshot(p: Page) {
  return await p.evaluate(() => {
    const tree = document.querySelector("std-tree-list.ap-tree")?.shadowRoot;
    const scroll: [string,number,number][] = [];
    const walk = (root: Element | ShadowRoot, path: string) => {
      if (root instanceof HTMLElement && (root.scrollTop || root.scrollLeft)) scroll.push([path,root.scrollTop,root.scrollLeft]);
      if (root instanceof Element && root.shadowRoot) walk(root.shadowRoot,path+"#");
      [...root.children].forEach((e,i)=>walk(e,path+"/"+i));
    };
    walk(document.querySelector(".ck-panels")!,"panels");
    const panels = document.querySelector<HTMLElement>(".ck-panels")!;
    return { selected:[...tree?.querySelectorAll('[aria-selected="true"]') ?? []].map(e => (e as HTMLElement).dataset.id),
      expanded:[...tree?.querySelectorAll('[aria-expanded="true"]') ?? []].map(e => (e as HTMLElement).dataset.id),
      sidebar:panels.hasAttribute("data-sidebar"),details:panels.hasAttribute("data-details"),mobile:panels.dataset.mobile,
      text:document.querySelector(".ck-main")?.textContent,detailText:document.querySelector(".ck-details-slot")?.textContent,scroll };
  });
}
async function start(p: Page) { await p.click(".ap-tour-menu summary"); await p.click(".ap-tour-menu button"); await ready(p,1); }
await withHeadless(async b => {
  for (const [width,height] of [[1280,800],[390,844]]) {
    const p = await b.newPage(); await p.setViewport({width,height});
    if(width===390) await p.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"reduce"}]);
    p.on("pageerror",e => errors.push(String(e)));
    p.on("console",m => { if (m.type() === "error") errors.push(m.text()); });
    await p.evaluateOnNewDocument(() => { localStorage.setItem("autophys.tour.seen.local","true"); });
    await p.goto(base+"/app?source=fixtures",{waitUntil:"load"}); await p.waitForSelector(".ck-panels[data-ready]"); await settle(p);
    // Use a non-default selection, a closed panel, and actual nonzero scrolling.
    if (width < 640) await p.click(".ck-sidebar-toggle");
    await settle(p);
    await p.evaluate(() => (document.querySelector("std-tree-list.ap-tree")?.shadowRoot?.querySelector('[data-id="bench-a/fit-1/landscape"] > .line') as HTMLElement).click());
    await settle(p);
    if (width >= 640 && await p.$eval(".ck-details-toggle",e=>e.getAttribute("aria-pressed")==="true")) await p.click(".ck-details-toggle");
    await p.evaluate(() => {
      const rail = document.querySelector("std-rail")?.shadowRoot?.querySelector("#body") as HTMLElement;
      if (rail) rail.scrollTop = 67;
      const main = document.querySelector(".ap-viewer") as HTMLElement;
      if (main) main.scrollTop = 83;
    });
    await settle(p);
    const before = await snapshot(p);
    await start(p);
    const sequence = [[1,0,"config:bench-oscillators"],[2,0,"config:bench-oscillators"],[3,0,"bench-a"],[4,0,"bench-a/data/free_response@1"],[5,0,"bench-a/fit-1/fit"],[5,1,"bench-a/fit-1/residuals"],[6,0,"bench-a/sens"],[7,0,"bench-a/prop/p1"],[8,0,"bench-a/validate"],[9,0,"config:bench-oscillators"]] as const;
    for (let i=0;i<sequence.length;i++) {
      const [step,substep,expected] = sequence[i]; await ready(p,step,substep);
      const state = await p.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".ap-guided-tour")!;
        const tree = document.querySelector("std-tree-list.ap-tree")?.shadowRoot;
        const selected = tree?.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.id;
        const rings = [...document.querySelectorAll<HTMLElement>(".ap-tour-halo")].map(r=>{
          const sel=r.dataset.target!, target = sel.startsWith("row:") ? tree?.querySelector<HTMLElement>('[data-id="'+CSS.escape(sel.slice(4))+'"] > .line') : document.querySelector<HTMLElement>(sel);
          const a=r.getBoundingClientRect(),t=target!.getBoundingClientRect();
          return { sel, exact:Math.abs(a.x-t.x+4)<2 && Math.abs(a.y-t.y+4)<2 && Math.abs(a.width-t.width-8)<2, clear:t.bottom<sheet.getBoundingClientRect().top && t.top>=65 };
        });
        const preview = sheet.querySelector<HTMLElement>(".ap-tour-preview")!;
        return { selected, expected:sheet.dataset.selection,rings,preview:preview.dataset.ready==="true" && !!preview.querySelector(".ap-tour-preview-clip")?.children.length,
          source:!document.querySelector<HTMLElement>(".ap-tour-chip")!.hidden,half:sheet.querySelectorAll(".ap-tour-bars b")[4].getAttribute("style"),
          decisions:[...document.querySelectorAll<HTMLButtonElement>("#ap-action-approve,#ap-action-reject")].map(b=>b.disabled) };
      });
      check(state.selected === expected && state.expected === expected,width+": step "+step+"."+substep+" uses the actual selected row ("+state.selected+")");
      const crumb = await p.$eval(".ap-crumb",e=>e.textContent ?? "");
      const leaf = step===1 || step===2 || step===9 ? "Configuration" : step===3 ? "Investigation" : step===4 ? "free_response" : step===5 ? substep ? "Residuals" : "Fit" : step===6 ? "Sensitivity" : step===7 ? "Sine" : "Validate";
      check(crumb.includes(leaf),width+": Main follows the selected "+leaf+" row");
      check(state.preview,width+": step "+step+"."+substep+" has a real DOM preview");
      check(state.rings.length > 0 && state.rings.every(r=>r.exact && r.clear),width+": step "+step+"."+substep+" halo follows a visible target above the sheet "+JSON.stringify(state.rings));
      check(state.source,width+": demo source is clearly labeled");
      if (step===5) check(state.half === "width:"+(substep ? 100 : 50)+"%",width+": substep fills its shared progress bar");
      if (step===7) check(state.decisions.length===2 && state.decisions.every(Boolean),width+": demo Approve and Reject are disabled");
      if (step===9) check(state.rings.length===2 && state.rings.some(r=>r.sel===".ap-devices") && state.rings.some(r=>r.sel===".ap-new-project button"),width+": final step rings both entry rows");
      const name="step-"+step+"-"+substep+"-"+width+"x"+height+".png";
      await p.screenshot({path:out+"/"+name});shots.push(name);
      if(i<sequence.length-1) await p.click(".ap-tour-next");
    }
    // Back through the decision page must replay selection AND panel enter actions.
    await p.click(".ap-tour-back"); await ready(p,8);
    await p.click(".ap-tour-back"); await ready(p,7);
    check(await p.$eval(".ap-guided-tour",e=>(e as HTMLElement).dataset.selection==="bench-a/prop/p1"),width+": Back replays enter selection");
    await p.keyboard.press("Escape"); await p.waitForSelector("html:not([data-ap-tour])"); await settle(p);
    await new Promise(r=>setTimeout(r,420));
    check(JSON.stringify(await snapshot(p))===JSON.stringify(before),width+": Esc restores selection, expansions, panels, scroll and source view exactly");
    await start(p); await p.click(".ap-tour-close"); await settle(p); await new Promise(r=>setTimeout(r,420));
    check(JSON.stringify(await snapshot(p))===JSON.stringify(before),width+": close restores the same snapshot");
    await start(p);
    for(let i=1;i<sequence.length;i++){await p.click(".ap-tour-next");await ready(p,sequence[i][0],sequence[i][1]);}
    await p.click(".ap-tour-next"); await settle(p); await new Promise(r=>setTimeout(r,420));
    check(JSON.stringify(await snapshot(p))===JSON.stringify(before),width+": Done restores the same snapshot");
    check(await p.evaluate(()=>localStorage.getItem("autophys.tour.seen.local")==="true"),width+": Done records tour seen");
    await p.goto(base+"/app",{waitUntil:"load"}); await p.waitForSelector(".ap-tour-empty"); await settle(p);
    const empty = await snapshot(p);
    await p.click(".ap-tour-empty"); await ready(p,1); await p.keyboard.press("Escape"); await settle(p); await new Promise(r=>setTimeout(r,420));
    const restoredEmpty = await snapshot(p);
    if(JSON.stringify(restoredEmpty)!==JSON.stringify(empty)) console.log("RESTORE DIFF",JSON.stringify({empty,restoredEmpty}));
    check(JSON.stringify(restoredEmpty)===JSON.stringify(empty),width+": empty-workspace entry restores the live data source");
    check(await p.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),width+": no horizontal document overflow");
    await p.close();
  }
},{executablePath:Deno.env.get("AUTOPHYS_CHROME") ?? Deno.env.get("HOME")+"/.cache/ms-playwright/chromium-1112/chrome-linux/chrome",args:["--no-sandbox"]});
check(errors.length===0,"no browser console or page errors: "+errors.join("; "));
await Deno.writeTextFile(out+"/tour-receipt.json",JSON.stringify({checks,shots,errors},null,2));
console.log(checks.length+" checks; "+shots.length+" captures");
