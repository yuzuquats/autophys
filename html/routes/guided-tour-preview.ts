/** A clipped copy of the real rendered component, including open shadow trees.
 * This preserves SVG plots and computed typography instead of drawing mock UI.
 * Copies are inert, contain no ids, and never hydrate or run component callbacks.
 */
function renderedCopy(source: Element): Element {
  const svg = source.namespaceURI === "http://www.w3.org/2000/svg";
  const copy = svg ? document.createElementNS(source.namespaceURI!, source.localName)
    : document.createElement(source.localName.includes("-") ? "div" : source.localName);
  for (const a of source.attributes) {
    if (!/^(id|on|data-ap|tabindex|autofocus)/.test(a.name)) copy.setAttribute(a.name, a.value);
  }
  const style = getComputedStyle(source);
  let css = "";
  for (const key of style) css += key + ":" + style.getPropertyValue(key) + ";";
  copy.setAttribute("style", css + "visibility:visible;animation:none;transition:none;pointer-events:none;");
  if (source instanceof HTMLInputElement) copy.setAttribute("value", source.value);
  const root = source.shadowRoot ?? source;
  const children = source instanceof HTMLSlotElement && source.assignedNodes({ flatten:true }).length
    ? source.assignedNodes({ flatten:true }) : root.childNodes;
  for (const child of children) {
    if (child instanceof Element) {
      if (!["script", "style"].includes(child.localName)) copy.append(renderedCopy(child));
    } else if (child.nodeType === Node.TEXT_NODE) copy.append(child.cloneNode());
  }
  return copy;
}
export function previewComponent(host: HTMLElement, targets: HTMLElement[]): void {
  const first = targets[0];
  if (!first) { host.replaceChildren(); return; }
  const wrap = document.createElement("div");
  wrap.className = "ap-tour-preview-clip";
  const bounds = targets.map(t => t.getBoundingClientRect());
  const left = Math.min(...bounds.map(r => r.left)), top = Math.min(...bounds.map(r => r.top));
  const width = Math.max(...bounds.map(r => r.right)) - left;
  const height = Math.max(...bounds.map(r => r.bottom)) - top;
  // Fill the preview width and clip tall components; preserve real aspect ratio.
  const scale = Math.min(1, host.clientWidth / Math.max(1, width));
  wrap.style.width = width + "px";
  wrap.style.height = height + "px";
  wrap.style.transform = "scale(" + scale + ")";
  targets.forEach((target, i) => {
    const copy = renderedCopy(target) as HTMLElement;
    Object.assign(copy.style, { position: "absolute", left: bounds[i].left - left + "px", top: bounds[i].top - top + "px", width: bounds[i].width + "px", height: bounds[i].height + "px", margin: "0", transform: "none" });
    wrap.append(copy);
  });
  host.replaceChildren(wrap);
  host.dataset.ready = "true";
}
