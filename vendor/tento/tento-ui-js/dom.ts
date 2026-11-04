import { nonnull } from "@tento-core/assert";
import { $$ } from "./fastdom";
import { Tracing } from "@tento-core/tracing";
import { Vector } from "@tento-core/point";
import { NumRangeLike } from "@tento-core/range";
import { Session } from "./session";
import { DomFlags } from "./dom-flags";

interface Recyclable extends HTMLElement {
  recycle(): void;
}

function isRecyclable(el: Element): el is Recyclable {
  return "recycle" in el && typeof (el as Recyclable).recycle === "function";
}

export const getAttributeNumber = (
  $e: HTMLElement,
  attributeName: string,
  defaultValue: number | null = null,
): number | null => {
  const val = $e.getAttribute(attributeName);
  if (!val) return defaultValue ?? null;
  const numVal = Number.parseInt(val);
  if (Number.isNaN(numVal)) return defaultValue ?? null;
  return numVal;
};

export const getAttributeNumberNonnull = (
  $e: HTMLElement,
  attributeName: string,
  defaultValue: number | null = null,
): number => {
  return nonnull(getAttributeNumber($e, attributeName, defaultValue));
};

export const toggleAttributeValue = <T>(
  $e: HTMLElement,
  key: string,
  value: Option<T>,
) => {
  value ? $e.setAttribute(key, String(value)) : $e.removeAttribute(key);
};

export const getPropertyValueDefault = (
  $element: HTMLElement,
  key: string,
  defaultValue: string,
) => {
  const value = $element.style.getPropertyValue(key);
  return value !== "" ? value : defaultValue;
};

export const createScrollboxObserver = (
  $topEdge: HTMLElement,
  $bottomEdge: HTMLElement,
  $target: HTMLElement,
  $root: HTMLElement,
): IntersectionObserver => {
  const observer = new IntersectionObserver(
    ([entry]) => {
      const intersect = entry.intersectionRatio !== 1;
      if (entry.target === $topEdge) {
        $target.toggleAttribute("shadow-top", intersect);
      } else if (entry.target === $bottomEdge) {
        $target.toggleAttribute("shadow-bottom", intersect);
      }
    },
    {
      root: $root,
    },
  );
  observer.observe($topEdge);
  observer.observe($bottomEdge);
  return observer;
};

export namespace DomUtils {
  export function removeFromDom(
    $e: Option<HTMLElement | Element>,
    recycle: boolean = true,
  ) {
    if (!recycle) {
      $e?.parentElement?.removeChild($e);
      return;
    }
    if ($e && isRecyclable($e)) {
      $e.parentElement?.removeChild($e);
      $e.recycle();
      return;
    }
    $e?.parentElement?.removeChild($e);
  }

  function getMeasureName(): string {
    if ($$.isFlushing() || Session.isMacOs) {
      return "[dom-utils/clear-children]";
    }
    const err = new Error();
    return `[dom-utils/clear-children] ${err.stack?.split("\n")[3].trim()}`;
  }

  /**
   * `debug-flag:dom-timing-marks` (`?flag:dom-timing-marks=` URL override,
   * else localStorage; default off): wrap `clearChildren` and component
   * recycling in performance marks and a measure named after the caller, for
   * a devtools timeline recording. Off by default because nothing reads the
   * entries but a live recording (they are cleared right after they are
   * made), while making them — two marks, a measure, three clears and, off a
   * fastdom flush on non-mac, an `Error().stack` for the name — cost about
   * 50 ms per scroll burst on the bench calendar, where the all-day overflow
   * indicators cleared their children on every scroll step (project
   * sheet-scroll-smoothness, 2026-09-12). Read once per page load like every
   * other debug flag; read lazily so DOM-less test imports never touch
   * `window`.
   */
  export function timingMarksEnabled(): boolean {
    return DomFlags.read("dom-timing-marks", false);
  }

  export function recycleSync(elements: Element[]) {
    for (const $child of elements) {
      if (!isRecyclable($child)) continue;
      $child.recycle();
    }
  }

