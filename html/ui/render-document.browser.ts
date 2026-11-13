/** Browser regression for evidence updates in opaque documentation nodes. */
import { MarkupDiff } from "./render-diff.ts";

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

/** Exercise the real renderer with the demo Markdown, including prose after both inserts. */
export async function runInserts(DocumentationCtor: { make(): import("@tento-ui/components/documentation/documentation").Documentation }, markdown: string): Promise<string[]> {
  const host = document.createElement("div"), doc = DocumentationCtor.make(), seen: string[] = [];
  host.style.cssText = "position:fixed;left:-10000px;width:600px"; host.append(doc); document.body.append(host);
  try {
    await doc.bind({ markdown, inserts: [{ id: "ap_investigation", componentName: "ap-investigation", attributeKeys: ["investigation"],
      nodeView: node => { const dom = document.createElement("span"); dom.textContent = String(node.attrs.investigation); seen.push(dom.textContent); return { dom }; },
    }] });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const all = (root: ParentNode): Element[] => [...root.querySelectorAll("*")].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]);
    const content = all(host).find(e => e.classList.contains("ProseMirror"))?.textContent ?? "";
    if (seen.length !== 2 || new Set(seen).size !== 2) throw Error("Both investigation references must render");
    if (!content.includes("Work still awaiting approval") || !content.includes("What remains open") || !content.endsWith("diagnostic evidence.")) throw Error("Inserts must preserve the following Markdown");
    return ["both investigation inserts render", "following narrative and limitations remain visible"];
  } finally { host.remove(); }
}
