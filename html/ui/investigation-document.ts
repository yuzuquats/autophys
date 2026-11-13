/** App-owned std-documentation insert; std-card owns its surface and shadow. */
import { Documentation } from "@tento-ui/components/documentation/documentation";
import { Card } from "@tento-ui/components/card/card";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import type { InvestigationSummary } from "./view-model.ts";
import type { IntentHandler } from "./intent.ts";

const styles = `
:host{display:block;margin:24px 0;min-width:0;font:13px/1.55 var(--ap-font,system-ui,sans-serif);color:var(--ap-ink,#202020)}
std-card{--card-font-family:var(--ap-font,system-ui,sans-serif);--card-min-height:0px;--card-shadow:0 2px 5px rgba(0,0,0,.06),0 8px 22px rgba(0,0,0,.07);--divider:transparent;--bg:#fff;--text-pri:var(--ap-ink,#202020);min-width:0}
.content{padding:18px;margin:0!important;min-width:0}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
h3,p{margin:0}h3{font:600 15px/1.4 var(--ap-font,system-ui,sans-serif);overflow-wrap:anywhere}
.caption{font-size:11px;color:var(--ap-sec,#626262);margin-top:4px}
.status{flex:none;font-size:11px;line-height:1.5;background:#f0f0f0;color:#555;border-radius:4px;padding:3px 6px}
.status[data-tone=ok]{background:#edf4ee;color:#256046}.status[data-tone=warn]{background:#fbf2e5;color:#845019}
.finding{font-size:14px;line-height:1.6;margin:16px 0 8px}
.evidence{font-size:12px;color:var(--ap-sec,#595959);font-variant-numeric:tabular-nums}
.outputs{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;border-top:1px solid var(--ap-line,#e5e5e5);padding-top:12px;margin-top:16px}
.outputs span{font-size:11px;color:var(--ap-sec,#626262)}
button{border:0;background:none;padding:2px 0;font:12px/1.5 var(--ap-font,system-ui,sans-serif);color:var(--ap-ink,#333);text-decoration:underline;text-underline-offset:3px;cursor:pointer;overflow-wrap:anywhere;text-align:left}
button:hover{color:#111}button:focus-visible{outline:2px solid #39708d;outline-offset:4px}
.open{display:block;margin-top:12px;font-size:11px}
@media(max-width:560px){header{display:block}.status{display:inline-block;margin-top:10px}.content{padding:16px}}
`;

class InvestigationView {
  readonly dom = document.createElement("div");
  private card = Card.makeWith({ title: null, subtitle: null, score: null, accent: null, selected: false, onHeaderClick: null });
  private content = document.createElement("article");
  private key: string | undefined;
  private previous = "";
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
    this.refresh();
    return true;
  }
  refresh(): void {
    const summary = this.summaries().find(s => s.id === this.key);
    const next = JSON.stringify([this.key, summary]);
    if (next === this.previous) return;
    this.previous = next;
    const focused = this.dom.shadowRoot?.activeElement as HTMLButtonElement | null;
    const focusId = focused?.dataset.target;
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
    identity.append(text("h3", summary.title));
    if (summary.caption) identity.append(text("p", summary.caption, "caption"));
    const status = text("span", summary.status, "status"); status.dataset.tone = summary.tone;
    header.append(identity, status);
    this.content.append(header, text("p", summary.finding, "finding"), text("p", summary.evidence, "evidence"));
    const select = (label: string, id: string, cls = "") => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;
      b.className = cls; b.dataset.target = id;
      b.addEventListener("click", () => this.onIntent({ kind: "select", id }));
      return b;
    };
    if (summary.outputs.length) {
      const outputs = document.createElement("nav"); outputs.className = "outputs"; outputs.setAttribute("aria-label", "Produced by this investigation");
      outputs.append(text("span", "Produced"), ...summary.outputs.map(o => select(o.label, o.id)));
      this.content.append(outputs);
    }
    this.content.append(select("Open investigation", summary.id, "open"));
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
      id: "ap_investigation", componentName: "ap-investigation", attributeKeys: ["investigation"],
      nodeView: node => {
        const view = new InvestigationView(node, () => state.summaries, onIntent); state.views.add(view);
        return { dom: view.dom, update: node => view.update(node), stopEvent: () => view.stopEvent(),
          ignoreMutation: () => view.ignoreMutation(), destroy: () => state.views.delete(view) };
      },
    }] }).catch(() => { marker.textContent = "The document could not be displayed. Reload to try again."; documents.delete(marker); });
  }
}