  export function clearChildren($parent: HTMLElement, recycle: boolean = true) {
    if ($parent.children.length === 0) return;
    const $children = [...$parent.children];

    if (timingMarksEnabled()) {
      const measureName = getMeasureName();
      performance.mark("[dom-utils/clear-children] start");
      $parent.innerHTML = "";
      performance.mark("[dom-utils/clear-children] end");
      performance.measure(
        measureName,
        "[dom-utils/clear-children] start",
        "[dom-utils/clear-children] end",
      );
      performance.clearMarks("[dom-utils/clear-children] start");
      performance.clearMarks("[dom-utils/clear-children] end");
      performance.clearMeasures(measureName);
    } else {
      $parent.innerHTML = "";
    }
    if (!recycle) return;
    $$.defer(() => {
      for (const $child of $children) {
        if (!isRecyclable($child)) continue;
        $child.recycle();
      }
    });
  }

  export function reconcileChildren(
    $parent: HTMLElement,
    desiredChildren: HTMLElement[],
  ): void {
    const currentChildren = Array.from($parent.children) as HTMLElement[];
    const currentChildrenSet = new Set(currentChildren);
    const desiredChildrenSet = new Set(desiredChildren);

    for (const child of currentChildren) {
      if (!desiredChildrenSet.has(child)) {
        $parent.removeChild(child);
      }
    }

    let expectedNextSibling: ChildNode | null = $parent.firstChild;
    for (const child of desiredChildren) {
      const isNewChild = !currentChildrenSet.has(child);
      if (isNewChild) {
        if (expectedNextSibling) {
          $parent.insertBefore(child, expectedNextSibling);
        } else {
          $parent.appendChild(child);
        }
        expectedNextSibling = child.nextSibling;
        continue;
      }

      if (child !== expectedNextSibling) {
        if (expectedNextSibling) {
          $parent.insertBefore(child, expectedNextSibling);
        } else {
          $parent.appendChild(child);
        }
      }
      expectedNextSibling = child.nextSibling;
    }
  }

  export function toggleInteractable($e: HTMLElement, force: boolean) {
    $e.style.userSelect = force ? "all" : "none";
    $e.style.pointerEvents = force ? "all" : "none";
  }

  export const setEndOfContenteditable = ($e: HTMLElement) => {
    if (!document.createRange) return;

    //Firefox, Chrome, Opera, Safari, IE 9+
    const range = document.createRange(); //Create a range (a range is a like the selection but invisible)
    range.selectNodeContents($e); //Select the entire contents of the element with the range
    range.collapse(false); //collapse the range to the end point. false means collapse to end rather than the start
    const selection = globalThis.getSelection() as Selection; //get the selection object (allows you to change selection)
    selection.removeAllRanges(); //remove any selections already made
    selection.addRange(range); //make the range you have just created the visible selection
  };

  export function appendTemplate(
    $e: HTMLElement | DocumentFragment,
    t: HTMLTemplateElement,
  ): HTMLElement {
    $e.appendChild(t.content.cloneNode(true));
    return $e.lastElementChild as HTMLElement;
  }

  export function hasAncestor(
    $e: HTMLElement,
    $ancestor: HTMLElement,
  ): boolean {
    // dbg($e, $ancestor, $ancestor.childElementCount);
    let node: Option<Node> = $e;
    while (node) {
      if (node === $ancestor) {
        return true;
      } else if (node instanceof ShadowRoot) {
        node = node.host;
      } else {
        node = node.parentNode;
      }
    }
    return node === $ancestor;
  }

  export function visitAncestors($e: HTMLElement, visit: ($e: Node) => void) {
    let node: Option<Node> = $e;
    while (node) {
      visit(node);
      if (node instanceof ShadowRoot) {
        node = node.host;
      } else {
        node = node.parentNode;
      }
    }
  }

  export function getAncestors($element: HTMLElement): HTMLElement[] {
    const ancestors: HTMLElement[] = [];
    let $parent = $element.parentNode;
    while ($parent) {
      if ($parent instanceof HTMLElement) {
        ancestors.push($parent);
      }
      if ($parent instanceof ShadowRoot) {
        $parent = $parent.host;
      } else {
        $parent = $parent.parentNode;
      }
    }
    return ancestors;
  }

