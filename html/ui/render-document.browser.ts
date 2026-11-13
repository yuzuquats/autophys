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
