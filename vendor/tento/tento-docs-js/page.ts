import { InstanceUrl } from "@tento-core/instance-url";
import { Documentation } from "@tento-ui/components/documentation/documentation";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { DOCUMENTATION_TOKENS, StaticCodeBlockView, makeDocumentation } from "./documentation";

export type DocumentationSection = { id: string; title: string; markdown: string };
export type DocumentationPage = {
  title: string;
  description?: string;
  sections: readonly DocumentationSection[];
};

const PAGE_CSS = `
.tento-docs { ${DOCUMENTATION_TOKENS}
  color-scheme: light; background: #fff; border-top: 1px solid #d9d9d9;
  padding: 80px max(24px, calc((100vw - 1080px)/2)) 112px;

}
.tento-docs * { box-sizing: border-box; }
.tento-docs-layout { display: grid; grid-template-columns: 176px minmax(0, 800px); gap: 48px; }
.tento-docs-toc { position: sticky; top: 96px; align-self: start; }
.tento-docs-toc > summary { display: none; }
.tento-docs-nav { display: grid; gap: 4px; font-size: 12px; line-height: 1.5; }
.tento-docs-nav a { padding: 5px 0; text-decoration: none; color: #737373; }
.tento-docs-nav a:hover { color: #141414; }
.tento-docs-nav a[aria-current="location"] { color: #141414; font-weight: 500; }
.tento-docs-nav a:focus-visible, .tento-docs-toc > summary:focus-visible { outline: 2px solid #4a4fc4; outline-offset: 4px; }
.tento-docs-body { min-width: 0; }
.tento-docs std-documentation { display: block; }
.tento-docs-error { color: #8a2828; }
@media (max-width: 800px) {
  .tento-docs { padding: 48px 24px 72px; }
  .tento-docs-layout { display: block; }
  .tento-docs-toc { position: static; margin-bottom: 24px; }
  .tento-docs-toc > summary { display: list-item; width: fit-content; padding: 8px 0; font-size: 12px; color: #5c5c5c; cursor: pointer; }
  .tento-docs-nav { padding: 8px 0; }
  .tento-docs-nav a { padding: 6px 0; }
}
`;

// Keep Code itself as the node-view DOM, as in Autophys. Copy is an overlay
// inside its shadow root, so it does not add a separate frame, padding or type scale.
const COPY_CSS = `
:host { position: relative; }
.tento-docs-copy { position: absolute; top: 4px; right: 6px; padding: 3px 8px; font: 11px/1.5 system-ui, sans-serif; border: 0; border-radius: 3px; background: #2e3440; color: #d8dee9; cursor: pointer; z-index: 1; }
.tento-docs-copy:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.tento-docs-source { box-sizing: border-box; width: 100%; font: 12.5px/1.35 "SF Mono", Menlo, monospace; color: #141414; background: #fff; border: 1px solid #d9d9d9; padding: 12px; }
`;

class CopyableCodeBlockView extends StaticCodeBlockView {
  private text: string;
  private reset: ReturnType<typeof setTimeout> | undefined;
  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    super(node);
    this.text = node.textContent;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(COPY_CSS);
    this.dom.addStyle("tento-docs-copy", sheet);
    const button = document.createElement("button");
    button.className = "tento-docs-copy";
    button.type = "button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code example");
    button.setAttribute("aria-live", "polite");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.text);
        button.textContent = "Copied";
      } catch {
        let source = this.dom.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea");
        if (!source) {
          source = document.createElement("textarea");
          source.className = "tento-docs-source";
          source.readOnly = true;
          source.wrap = "off";
          source.rows = Math.min(12, this.text.split("\n").length);
          source.setAttribute("aria-label", "Code source for manual copying");
          this.dom.shadowRoot!.append(source);
        }
        source.value = this.text;
        source.focus();
        source.select();
        button.textContent = "Text selected";
      }
      clearTimeout(this.reset);
      this.reset = setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
    this.dom.shadowRoot!.append(button);
  }
  override update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.text = node.textContent;
    return true;
  }
  destroy(): void { clearTimeout(this.reset); }
}

