/// <reference lib="dom" />
/** Reconcile source markup while retaining DOM adopted by hydrated components. */
type Mounted = { source: Node; live: Node; children: Mounted[] };
const hydrated = new WeakSet<Element>();

/** Hydrate newly mounted markers once; retained controls keep their local state. */
export function freshMarkers(host: HTMLElement, selector: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(selector)].filter(marker => {
    if (hydrated.has(marker)) return false;
    hydrated.add(marker);
    return true;
  });
}

// These markers own an opaque component. Containers which adopt app children
// (list cells, grids and setup steppers) are reconciled through their light DOM.
const opaque = "[data-ap-document],[data-ap-icon],[data-ap-empty],[data-ap-steps],[data-ap-timeline],[data-ap-copy],[data-ap-action],[data-ap-skeleton],[data-ap-button]";
function key(node: Node): string | null {
  if (!(node instanceof Element)) return null;
  const id = node.id || ["data-ap-page", "data-ap-experiment-key", "data-ap-experiment-row", "data-ap-jump", "data-ap-id", "data-ap-name"].map(name => node.getAttribute(name)).find(Boolean);
  const identity = id ? `id:${id}` : node.getAttribute("class")?.split(/\s+/)[0];
  return identity ? `${node.namespaceURI}:${node.nodeName}:${identity}` : null;
}
function compatible(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
}
function mount(source: Node): Mounted {
  const live = source.cloneNode(false);
  const children = [...source.childNodes].map(mount);
  for (const child of children) live.appendChild(child.live);
  return { source, live, children };
}
function container(node: Element): Element {
  if (node.hasAttribute("data-ap-cell")) return node.querySelector(":scope > std-list-cell-layout > .ap-cell-text") ?? node;
  if (node.hasAttribute("data-ap-grid")) return node.querySelector(":scope > std-grid-layout") ?? node;
  if (node.hasAttribute("data-ap-stepper")) return node.querySelector(":scope > std-stepper") ?? node;
  return node;
}
function attributes(live: Element, before: Element, next: Element): void {
  // Compare the authored attributes, leaving component-owned styles and local
  // disclosure/focus state alone unless the model explicitly changes them.
  for (const attr of before.attributes) if (!next.hasAttribute(attr.name)) live.removeAttribute(attr.name);
  for (const attr of next.attributes) if (before.getAttribute(attr.name) !== attr.value) {
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
    if (attr.name === "value" && live instanceof HTMLInputElement && live.value !== attr.value) live.value = attr.value;
    if (attr.name === "checked" && live instanceof HTMLInputElement) live.checked = true;
  }
  if (live instanceof HTMLInputElement && before.hasAttribute("checked") && !next.hasAttribute("checked")) live.checked = false;
}
function patch(record: Mounted, next: Node, grids: Set<Element>): Mounted {
  if (record.source.isEqualNode(next)) return record;
  if (!compatible(record.source, next) || next instanceof Element && next.matches(opaque)) {
    const replacement = mount(next);
    record.live.parentNode?.replaceChild(replacement.live, record.live);
    return replacement;
  }
  if (record.live instanceof Element && record.source instanceof Element && next instanceof Element) {
    attributes(record.live, record.source, next);
    if (record.live.hasAttribute("data-ap-grid")) grids.add(record.live);
    record.children = children(container(record.live), record.children, [...next.childNodes], grids);
  } else if (record.live.nodeValue !== next.nodeValue) record.live.nodeValue = next.nodeValue;
  record.source = next;
  return record;
}
function children(parent: Node, before: Mounted[], next: Node[], grids: Set<Element>): Mounted[] {
  const identity = (node: Node) => key(node) ?? `${node.nodeType}:${node.nodeName}`;
  const positions = new Map<string, number>();
  const used = new Set<Mounted>();
  const keyed = new Map<string, Mounted[]>();
  for (const record of before) {
    const id = identity(record.source);
    const siblings = keyed.get(id) ?? [];
    siblings.push(record); keyed.set(id, siblings);
  }
  let cursor: Node | null = parent.firstChild;
  const result = next.map(source => {
    const id = identity(source), position = positions.get(id) ?? 0;
    positions.set(id, position + 1);
    const match = keyed.get(id)?.[position];
    let record: Mounted;
    if (match && !used.has(match)) {
      used.add(match);
      const wasCursor = cursor === match.live;
      record = patch(match, source, grids);
      if (wasCursor) cursor = record.live;
    } else record = mount(source);
    if (record.live !== cursor) {
      // moveBefore preserves focus and custom-element state on supporting browsers.
      const target = parent as Element & { moveBefore?: (node: Node, before: Node | null) => void };
      if (target.moveBefore && record.live.parentNode === parent) target.moveBefore(record.live, cursor);
      else parent.insertBefore(record.live, cursor);
    }
    cursor = record.live.nextSibling;
    return record;
  });
  for (const record of before) if (!used.has(record)) record.live.parentNode?.removeChild(record.live);
  return result;
}

export class MarkupDiff {
  private mounted: Mounted[] = [];
  private markup: string | null = null;
  constructor(private host: HTMLElement, private hydrate: (host: HTMLElement) => void) {}
  render(markup: string): boolean {
    if (markup === this.markup) return false;
    const template = document.createElement("template");
    template.innerHTML = markup;
    if (this.markup === null) this.host.replaceChildren();
    const grids = new Set<Element>();
    this.mounted = children(this.host, this.mounted, [...template.content.childNodes], grids);
    this.markup = markup;
    this.hydrate(this.host);
    for (const marker of grids) {
      const grid = marker.firstElementChild as Element & { layoutGridSync?: () => void };
      grid?.layoutGridSync?.();
    }
    return true;
  }
}
