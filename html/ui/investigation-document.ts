/** App-owned std-documentation insert; std-card owns its surface and shadow. */
import { Documentation } from "@tento-ui/components/documentation/documentation";
import { Card } from "@tento-ui/components/card/card";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import type { InvestigationSummary } from "./view-model.ts";
import type { IntentHandler } from "./intent.ts";

/** Authored prose stays in the Markdown; evidence and navigation come from records. */
export const investigationAttributeKeys = ["investigation", "title", "summary", "before", "before-detail", "after", "after-detail", "scope"] as const;

const styles = `
:host{display:block;margin:24px 0;min-width:0;font:13px/1.6 var(--ap-font,system-ui,sans-serif);color:var(--ap-ink,#252525)}
std-card{--card-font-family:var(--ap-font,system-ui,sans-serif);--card-min-height:0px;--card-shadow:0 2px 5px rgba(0,0,0,.06),0 8px 22px rgba(0,0,0,.07);--divider:transparent;--bg:#fff;--text-pri:var(--ap-ink,#252525);min-width:0}
.content{padding:24px;margin:0!important;min-width:0}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
h3,h4,p{margin:0}h3{font:600 21px/1.35 var(--ap-font,system-ui,sans-serif);letter-spacing:-.018em;text-wrap:balance;overflow-wrap:anywhere}
.caption{font-size:12px;color:var(--ap-sec,#666);margin-top:7px}
.status{flex:none;font-size:11px;line-height:1.5;background:#f0f0f0;color:#555;border-radius:4px;padding:4px 7px}
.status[data-tone=ok]{background:#edf4ee;color:#256046}.status[data-tone=warn]{background:#fbf2e5;color:#845019}
.finding{font-size:15px;line-height:1.75;margin:20px 0 24px;max-width:70ch}
.change{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:22px}.change>div+div{border-left:1px solid var(--ap-line,#e3e3e3);padding-left:24px}
.change h4{font-size:12px;font-weight:500;color:var(--ap-sec,#666);margin-bottom:7px}.change strong{display:block;font-size:15px;font-weight:600;line-height:1.45}.change p{font-size:13px;color:var(--ap-sec,#555);margin-top:7px}
.check{font-size:13px}.scope{font-size:12px;color:var(--ap-sec,#666);margin-top:6px}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:14px 20px;border-top:1px solid var(--ap-line,#e6e6e6);padding-top:14px;margin-top:20px}
details{flex:1;min-width:150px}details[open]{flex-basis:100%}summary{font-size:12px;cursor:pointer;list-style-position:inside;text-decoration:underline;text-underline-offset:3px}
.technical{font-size:12px;color:var(--ap-sec,#555);margin-top:14px}.technical p+p{margin-top:9px}.parameters{display:flex;flex-wrap:wrap;gap:4px 16px;font-variant-numeric:tabular-nums;margin-top:9px}.outputs{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:14px}
button{border:0;background:none;padding:2px 0;font:12px/1.5 var(--ap-font,system-ui,sans-serif);color:var(--ap-ink,#333);text-decoration:underline;text-underline-offset:3px;cursor:pointer;overflow-wrap:anywhere;text-align:left}
button:hover,summary:hover{color:#111}button:focus-visible,summary:focus-visible{outline:2px solid #39708d;outline-offset:4px}::selection{background:#d8e7ed;color:#162e39}
@media(max-width:560px){header{display:block}.status{display:inline-block;margin-top:12px}.content{padding:18px}h3{font-size:20px}.finding{font-size:14px;margin:18px 0 22px}.change{gap:14px}.change>div+div{padding-left:14px}.change strong{font-size:14px}.change p{font-size:12px}}
@container(max-width:310px){.change{grid-template-columns:1fr;gap:18px}.change>div+div{border:0;padding-left:0}}
.content{container-type:inline-size}
`;

