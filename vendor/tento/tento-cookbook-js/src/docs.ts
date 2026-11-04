/**
 * The landing's documentation: one page of sections that sits in the document
 * flow below the viewport-height deck and above the footer, so scrolling past
 * the pitch reaches the manual. Like the deck, the app passes data and the
 * cookbook draws it; text is set with textContent, never parsed as HTML.
 * `code spans` in prose become <code>. On wide screens a sticky contents list
 * sits beside the sections.
 */
import { h } from "./dom.ts";

export type DocsBlock =
  | { kind: "p"; text: string }
  | { kind: "code"; code: string; label?: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "table"; columns: string[]; rows: string[][] };
export type DocsSection = {
  /** Fragment id, unique on the page (letters, digits, dashes). */
  id: string;
  title: string;
  blocks: DocsBlock[];
};
export type DocsPage = {
  eyebrow?: string;
  title: string;
  description?: string;
  sections: DocsSection[];
};

/** Prose with `backtick` spans as inline code. An unmatched backtick stays literal. */
export function inline(text: string): (Node | string)[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return [text];
  return parts.map((part, i) => (i % 2 ? h("code", "ck-docs-code-inline", null, part) : part)).filter((p) => p !== "");
}

function block(b: DocsBlock): HTMLElement {
  switch (b.kind) {
    case "p":
      return h("p", "ck-docs-p", null, ...inline(b.text));
    case "code": {
      const pre = h("pre", "ck-docs-pre", { tabindex: "0" }, h("code", "", null, b.code));
      if (b.label) pre.setAttribute("aria-label", b.label);
      return pre;
    }
    case "list":
      return h(b.ordered ? "ol" : "ul", "ck-docs-list", null,
        ...b.items.map((item) => h("li", "", null, ...inline(item))));
    case "table":
      return h("div", "ck-docs-table-wrap", { tabindex: "0" },
        h("table", "ck-docs-table", null,
          h("thead", "", null, h("tr", "", null, ...b.columns.map((c) => h("th", "", { scope: "col" }, c)))),
          h("tbody", "", null, ...b.rows.map((row) => h("tr", "", null, ...row.map((cell) => h("td", "", null, ...inline(cell))))))));
  }
}

export function createDocs(page: DocsPage): HTMLElement {
  const head = h("header", "ck-docs-head", null,
    ...(page.eyebrow ? [h("p", "ck-docs-eyebrow", null, page.eyebrow)] : []),
    h("h2", "ck-docs-title", { id: "ck-docs-title" }, page.title),
    ...(page.description ? [h("p", "ck-docs-description", null, ...inline(page.description))] : []),
  );
  const toc = h("nav", "ck-docs-toc", { "aria-label": "On this page" },
    h("p", "ck-docs-toc-label", null, "On this page"),
    h("ol", "", null, ...page.sections.map((s) => h("li", "", null, h("a", "", { href: `#${s.id}` }, s.title)))),
  );
  const sections = page.sections.map((s) =>
    h("section", "ck-docs-section", { id: s.id, "aria-labelledby": `${s.id}-title` },
      h("h3", "ck-docs-section-title", { id: `${s.id}-title` }, s.title),
      ...s.blocks.map(block),
    )
  );
  return h("section", "ck-docs", { "aria-labelledby": "ck-docs-title" },
    h("div", "ck-docs-inner", null, head, h("div", "ck-docs-grid", null, toc, h("div", "ck-docs-body", null, ...sections))),
  );
}

export const docsCss = `
/* landing docs: document content between the deck and the footer */
.ck-docs { padding: 96px var(--ck-gutter, 20px) 112px; background: #fff; color: var(--ck-ink); border-top: 1px solid var(--ck-line); }
@media (min-width: 640px) { .ck-docs { --ck-gutter: 24px; } }
@media (min-width: 1024px) { .ck-docs { --ck-gutter: 32px; } }
.ck-docs-inner { max-width: 1120px; margin: 0 auto; }
.ck-docs-head { max-width: 720px; margin-bottom: 56px; }
.ck-docs-eyebrow { margin: 0 0 12px; color: var(--ck-muted); font-weight: 500; letter-spacing: -.01em; }
.ck-docs-title { margin: 0; font-size: 32px; line-height: 38px; font-weight: 500; letter-spacing: -.035em; }
@media (min-width: 640px) { .ck-docs-title { font-size: 40px; line-height: 46px; } }
.ck-docs-description { margin: 16px 0 0; font-size: 17px; line-height: 26px; color: var(--ck-secondary); }
.ck-docs-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px; }
@media (min-width: 1024px) { .ck-docs-grid { grid-template-columns: 200px minmax(0, 720px); gap: 64px; } }
.ck-docs-toc { display: none; }
@media (min-width: 1024px) { .ck-docs-toc { display: block; position: sticky; top: 104px; align-self: start; } }
.ck-docs-toc-label { margin: 0 0 8px; color: var(--ck-muted); font-size: 12px; line-height: 16px; text-transform: uppercase; letter-spacing: .04em; }
.ck-docs-toc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.ck-docs-toc a { display: block; padding: 4px 0; color: var(--ck-secondary); text-decoration: none; }
.ck-docs-toc a:hover { color: var(--ck-ink); text-decoration: underline; text-underline-offset: 4px; }
.ck-docs-body { min-width: 0; }
.ck-docs-section { scroll-margin-top: 96px; padding-top: 8px; }
.ck-docs-section + .ck-docs-section { margin-top: 48px; padding-top: 48px; border-top: 1px solid var(--ck-n200); }
.ck-docs-section-title { margin: 0 0 16px; font-size: 22px; line-height: 28px; font-weight: 500; letter-spacing: -.025em; }
.ck-docs-p, .ck-docs-list { margin: 0 0 16px; font-size: 15px; line-height: 24px; color: var(--ck-secondary); }
.ck-docs-list { padding-left: 22px; }
.ck-docs-list li + li { margin-top: 6px; }
.ck-docs-code-inline { font: 13px/1 var(--ck-mono); padding: 2px 5px; border-radius: 4px; background: var(--ck-n100); color: var(--ck-ink); }
.ck-docs-pre { margin: 0 0 16px; padding: 16px; overflow-x: auto; border-radius: 12px; background: var(--ck-n100);
  font: 13px/20px var(--ck-mono); color: var(--ck-ink); }
.ck-docs-table-wrap { margin: 0 0 16px; overflow-x: auto; }
.ck-docs-table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 20px; }
.ck-docs-table th { text-align: left; font-weight: 500; color: var(--ck-ink); padding: 8px 16px 8px 0; border-bottom: 1px solid var(--ck-line); white-space: nowrap; }
.ck-docs-table td { vertical-align: top; padding: 10px 16px 10px 0; border-bottom: 1px solid var(--ck-n200); color: var(--ck-secondary); }
.ck-docs-table td:first-child { color: var(--ck-ink); white-space: nowrap; }
`;