  export function flipAnimationWithRect(
    $e: HTMLElement,
    before: DOMRect,
    after: DOMRect,
    durationMs: number = 300,
    offset: Option<Vector> = null,
    additive: boolean = false,
  ): Animation {
    const delta = {
      x: before.left - after.left + (offset?.x ?? 0),
      y: before.top - after.top + (offset?.y ?? 0),
    };
    return $e.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${delta.x}px, ${delta.y}px)`,
        },
        {
          transformOrigin: "top left",
          transform: additive ? "translate(0, 0)" : "none",
        },
      ],
      {
        duration: durationMs,
        easing: "ease",
        fill: additive ? "none" : "both",
        composite: additive ? "add" : "replace",
      },
    );
  }

  function flipAnimationRaw(
    $es: HTMLElement[],
    bind: Option<EmptyFunction>,
    durationMs: number = 300,
    offset: Option<Vector> = null,
    onComplete: Option<EmptyFunction> = null,
    onAnimation: Option<EmptyFunction> = null,
  ) {
    const before = $es.map(($e) => $e.getBoundingClientRect());
    bind &&
      $$.mutate(() => {
        bind();
      });
    $$.defer(() => {
      const after = $es.map(($e) => $e.getBoundingClientRect());
      for (const [i, $e] of $es.entries()) {
        onAnimation?.();
        const animation = DomUtils.flipAnimationWithRect(
          $e,
          before[i],
          after[i],
          durationMs,
          offset,
        );
        animation.onfinish = onComplete;
      }
    });
  }

  export function flipAnimation(
    $es: HTMLElement[],
    bind: Option<EmptyFunction> = null,
    options?: Optional<{
      shouldMeasure: boolean;
      durationMs: number;
      offset: Vector;
      onComplete: EmptyFunction;
      onAnimation: EmptyFunction;
    }>,
  ) {
    options?.shouldMeasure
      ? $$.measure(() =>
          flipAnimationRaw(
            $es,
            bind,
            options.durationMs ?? 300,
            options.offset,
            options.onComplete,
            options.onAnimation,
          ),
        )
      : flipAnimationRaw(
          $es,
          bind,
          options?.durationMs ?? 300,
          options?.offset,
          options?.onComplete,
          options?.onAnimation,
        );
  }

  export function registerEditableNumberElement(
    $e: HTMLElement,
    onValidNumber: (n: Option<number>) => void,
    bounds: NumRangeLike = {
      start: Number.MIN_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
    },
  ) {
    registerKeyListeners($e, {
      onTextChangeDEPRECATED: (t) => {
        if (t == null || t === "") {
          onValidNumber(null);
          return;
        }
        $e.toggleAttribute("invalid", !/^[0-9]*$/.test(t));
        const num = Number.parseInt(t ?? "");
        const invalid = $e.toggleAttribute(
          "invalid",
          Number.isNaN(num) || num < bounds.start || num > bounds.end,
        );
        if (invalid) {
          return;
        }
        onValidNumber(num);
      },
      onEnterKey: () => {},
    });
  }

  export function registerKeyListeners(
    $e: HTMLElement,
    options: {
      onTextChangeDEPRECATED?: Option<(t: Option<string>) => void>;
      onArrowKeyHorizontal?: Option<(key: "ArrowLeft" | "ArrowRight") => void>;
      onArrowKeyVertical?: Option<(key: "ArrowDown" | "ArrowUp") => void>;
      onEnterKey?: Option<(t: Option<string>) => void>;
    },
  ) {
    $e.onkeydown = (e) => {
      if (e.key === "Enter") e.preventDefault();
      else if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        options.onArrowKeyHorizontal
      ) {
        options.onArrowKeyHorizontal(e.key);
        e.preventDefault();
      } else if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        options.onArrowKeyVertical
      ) {
        options.onArrowKeyVertical(e.key);
        e.preventDefault();
      } else if (e.key === "Escape") {
        $e.blur();
      } else if (options.onTextChangeDEPRECATED) {
        e.stopPropagation();
      }
    };
    $e.onkeyup = (e) => {
      if (e.key === "Enter") {
        options.onEnterKey?.($e.textContent);
        $e.blur();
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (options.onArrowKeyHorizontal) {
          e.preventDefault();
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (options.onArrowKeyVertical) {
          e.preventDefault();
        }
      } else {
        options.onTextChangeDEPRECATED?.($e.textContent?.trim());
      }
    };
  }

  export function hotkeyIdentifier(e: KeyboardEvent): Option<string> {
    if (e.key === "Shift" || e.key === "Ctrl" || e.key === "Meta") return null;
    return (
      (e.shiftKey ? "shift-" : "") +
      (e.ctrlKey ? "ctrl-" : "") +
      (e.metaKey ? "cmd-" : "") +
      e.key
    );
  }

  export async function importScript(url: string): Promise<void> {
    return new Promise((resolve, _reject) => {
      const script = document.createElement("script");
      script.setAttribute("src", url);
      script.onload = () => resolve();
      document.head.appendChild(script);
    });
  }

  export function importSvgs(svgs: string[]): string {
    return /* xml */ `
      <svg style="display: none" version="2.0">
        <defs>
          ${svgs.join(" ")}
        </defs>
      </svg>
    `;
  }

  export function setSelected(
    $els: NodeListOf<HTMLElement>,
    isSelected: ($e: HTMLElement) => boolean,
    attribute: string = "selected",
  ) {
    for (const $el of $els) {
      $el.toggleAttribute(attribute, isSelected($el));
    }
  }

  export function assignAttributes<T extends HTMLElement>(
    $e: T,
    attributes: { [k: string]: Option<string> | boolean },
  ): T {
    // Diff before writing: this is the per-cell hot path (a full rebind funnels
    // ~10 attributes per cell through here), and an identical-value
    // `setAttribute` still runs the attribute-changed machinery — reads are
    // free of style/layout work, writes are not. `toggleAttribute(k, force)`
    // is already a spec-level no-op when the state matches.
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "boolean") {
        $e.toggleAttribute(key, value);
        continue;
      }
      if (value == null) {
        if ($e.hasAttribute(key)) $e.removeAttribute(key);
      } else if ($e.getAttribute(key) !== value) {
        $e.setAttribute(key, value);
      }
    }
    return $e;
  }

  export function slotChildren($e: HTMLSlotElement): HTMLElement[] {
    return $e
      .assignedNodes()
      .filter((node) => node instanceof HTMLElement)
      .map((e) => e as HTMLElement);
  }

  export function findOverflowParent($e: HTMLElement) {
    let $parent = $e.parentElement;
    while ($parent) {
      Tracing.dbg("parent: ", $parent);
      if ($parent.style.overflow != null && $parent.style.overflow != null) {
        Tracing.err("ui")(
          "found overflow parent",
          $parent,
          $parent.style.overflow,
        );
      }
      $parent = $parent.parentElement;
    }
  }

  export function hydrate<T extends HTMLElement>($from: HTMLElement): T {
    customElements.upgrade($from);
    return $from as T;
  }

  /**
   * Waits for all custom elements to be defined, upgrades them, then reveals the page.
   * Call this at the end of page root scripts that use `body { opacity: 0 }`.
   *
   * @param $container - Element to search for custom elements (default: document.body)
   * @param prefixes - Tag prefixes to upgrade (default: ["std-", "lona-"])
   */
  // Tags that use custom element naming but are styled with CSS only (no JS component)
  const CSS_ONLY_TAGS = new Set([
    "std-col",
    "std-row",
    "std-spacer",
    "std-center",
    "std-section-960",
  ]);

  export async function hydrateAndReveal(
    $container: HTMLElement = document.body,
    prefixes: string[] = ["std-", "lona-"],
    skipTags: string[] = [],
  ): Promise<void> {
    const skip = skipTags.length
      ? new Set([...CSS_ONLY_TAGS, ...skipTags])
      : CSS_ONLY_TAGS;
    // Collect all unique custom element tags (excluding CSS-only tags)
    const tags = new Set<string>();
    for (const $el of $container.querySelectorAll("*")) {
      const tag = $el.tagName.toLowerCase();
      if (skip.has(tag)) continue;
      for (const prefix of prefixes) {
        if (tag.startsWith(prefix)) {
          tags.add(tag);
          break;
        }
      }
    }

    // Wait for all custom element definitions to be registered
    await Promise.all([...tags].map((tag) => customElements.whenDefined(tag)));

    // Synchronously upgrade all elements now that definitions exist
    for (const $el of $container.querySelectorAll("*")) {
      const tag = $el.tagName.toLowerCase();
      if (tags.has(tag)) {
        customElements.upgrade($el);
      }
    }

    // Single frame to let browser paint, then reveal
    requestAnimationFrame(() => {
      $container.style.opacity = "1";
    });
  }
}
