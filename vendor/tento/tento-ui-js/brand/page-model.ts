export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type NodeKind =
  | "section"
  | "stack"
  | "grid"
  | "heading"
  | "prose"
  | "media"
  | "cta"
  | "list"
  | "hero"
  | "pill"
  | "feature-grid"
  | "card"
  | "social-proof"
  | "comparison"
  | "faq"
  | "pricing"
  | "integrations"
  | "post-list"
  | "post-body"
  | "search-filter"
  | "nav"
  | "footer"
  | "breadcrumb";

export interface PageMeta {
  title: string;
  description: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  canonicalUrl: Option<string>;
  ogTitle: Option<string>;
  ogDescription: Option<string>;
  ogImage: Option<string>;
  longTailKeywords: Option<string[]>;
  schemaTypes: Option<string[]>;
}

export namespace PageMeta {
  export function parse(raw: UntypedJson): PageMeta {
    raw.canonicalUrl = raw.canonicalUrl ?? null;
    raw.ogTitle = raw.ogTitle ?? null;
    raw.ogDescription = raw.ogDescription ?? null;
    raw.ogImage = raw.ogImage ?? null;
    raw.longTailKeywords = raw.longTailKeywords ?? null;
    raw.schemaTypes = raw.schemaTypes ?? null;
    return raw;
  }
}

export interface ThemeRefObject {
  tokens: string;
  variant: string;
}

export type ThemeRef = string | ThemeRefObject;

export type NavRef = string;

export interface PageNode {
  kind: NodeKind;
  id: string;
  props: JsonObject;
  children: Option<PageNode[]>;
}

export type Node = PageNode;

export namespace PageNode {
  export function parse(raw: UntypedJson): PageNode {
    raw.children = raw.children ? raw.children.map(PageNode.parse) : null;
    return raw;
  }
}

export interface PageModel {
  route: string;
  meta: PageMeta;
  // An optional design hint. A host that selects its own template (Lona's
  // route hosts do) leaves it out; Brand Acme lets content name its design.
  theme: Option<ThemeRef>;
  nav: NavRef;
  nodes: PageNode[];
  decorators: Option<string[]>;
}

export namespace PageModel {
  export function parse(raw: UntypedJson): PageModel {
    raw.meta = PageMeta.parse(raw.meta);
    raw.theme = raw.theme ?? null;
    raw.nodes = raw.nodes.map(PageNode.parse);
    raw.decorators = raw.decorators ?? null;
    return raw;
  }
}
