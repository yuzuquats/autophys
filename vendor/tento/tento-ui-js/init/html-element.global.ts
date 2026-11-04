const INIT_FLAG = "__lona_html_element__";

/**
 * Assign inline styles with at most one style mutation per call.
 *
 * Each property is diffed against the INLINE style first (inline reads never
 * force style/layout work); unchanged properties are not written. One changed
 * property is a single property write. Two or more are composed on a detached
 * scratch declaration and land as ONE `cssText` assignment, so the element
 * schedules one inline-style invalidation instead of one per property. The
 * diff stays a read of the element rather than a remembered record because
 * other writers share these properties (a record would skip their resets).
 * Values that normalize differently on read-back simply rewrite.
 * A style object without `cssText` (test shims) keeps per-property writes.
 */
export function assignInlineStyles<T extends HTMLElement>(
  $e: T,
  styles: CSSStyleWithVariables,
): T {
  const style = $e.style;
  let changed: Option<{ key: string; name: string; value: Option<string> }[]> = null;
  for (const key in styles) {
    const raw = (styles as any)[key];
    const custom = key.charCodeAt(0) === 45 && key.charCodeAt(1) === 45;
    if (custom) {
      if (raw == null ? style.getPropertyValue(key) === "" : style.getPropertyValue(key) === raw) continue;
    } else if ((style as any)[key] === raw) {
      continue;
    }
    const name = custom ? key : key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    (changed ??= []).push({ key, name, value: raw == null ? null : String(raw) });
  }
  if (changed == null) return $e;
  if (changed.length === 1 || !("cssText" in style)) {
    for (const { key, value } of changed) {
      if (key.charCodeAt(0) === 45 && key.charCodeAt(1) === 45) {
        if (value == null) style.removeProperty(key);
        else style.setProperty(key, value);
      } else {
        (style as any)[key] = value;
      }
    }
    return $e;
  }
  const scratch = scratchStyle($e);
  scratch.cssText = style.cssText;
  for (const { name, value } of changed) {
    if (value == null || value === "") scratch.removeProperty(name);
    else scratch.setProperty(name, value);
  }
  style.cssText = scratch.cssText;
  return $e;
}

let scratchDeclaration: Option<{ document: Document; style: CSSStyleDeclaration }>;

/** A detached declaration of `$e`'s document: composing on it mutates nothing live. */
function scratchStyle($e: HTMLElement): CSSStyleDeclaration {
  const document = $e.ownerDocument;
  if (scratchDeclaration?.document !== document) {
    scratchDeclaration = { document, style: document.createElement("div").style };
  }
  return scratchDeclaration.style;
}

export function initHtmlElement(): void {
  if ((globalThis as any)[INIT_FLAG]) return;
  (globalThis as any)[INIT_FLAG] = true;

  HTMLElement.prototype.assignStyles = function <T extends HTMLElement>(
    this: T,
    styles: CSSStyleWithVariables,
  ): T {
    return assignInlineStyles(this, styles);
  };
}
