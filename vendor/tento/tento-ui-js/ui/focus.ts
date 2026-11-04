// Focus, seen through shadow roots.
//
// `document.activeElement` stops at the first shadow host: inside a page whose
// whole tree hangs off one custom element, it answers that element for every
// focused control, and calling `.focus()` on it later does nothing. Overlays
// that promise to restore focus (rule R8) must capture the REAL node.
export namespace Focus {
  /** The deepest focused element, crossing shadow boundaries; `null` when
   * nothing but the body has focus. */
  export function activeDeep(): Option<HTMLElement> {
    let $a: Option<Element> = document.activeElement;
    while ($a?.shadowRoot?.activeElement != null) $a = $a.shadowRoot.activeElement;
    if ($a == null || $a === document.body || !($a instanceof HTMLElement)) return null;
    return $a;
  }

  /** True when focus is nowhere, on the body, or inside `$within`. */
  export function isLostOrWithin($within: Element): boolean {
    const $a = activeDeep();
    if ($a == null) return true;
    // Walk hosts outward: a node inside `$within`'s shadow tree counts too.
    let $n: Option<Node> = $a;
    while ($n != null) {
      if ($n === $within) return true;
      $n = $n.parentNode ?? ($n instanceof ShadowRoot ? $n.host : null);
    }
    return false;
  }
}