class InvestigationView {
  readonly dom = document.createElement("div");
  private card = Card.makeWith({ title: null, subtitle: null, score: null, accent: null, selected: false, onHeaderClick: null });
  private content = document.createElement("article");
  private key: string | undefined;
  private previous = "";
  private attrs: Record<string, unknown> = {};
  constructor(node: ProseMirrorEditor.ProseMirrorNode, private summaries: () => readonly InvestigationSummary[], private onIntent: IntentHandler) {
    this.dom.setAttribute("data-ap-investigation-insert", "");
    this.dom.contentEditable = "false";
    const root = this.dom.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = styles;
    this.content.className = "content";
    this.card.append(this.content); root.append(style, this.card);
    this.update(node);
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "ap_investigation") return false;
    this.key = String(node.attrs.investigation ?? "");
    this.attrs = node.attrs;
    this.refresh();
    return true;
  }
  refresh(): void {
    const summary = this.summaries().find(s => s.id === this.key);
    const next = JSON.stringify([this.key, this.attrs, summary]);
    if (next === this.previous) return;
    this.previous = next;
    const focused = this.dom.shadowRoot?.activeElement as HTMLButtonElement | null;
    const focusId = focused?.dataset.target;
    const disclosureFocused = focused?.tagName === "SUMMARY";
    const expanded = this.content.querySelector("details")?.open ?? false;
    this.content.replaceChildren();
    const text = (tag: string, value: string, cls = "") => {
      const e = document.createElement(tag); e.textContent = value; e.className = cls; return e;
    };
    if (!summary) {
      this.content.append(text("h3", "Investigation unavailable"), text("p", "This document references an investigation that is not in this project.", "finding"));
      return;
    }
    this.content.setAttribute("aria-label", summary.title);
    const header = document.createElement("header"), identity = document.createElement("div");
    const authored = (key: string) => typeof this.attrs[key] === "string" ? String(this.attrs[key]) : "";
    identity.append(text("h3", authored("title") || summary.title));
    identity.append(text("p", summary.caption || summary.title, "caption"));
    const status = text("span", summary.status, "status"); status.dataset.tone = summary.tone;
    header.append(identity, status);
    this.content.append(header, text("p", authored("summary") || summary.finding, "finding"));
    if (authored("before") && authored("after")) {
      const comparison = document.createElement("div"); comparison.className = "change";
      for (const key of ["before", "after"]) {
        const side = document.createElement("div");
        side.append(text("h4", key === "before" ? "Before" : summary.status.startsWith("Complete") ? "After" : "Next"), text("strong", authored(key)));
        if (authored(key + "-detail")) side.append(text("p", authored(key + "-detail")));
        comparison.append(side);
      }
      this.content.append(comparison);
    }
    this.content.append(text("p", summary.check, "check"));
    if (authored("scope")) this.content.append(text("p", authored("scope"), "scope"));
    const select = (label: string, id: string, cls = "") => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;
      b.className = cls; b.dataset.target = id;
      b.addEventListener("click", () => this.onIntent({ kind: "select", id }));
      return b;
    };
    const footer = document.createElement("footer"), details = document.createElement("details");
    details.open = expanded;
    details.append(text("summary", "Technical details & outputs"));
    const technical = document.createElement("div"); technical.className = "technical";
    technical.append(text("p", summary.title), text("p", summary.finding), text("p", summary.evidence));
    if (summary.parameters.length) {
      const parameters = document.createElement("div"); parameters.className = "parameters";
      for (const param of summary.parameters) parameters.append(text("span", `${param.label}: ${param.value}`));
      technical.append(parameters);
    }
    if (summary.outputs.length) {
      const outputs = document.createElement("nav"); outputs.className = "outputs"; outputs.setAttribute("aria-label", "Investigation records and outputs");
      outputs.append(...summary.outputs.map(o => select(o.label, o.id)));
      technical.append(outputs);
    }
    details.append(technical); footer.append(details, select("Open investigation", summary.id, "open"));
    this.content.append(footer);
    if (disclosureFocused) details.querySelector("summary")?.focus({ preventScroll: true });
    if (focusId) [...this.content.querySelectorAll<HTMLButtonElement>("button")].find(b => b.dataset.target === focusId)?.focus({ preventScroll: true });
  }
  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }
}

const documents = new WeakMap<HTMLElement, { summaries: readonly InvestigationSummary[]; views: Set<InvestigationView> }>();
/** Refresh evidence independently of Markdown so streamed records retain the document. */
export function hydrateInvestigationDocuments(host: HTMLElement, onIntent: IntentHandler): void {
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-document]")) {
    const summaries: InvestigationSummary[] = JSON.parse(marker.dataset.apInvestigations ?? "[]");
    const mounted = documents.get(marker);
    if (mounted) { mounted.summaries = summaries; for (const view of mounted.views) view.refresh(); continue; }
    const state = { summaries, views: new Set<InvestigationView>() }; documents.set(marker, state);
    const doc = Documentation.make(); marker.replaceChildren(doc);
    void doc.bind({ markdown: marker.dataset.apDocument!, inserts: [{
      id: "ap_investigation", componentName: "ap-investigation", attributeKeys: investigationAttributeKeys,
      nodeView: node => {
        const view = new InvestigationView(node, () => state.summaries, onIntent); state.views.add(view);
        return { dom: view.dom, update: node => view.update(node), stopEvent: () => view.stopEvent(),
          ignoreMutation: () => view.ignoreMutation(), destroy: () => state.views.delete(view) };
      },
    }] }).catch(() => { marker.textContent = "The document could not be displayed. Reload to try again."; documents.delete(marker); });
  }
}
