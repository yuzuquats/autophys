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
  font: 14px/1.5 system-ui, sans-serif;
}
.tento-docs * { box-sizing: border-box; }
.tento-docs-intro { margin: 0 0 48px 224px; max-width: 800px; }
.tento-docs-intro h2 { margin: 0 0 16px; font: 400 28px/1.2 system-ui, sans-serif; letter-spacing: -.025em; }
.tento-docs-intro p { margin: 0; color: #424242; max-width: 48em; }
.tento-docs-layout { display: grid; grid-template-columns: 176px minmax(0, 800px); gap: 48px; }
.tento-docs-nav { position: sticky; top: 96px; align-self: start; display: grid; gap: 2px; font: 13px/1.5 system-ui, sans-serif; }
.tento-docs-nav a { padding: 7px 12px; text-decoration: none; color: #5c5c5c; border-left: 2px solid transparent; }
.tento-docs-nav a:hover, .tento-docs-nav a[aria-current="location"] { color: #141414; border-color: #4a4fc4; background: #f7f7f7; }
.tento-docs-body { min-width: 0; }
.tento-docs-section { scroll-margin-top: var(--documentation-scroll-offset, 88px); min-width: 0; }
.tento-docs-section + .tento-docs-section { border-top: 1px solid #d9d9d9; padding-top: 40px; margin-top: 40px; }
.tento-docs-section std-documentation { display: block; --editor-padding: 0px; }
.tento-docs-error { color: #8a2828; }
@media (max-width: 800px) {
  .tento-docs { padding: 48px 24px 72px; }
  .tento-docs-intro { margin: 0 0 32px; }
  .tento-docs-intro h2 { font-size: 26px; }
  .tento-docs-layout { display: block; }
  .tento-docs-nav { position: static; display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 32px; }
  .tento-docs-nav a { font-size: 12px; padding: 6px 8px; }
}
`;

const COPY_CSS = `
.tento-docs-code { position: relative; margin-block: 20px; padding-top: 28px; background: var(--code-bg, #f7f7f7); border: 1px solid #e5e5e5; }
.tento-docs-code std-code { margin: 0; }
.tento-docs-copy { position: absolute; top: 5px; right: 8px; padding: 3px 8px; font: 12px/1.5 system-ui, sans-serif; border: 0; background: transparent; color: #4a4fc4; cursor: pointer; }
.tento-docs-code textarea { box-sizing: border-box; width: 100%; font: inherit; font-family: "SF Mono", Menlo, monospace; color: #141414; background: #fff; border: 1px solid #d9d9d9; padding: 12px; }
.tento-docs-copy:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
`;

class CopyableCodeBlockView {
  dom: HTMLElement;
  private code: StaticCodeBlockView;
  private text: string;
  private reset: ReturnType<typeof setTimeout> | undefined;
  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.text = node.textContent;
    this.dom = document.createElement("div");
    this.dom.className = "tento-docs-code";
    this.code = new StaticCodeBlockView(node);
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
        // Rendered Code uses zero-width placeholders for blank lines. Select
        // the exact source, so manual copy never adds those characters.
        let source = this.dom.querySelector<HTMLTextAreaElement>("textarea");
        if (!source) {
          source = document.createElement("textarea");
          source.readOnly = true;
          source.wrap = "off";
          source.rows = Math.min(12, this.text.split("\n").length);
          source.setAttribute("aria-label", "Code source for manual copying");
          this.dom.append(source);
        }
        source.value = this.text;
        source.focus();
        source.select();
        button.textContent = "Text selected";
      }
      clearTimeout(this.reset);
      this.reset = setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
    this.dom.append(button, this.code.dom);
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (!this.code.update(node)) return false;
    this.text = node.textContent;
    return true;
  }
  destroy(): void { clearTimeout(this.reset); }
  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }
}

/** Mount a complete light manual using the existing Documentation and Code components.
 * Asset contract: host /js/prosemirror.min.js, or configure InstanceUrl's static base.
 * Resolves once all Markdown is rendered, then settles any initial section deep link.
 * Returns cleanup for observers/listeners; remounting the same host cleans up first.
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
  const intro = document.createElement("div");
  intro.className = "tento-docs-intro";
  const title = document.createElement("h2");
  title.textContent = options.title;
  intro.append(title);
  if (options.description) {
    const description = document.createElement("p");
    description.textContent = options.description;
    intro.append(description);
  }
  const layout = document.createElement("div");
  layout.className = "tento-docs-layout";
  const nav = document.createElement("nav");
  nav.className = "tento-docs-nav";
  nav.setAttribute("aria-label", `${options.title} sections`);
  const body = document.createElement("div");
  body.className = "tento-docs-body";
  layout.append(nav, body);
  host.replaceChildren(intro, layout);
  const sections: HTMLElement[] = [];
  const bindings: Promise<Documentation>[] = [];
  for (const section of options.sections) {
    const link = document.createElement("a");
    link.href = `#${section.id}`;
    link.textContent = section.title;
    nav.append(link);
    const element = document.createElement("section");
    element.className = "tento-docs-section";
    element.id = section.id;
    element.setAttribute("aria-label", section.title);
    const doc = makeDocumentation();
    const copyStyle = new CSSStyleSheet();
    copyStyle.replaceSync(COPY_CSS);
    doc.addStyle("tento-docs-copy", copyStyle);
    element.append(doc);
    body.append(element);
    sections.push(element);
    bindings.push(doc.bind({ markdown: section.markdown, nodeViews: {
      code_block: node => new CopyableCodeBlockView(node),
    } }));
  }
  const links = [...nav.querySelectorAll("a")];
  let disposed = false;
  const updateCurrent = () => {
    let current = sections[0];
    for (const section of sections) {
      const offset = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
      if (section.getBoundingClientRect().top <= offset + 16) current = section;
    }
    for (const link of links) {
      if (link.hash === `#${current?.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const settleAnchor = () => {
    let id: string;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = id === host.id ? host : sections.find(section => section.id === id);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    updateCurrent();
  };
  const cleanup = () => {
    disposed = true;
    removeEventListener("scroll", updateCurrent);
    removeEventListener("resize", updateCurrent);
    removeEventListener("hashchange", settleAnchor);
    if (mounted.get(host) === cleanup) mounted.delete(host);
  };
  mounted.set(host, cleanup);
  try {
    await Promise.all(bindings);
    // Component styles and Code node views settle in the rendering task after bind.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  catch (error) {
    cleanup();
    throw error;
  }
  if (!disposed) {
    addEventListener("hashchange", settleAnchor);
    addEventListener("scroll", updateCurrent, { passive: true });
    addEventListener("resize", updateCurrent);
    settleAnchor();
  }
  return cleanup;
}
