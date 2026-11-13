/** Browser regression for evidence updates in opaque documentation nodes. */
import { MarkupDiff } from "./render-diff.ts";
import { hydrateInvestigationDocuments, investigationAttributeKeys } from "./investigation-document.ts";
import type { InvestigationSummary } from "./view-model.ts";

export function run(): string[] {
  const checks: string[] = [], host = document.createElement("div");
  document.body.append(host);
  const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); checks.push(label); };
  try {
    const draw = new MarkupDiff(host, () => {});
    const markup = (markdown: string, evidence: string) => `<div data-ap-document="${markdown}" data-ap-investigations="${evidence}"></div>`;
    draw.render(markup("same document", "before"));
    const marker = host.firstElementChild!, mounted = document.createElement("button");
    mounted.textContent = "Mounted insert"; marker.append(mounted); mounted.focus();
    draw.render(markup("same document", "after"));
    check(host.firstElementChild === marker && marker.firstElementChild === mounted, "evidence refresh retains document and insert identity");
    check(document.activeElement === mounted, "evidence refresh preserves focused insert control");
    check(marker.getAttribute("data-ap-investigations") === "after", "updated evidence reaches the retained document");
    draw.render(markup("changed document", "after"));
    check(host.firstElementChild !== marker && !mounted.isConnected, "changed Markdown remounts the document");
    return checks;
  } finally { host.remove(); }
}

/** Exercise the real renderer with authored inserts and the following Markdown. */
export async function runInserts(DocumentationCtor: { make(): import("@tento-ui/components/documentation/documentation").Documentation }, markdown: string, expected = { ids: ["inv_c51194ac2a68ef19", "inv_1b63c1cbdd6c12bd"], tail: "uncertainty bounds are claimed here." }): Promise<string[]> {
  const host = document.createElement("div"), doc = DocumentationCtor.make(), seen: string[] = [];
  host.style.cssText = "position:fixed;left:-10000px;width:600px"; host.append(doc); document.body.append(host);
  try {
    await doc.bind({ markdown, inserts: [{ id: "ap_investigation", componentName: "ap-investigation", attributeKeys: investigationAttributeKeys,
      nodeView: node => { if (!node.attrs.summary || !node.attrs["before-detail"]) throw Error("Authored summaries must survive parsing"); const dom = document.createElement("span"); dom.textContent = String(node.attrs.investigation); seen.push(dom.textContent); return { dom }; },
    }] });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const all = (root: ParentNode): Element[] => [...root.querySelectorAll("*")].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]);
    const content = all(host).find(e => e.classList.contains("ProseMirror"))?.textContent ?? "";
    if (seen.length !== expected.ids.length || seen.some((id, n) => id !== expected.ids[n])) throw Error("All investigation references must render in order");
    if (!content.includes("Takeaways") || !content.endsWith(expected.tail)) throw Error("Inserts must preserve the following Markdown");
    return ["all investigation inserts render", "following narrative and limitations remain visible"];
  } finally { host.remove(); }
}

/** Real insert views keep disclosure/focus across evidence refreshes and preserve navigation. */
export async function runCards(markdown: string, summaries: InvestigationSummary[], expected = { summary: "voltage drops right away", after: "all three model settings" }): Promise<string[]> {
  const host = document.createElement("div"), marker = document.createElement("div"), checks: string[] = [];
  host.style.cssText = "position:fixed;left:-10000px;width:600px"; host.append(marker); document.body.append(host);
  marker.dataset.apDocument = markdown;
  const selected: string[] = [];
  const draw = () => { marker.dataset.apInvestigations = JSON.stringify(summaries); hydrateInvestigationDocuments(host, intent => { if (intent.kind === "select") selected.push(intent.id); }); };
  const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); checks.push(label); };
  const all = (root: ParentNode): Element[] => [...root.querySelectorAll("*")].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]);
  try {
    draw();
    for (let frame = 0; frame < 30 && all(host).filter(e => e.hasAttribute("data-ap-investigation-insert")).length < summaries.length; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const cards = all(host).filter(e => e.hasAttribute("data-ap-investigation-insert"));
    check(cards.length === summaries.length, "all referenced card views mount");
    const root = cards[0].shadowRoot!, article = root.querySelector("article")!;
    check(article.querySelector(".finding")?.textContent?.includes(expected.summary), "plain-language summary renders from Markdown");
    check(article.querySelectorAll(".change>div").length === 2 && article.querySelector(".change")?.textContent?.includes(expected.after), "before and after descriptions survive parsing");
    let details = article.querySelector("details")!;
    check(!details.open && !details.querySelector("nav")!.checkVisibility(), "technical details start collapsed");
    details.open = true; details.querySelector("summary")!.focus();
    summaries = structuredClone(summaries); summaries[0].evidence += " Updated evidence."; draw();
    details = article.querySelector("details")!;
    check(details.open && root.activeElement === details.querySelector("summary"), "evidence refresh retains disclosure state and its focus");
    const target = article.querySelector<HTMLButtonElement>("button[data-target]")!.dataset.target;
    article.querySelector<HTMLButtonElement>("button[data-target]")!.focus(); summaries[0].check += " Updated check."; draw();
    check(article.querySelector("details")!.open && (root.activeElement as HTMLElement)?.dataset.target === target, "evidence refresh retains focused output control");
    const buttons = all(host).filter(e => e.matches("button[data-target]")) as HTMLButtonElement[];
    for (const button of buttons) button.click();
    check(selected.length === buttons.length && selected.every((id, n) => id === buttons[n].dataset.target), "all card links dispatch their recorded targets");
    summaries = summaries.slice(1); draw();
    check(article.textContent?.includes("Investigation unavailable"), "missing investigation reference remains explicit");
    return checks;
  } finally { host.remove(); }
}
