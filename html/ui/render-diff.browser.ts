/** Browser regression suite, bundled as AutophysDiffTests and run in an owned tab. */
import { AutophysMain } from "./main.ts";
import { AutophysDetails } from "./details.ts";
import { AutophysSidebar } from "./sidebar.ts";
import { hydrateProjectSetup } from "./new-project-components.ts";
import { newProjectMarkup, type ProjectSetupBody } from "./new-project.ts";
import type { DetailsModel, MainModel, SidebarModel } from "./view-model.ts";
import { MarkupDiff, freshMarkers } from "./render-diff.ts";

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
    const setupHost = document.createElement("section"); host.append(setupHost);
    const setup = new MarkupDiff(setupHost, hydrateProjectSetup);
    const wizard: ProjectSetupBody = { kind: "project-setup", title: "New project", description: "Configure the model", steps: [
      { title: "Name", current: true, done: false, description: "Project name", fields: [{ name: "setup:name", label: "Name", value: "original" }], actions: [{ name: "setup:next", label: "Continue" }] },
      { title: "Parameters", current: false, done: false, description: "Model settings", fields: [{ name: "setup:gain", label: "Gain", value: "1" }], actions: [{ name: "setup:back", label: "Back" }] },
    ] };
    setup.render(newProjectMarkup(wizard));
    const stepper = setupHost.querySelector("std-stepper")!;
    const sections = [...stepper.querySelectorAll("[data-ap-step]")];
    const name = setupHost.querySelector<HTMLInputElement>('input[type="text"]')!;
    const continueButton = setupHost.querySelector("button")!;
    name.value = "edited"; name.focus(); name.setSelectionRange(1, 4);
    const advanced = { ...wizard, steps: wizard.steps.map((step, i) => ({ ...step, current: i === 1, done: i === 0 })) };
    setup.render(newProjectMarkup(advanced));
    check(setupHost.querySelector("std-stepper") === stepper && sections.every(section => section.parentElement === stepper) && continueButton.isConnected, "real stepper retains setup sections and actions when advancing");
    check(setupHost.querySelector('input[type="text"]') === name && name.value === "edited" && document.activeElement === name && name.selectionStart === 1 && name.selectionEnd === 4, "real stepper rebind preserves edited field identity, focus and caret");
    check(stepper.shadowRoot?.querySelectorAll('.step-item[aria-current="step"]').length === 1 && stepper.shadowRoot?.querySelector('.step-item[aria-current="step"] slot')?.getAttribute("name") === sections[1].getAttribute("slot"), "real stepper displays the newly current body");
    setup.render(newProjectMarkup(wizard));
    check(sections.every(section => section.parentElement === stepper) && stepper.querySelectorAll("input").length === 2, "real stepper keeps fields when returning to a previous step");
    const railHost = document.createElement("section");
    railHost.className = "ck-app"; railHost.dataset.cookbook = "";
    railHost.style.cssText = "width:240px;height:400px;position:relative";
    const sidebarHost = document.createElement("section"); sidebarHost.style.cssText = "width:240px;height:400px";
    railHost.append(sidebarHost); host.append(railHost);
    const sidebar = new AutophysSidebar(sidebarHost, () => {});
    const railModel: SidebarModel = { switcher: { kind: "single", label: "Workspace", value: "project", options: [] }, pinned: { id: "devices", label: "Devices", icon: "device", selectable: true, children: null }, section: { label: "Projects", count: "1" }, treeLabel: "Projects", selectedId: null, expandedIds: [], nodes: [
      { id: "project", label: "Short", icon: "workspace", selectable: true, children: [{ id: "child", label: "Long scientific investigation label requiring horizontal scrolling".repeat(2), icon: "workspace", selectable: true, children: null }] },
    ] };
    sidebar.render(railModel);
    const tree = sidebarHost.querySelector<HTMLElement>("std-tree-list")!;
    const collapsedWidth = parseFloat(tree.style.minWidth);
    sidebar.render({ ...railModel, expandedIds: ["project"] });
    const childName = tree.shadowRoot!.querySelector<HTMLElement>('[data-id="child"] .name')!;
    check(!!childName && parseFloat(tree.style.minWidth) > collapsedWidth + 100 && childName.clientWidth >= childName.scrollWidth - 1, "real sidebar expansion measures newly visible long labels");
    sidebar.render(railModel);
    check(parseFloat(tree.style.minWidth) === collapsedWidth, "real sidebar collapse restores the measured rail width");
    sidebar.destroy();
    return checks;
  } finally { host.remove(); }
}
