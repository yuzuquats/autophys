/** Browser regression suite, bundled as AutophysDiffTests and run in an owned tab. */
import { AutophysMain } from "../ui/main.ts";
import { AutophysDetails } from "../ui/details.ts";
import type { DetailsModel, MainModel } from "../ui/view-model.ts";
import { MarkupDiff, freshMarkers } from "../ui/render-diff.ts";

export function run(): string[] {
  const checks: string[] = [];
  const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); checks.push(label); };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:9999;background:white;overflow:auto";
  document.body.append(host);
  let hydrations = 0;
  const hydrate = (root: HTMLElement) => {
    for (const marker of freshMarkers(root, "[data-ap-cell]")) {
      const component = document.createElement("std-list-cell-layout"), content = document.createElement("div");
      content.className = "ap-cell-text";
      content.append(...marker.children); component.append(content); marker.replaceChildren(component); hydrations++;
    }
    for (const marker of freshMarkers(root, "[data-ap-grid]")) {
      const component = document.createElement("std-grid-layout");
      component.append(...marker.children); marker.replaceChildren(component); hydrations++;
    }
    for (const marker of freshMarkers(root, "[data-ap-button]")) {
      const button = document.createElement("button");button.textContent = marker.textContent;
      marker.replaceChildren(button); hydrations++;
    }
  };
  const draw = new MarkupDiff(host, hydrate);
  const card = (id: string, status: string) => `<section id="${id}"><header data-ap-cell><h3>${id}</h3><p>${status}</p></header><details><summary>More</summary><input id="${id}-field" value="1234"></details><svg><path d="M0 0L1 1"></path></svg><span data-ap-button="copy-sdk">Copy</span></section>`;
  const page = (status: string, reversed = false) => `<div class="viewer" style="height:100px;overflow:auto"><div data-ap-grid>${(reversed ? [card("b", "steady"), card("a", status)] : [card("a", status), card("b", "steady")]).join("")}</div></div>`;
  try {
    draw.render(page("pending"));
    const a = host.querySelector("#a")!, b = host.querySelector("#b")!;
    const header = a.querySelector("std-list-cell-layout"), grid = host.querySelector("std-grid-layout"), svg = a.querySelector("svg"), button = a.querySelector("button");
    const field = host.querySelector<HTMLInputElement>("#a-field")!, details = a.querySelector("details")!;
    details.open = true; field.focus(); field.setSelectionRange(1, 3);
    const initialHydrations = hydrations;
    const observer = new MutationObserver(() => {});observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
    draw.render(page("pending"));
    check(observer.takeRecords().length === 0, "equal markup produces zero DOM mutations");
    draw.render(page("approved"));
    check(host.querySelector("#a") === a && host.querySelector("#b") === b, "status changes retain both cards");
    check(a.querySelector("p")?.textContent === "approved", "changed status patches its text");
    check(a.querySelector("std-list-cell-layout") === header && host.querySelector("std-grid-layout") === grid, "adopted headers and grid retain identity");
    check(a.querySelector("svg") === svg && a.querySelector("button") === button && hydrations === initialHydrations, "unaffected charts and hydrated buttons stay mounted");
    check(field.isConnected && document.activeElement === field && field.selectionStart === 1 && field.selectionEnd === 3, "focused input and caret survive sibling updates");
    check(details.open, "local disclosure state survives model updates");
    draw.render(page("approved", true));
    check(host.querySelector("#a") === a && host.querySelector("#b") === b && grid?.firstElementChild === b, "keyed reorder moves existing cards");
    draw.render(page("approved", true).replace('value="1234"', 'value="5678"'));
    check(host.querySelector("#b-field")?.getAttribute("value") === "5678", "changed field value reaches its retained input");
    draw.render('<div class="viewer"><p>Replacement selection</p></div>');
    check(!a.isConnected && !b.isConnected && host.textContent === "Replacement selection", "obsolete cards are removed on selection change");
    observer.disconnect();
    // Repeated classes are not globally unique keys.
    draw.render('<div><p class="row">one</p><p class="row">two</p></div>');
    const rows = [...host.querySelectorAll("p")];
    draw.render('<div><p class="row">one!</p><p class="row">two</p></div>');
    check([...host.querySelectorAll("p")].every((node, i) => node === rows[i]), "duplicate class keys retain each sibling independently");
    const mainHost = document.createElement("section");
    mainHost.style.cssText = "width:600px;height:400px"; host.append(mainHost);
    const main = new AutophysMain(mainHost, () => {}, {}, hydrate);
    const model: MainModel = { crumb: [{ label: "Live result" }], meta: "pending", credit: "Recorded source", actions: [{ name: "report", label: "Report" }],
      body: { kind: "panels", panels: [{ charts: [{ kind: "xy", height: 150, x: { min: 0, max: 1, ticks: [] }, y: { min: 0, max: 1, ticks: [] }, layers: [{ kind: "line", points: [[0, 0], [1, 1]], tone: "fit" }] }] }] } };
    main.render(model);
    const chart = mainHost.querySelector("svg"), report = mainHost.querySelector<HTMLButtonElement>("#ap-action-report")!;
    report.focus();
    main.render({ ...model, meta: "complete" });
    check(mainHost.querySelector("svg") === chart && chart?.isConnected && report.isConnected && document.activeElement === report, "main metadata updates preserve chart DOM and button focus");
    main.destroy();
    const detailsHost = document.createElement("section");host.append(detailsHost);
    const detailsView = new AutophysDetails(detailsHost, () => {}, {}, hydrate);
    const detail: DetailsModel = { title: "Experiment", icon: "proposal", status: { text: "pending" }, sections: [{ heading: "Settings", blocks: [{ kind: "fields", fields: [{ name: "gain", label: "Gain", value: "1234" }] }] }] };
    detailsView.render(detail);
    const gain = detailsHost.querySelector<HTMLInputElement>("input")!;
    gain.focus();gain.setSelectionRange(1, 2);
    detailsView.render({ ...detail, status: { text: "approved" } });
    check(gain.isConnected && detailsHost.querySelector("input") === gain && document.activeElement === gain && gain.selectionStart === 1 && gain.selectionEnd === 2, "details status updates retain edited field and caret");
    detailsView.destroy();
    return checks;
  } finally { host.remove(); }
}