/** Mount a light manual using one Documentation component, exactly as Autophys.
 * Product sections supply Markdown and navigation IDs, not separate reading surfaces.
 * Host /js/prosemirror.min.js or configure InstanceUrl's static base beforehand.
 * Resolves after component layout/deep-link settlement; returns listener cleanup.
 */
const mounted = new WeakMap<HTMLElement, () => void>();
export async function mountDocumentation(host: HTMLElement, options: DocumentationPage): Promise<() => void> {
  const ids = options.sections.map(section => section.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !id || id === host.id)) {
    throw new Error("Documentation section IDs must be unique and differ from the host ID");
  }
  mounted.get(host)?.();
  if (!document.querySelector("style[data-tento-docs]")) {
    const style = document.createElement("style");
    style.dataset.tentoDocs = "";
    style.textContent = PAGE_CSS;
    document.head.append(style);
  }
  if (!InstanceUrl.hasStaticBase()) InstanceUrl.setStaticBase("");
  host.classList.add("tento-docs");
  const layout = document.createElement("div");
  layout.className = "tento-docs-layout";
  const toc = document.createElement("details");
  toc.className = "tento-docs-toc";
  const summary = document.createElement("summary");
  summary.textContent = "On this page";
  toc.append(summary);
  const smallScreen = matchMedia("(max-width: 800px)");
  const syncToc = () => { toc.open = !smallScreen.matches; };
  syncToc();
  smallScreen.addEventListener("change", syncToc);
  const nav = document.createElement("nav");
  nav.className = "tento-docs-nav";
  nav.setAttribute("aria-label", `${options.title} sections`);
  const body = document.createElement("div");
  body.className = "tento-docs-body";
  const doc = makeDocumentation();
  body.append(doc);
  toc.append(nav);
  layout.append(toc, body);
  host.replaceChildren(layout);
  for (const section of options.sections) {
    const link = document.createElement("a");
    link.href = `#${encodeURIComponent(section.id)}`;
    link.textContent = section.title;
    nav.append(link);
  }
  let disposed = false;
  let headings: HTMLElement[] = [];
  const links = [...nav.querySelectorAll("a")];
  const updateCurrent = () => {
    let current = headings[0];
    for (const heading of headings) {
      const offset = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
      if (heading.getBoundingClientRect().top <= offset + 16) current = heading;
    }
    for (const [index, link] of links.entries()) {
      if (headings[index] === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const settleAnchor = () => {
    let id: string;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = id === host.id ? host : headings.find(heading => heading.id === id);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    updateCurrent();
  };
  // The headings live in Documentation's shadow tree. Handle repeated links too:
  // setting an already-current hash alone would not emit hashchange.
  const followLink = (event: MouseEvent) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a");
    if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (smallScreen.matches) toc.open = false;
    if (link.hash === location.hash) { event.preventDefault(); settleAnchor(); }
  };
  const cleanup = () => {
    disposed = true;
    removeEventListener("hashchange", settleAnchor);
    removeEventListener("scroll", updateCurrent);
    removeEventListener("resize", updateCurrent);
    nav.removeEventListener("click", followLink);
    smallScreen.removeEventListener("change", syncToc);
    if (mounted.get(host) === cleanup) mounted.delete(host);
  };
  mounted.set(host, cleanup);
  const markdown = [`# ${options.title}`, options.description ?? "",
    ...options.sections.map(section => section.markdown)].join("\n\n");
  try {
    await doc.bind({ markdown, nodeViews: { code_block: node => new CopyableCodeBlockView(node) } });
    // RichTextEditor attaches its view through the shared mutation queue.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (disposed) return cleanup;
    headings = [...doc.shadowRoot!.querySelectorAll<HTMLElement>("h2")];
    if (headings.length !== options.sections.length) {
      throw new Error(`Each documentation section must have exactly one level-two heading; found ${headings.length}: ${headings.map(h => h.textContent).join(", ")}`);
    }
    headings.forEach((heading, index) => {
      heading.id = options.sections[index].id;
      heading.style.scrollMarginTop = "var(--documentation-scroll-offset, 88px)";
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  if (!disposed) {
    addEventListener("hashchange", settleAnchor);
    addEventListener("scroll", updateCurrent, { passive: true });
    addEventListener("resize", updateCurrent);
    nav.addEventListener("click", followLink);
    settleAnchor();
  }
  return cleanup;
}
