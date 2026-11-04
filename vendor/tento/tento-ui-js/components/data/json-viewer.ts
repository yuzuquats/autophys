import { LonaWebComponent, html } from "@tento-ui/component";
import { Div } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Lisp } from "@tento-lisp/lisp";
import { AngleRightIcon, LonaIcons } from "@tento-ui/ui/icons";
import { Typography } from "@tento-ui/ui/typography";

function span(className: string, textContent: string): HTMLSpanElement {
  const $span = document.createElement("span");
  $span.className = className;
  $span.textContent = textContent;
  return $span;
}

function renderPrimitive(text: string, type: string): HTMLElement {
  return span(`json-${type}`, text);
}

@component({
  name: "std-json-viewer",
})
export class JsonViewer extends LonaWebComponent {
  private expandedPaths = new Set<string>();
  private currentData: Option<Lisp.Atom> = null;
  private expandAll = false;

  bind(data: Lisp.Atom, options?: { expandAll?: boolean }) {
    this.currentData = data;
    this.expandAll = options?.expandAll ?? false;
    this.render();
  }

  private render() {
    const $root = this.$("root");
    DomUtils.clearChildren($root);

    if (this.currentData === null) return;

    const $content = this.renderValue(this.currentData, "", 0);
    $root.appendChild($content);
  }

  private renderValue(
    value: unknown,
    path: string,
    depth: number,
  ): HTMLElement {
    if (value === null) {
      return renderPrimitive("null", "null");
    }

    if (value === undefined) {
      return renderPrimitive("undefined", "null");
    }

    if (typeof value === "string") {
      return renderPrimitive(`"${value}"`, "string");
    }

    if (typeof value === "number") {
      return renderPrimitive(String(value), "number");
    }

    if (typeof value === "boolean") {
      return renderPrimitive(String(value), "boolean");
    }

    if (Array.isArray(value)) {
      return this.renderArray(value, path, depth);
    }

    if (typeof value === "object") {
      return this.renderObject(value as Record<string, unknown>, path, depth);
    }

    return renderPrimitive(String(value), "unknown");
  }

  private renderArray(
    arr: unknown[],
    path: string,
    depth: number,
  ): HTMLElement {
    const isExpanded = this.expandedPaths.has(path);
    const shouldPartiallyCollapse = arr.length > 6 && !isExpanded && !this.expandAll;

    const $container = Div.make();
    $container.className = "json-nested-container";

    // For root level arrays, we need to add brackets
    if (!path) {
      $container.appendChild(span("json-bracket", "["));
    }

    if (arr.length <= 0) {
      if (!path) {
        $container.appendChild(span("json-bracket", "]"));
      }
      return $container;
    }

    // 1) Add items
    const $items = Div.make();
    $container.appendChild($items);
    {
      $items.className = "json-items";

      // Show first 4 items when partially collapsed, all when expanded
      const itemsToShow = shouldPartiallyCollapse ? 4 : arr.length;

      arr.slice(0, itemsToShow).forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        const $item = Typography.p("");
        $item.className = "json-array-item";

        // For nested arrays/objects in arrays, we need to render brackets inline
        if (item !== null && typeof item === "object") {
          const openChar = Array.isArray(item) ? "[" : "{";
          $item.appendChild(span("json-bracket", openChar));

          const $value = this.renderValue(item, itemPath, depth + 1);
          $item.appendChild($value);

          const closeChar = Array.isArray(item) ? "]" : "}";
          $item.appendChild(span("json-bracket", closeChar));
        } else {
          const $value = this.renderValue(item, itemPath, depth + 1);
          $item.appendChild($value);
        }

        if (index < itemsToShow - 1 || shouldPartiallyCollapse) {
          $item.appendChild(span("json-punctuation", ","));
        }

        $items.appendChild($item);
      });
    }

    if (shouldPartiallyCollapse) {
      // 2) Add collapsed
      // Add "...N more items" indicator
      if (arr.length - 4 > 0) {
        const $collapsed = Div.make();
        $collapsed.className = "json-array-item";

        const $indicator = span(
          "json-collapsed",
          `.. [${arr.length - 4} more items]`,
        );

        GESTURE_MANAGER.addPointerEvent($indicator, {
          onClick: () => {
            this.expandedPaths.add(path);
            this.render();
          },
        });
        $indicator.classList.add("clickable");

        $collapsed.appendChild($indicator);
        $items.appendChild($collapsed);
      }
    }

    // For root level arrays, add closing bracket
    if (!path) {
      $container.appendChild(span("json-bracket", "]"));
    }

    return $container;
  }

  private renderObject(
    obj: Record<string, unknown>,
    path: string,
    depth: number,
  ): HTMLElement {
    const entries = Object.entries(obj);
    const isExpanded = this.expandedPaths.has(path);
    const shouldPartiallyCollapse =
      (entries.length > 6 || depth > 2) && !isExpanded && !this.expandAll;

    const $container = Div.make();
    $container.className = "json-nested-container";

    // For root level objects, we need to add brackets
    if (!path) {
      $container.appendChild(span("json-bracket", "{"));
    }

    if (entries.length <= 0) {
      if (!path) {
        $container.appendChild(span("json-bracket", "}"));
      }
      return $container;
    }

    // 1) Add items
    const $items = Div.make();
    $container.appendChild($items);
    {
      $items.className = "json-items";

      // Show first 4 properties when partially collapsed, all when expanded
      const itemsToShow = shouldPartiallyCollapse ? 4 : entries.length;

      entries.slice(0, itemsToShow).forEach(([key, value], index) => {
        const itemPath = `${path}.${key}`;
        const hasComma = index < itemsToShow - 1 || shouldPartiallyCollapse;
        const $item = this.renderObjectItem(
          key,
          value,
          itemPath,
          depth + 1,
          hasComma,
        );
        $items.appendChild($item);
      });
    }

    if (shouldPartiallyCollapse) {
      // 2) Add collapsed
      // Add "...N more items" indicator
      if (entries.length - 4 > 0) {
        const $collapsed = Div.make();
        $collapsed.className = "json-item";

        const $keyLine = Div.make();
        $keyLine.className = "json-key-line";

        const $indicator = span(
          "json-collapsed",
          `.. [${entries.length - 4} more properties]`,
        );

        GESTURE_MANAGER.addPointerEvent($indicator, {
          onClick: () => {
            this.expandedPaths.add(path);
            this.render();
          },
        });
        $indicator.classList.add("clickable");

        $keyLine.appendChild($indicator);
        $collapsed.appendChild($keyLine);
        $items.appendChild($collapsed);
      }
    }

    // For root level objects, add closing bracket
    if (!path) {
      $container.appendChild(span("json-bracket", "}"));
    }

    return $container;
  }

  private renderObjectItem(
    key: string,
    value: unknown,
    path: string,
    depth: number,
    hasComma: boolean,
  ): HTMLElement {
    const $item = Div.make();
    $item.className = "json-item";

    const $keyLine = Div.make();
    $keyLine.className = "json-key-line";
    $item.appendChild($keyLine);

    if (value == null) {
      // For null/undefined, still render the key
      $keyLine.appendChild(span("json-key", `"${key}"`));
      $keyLine.appendChild(span("json-punctuation", ": "));
      const $value = this.renderValue(value, path, depth + 1);
      $keyLine.appendChild($value);
      if (hasComma) {
        $keyLine.appendChild(span("json-punctuation", ","));
      }
      return $item;
    }

    const isExpandable = value !== null && typeof value === "object";
    const itemCount = Array.isArray(value)
      ? value.length
      : Object.keys(value as object).length;
    const canCollapse = isExpandable && (itemCount > 6 || depth > 2) && !this.expandAll;

    if (canCollapse) {
      const $chevron = LonaIcons.make(AngleRightIcon, { sizePx: 12 });
      $chevron.classList.add("json-chevron");

      const isOpen =
        this.expandedPaths.has(path) || (depth <= 2 && itemCount <= 6);
      $chevron.style.transform =
        "translate(3px, -1px)" + (isOpen ? " rotate(90deg)" : "");

      GESTURE_MANAGER.addPointerEvent($chevron, {
        onClick: () => {
          if (this.expandedPaths.has(path)) {
            this.expandedPaths.delete(path);
          } else {
            this.expandedPaths.add(path);
          }
          this.render();
        },
      });

      $keyLine.appendChild($chevron);
    }
    $keyLine.appendChild(span("json-key", `"${key}"`));
    $keyLine.appendChild(span("json-punctuation", ": "));

    if (isExpandable) {
      // Add opening bracket on same line with space
      const openChar = Array.isArray(value) ? "[" : "{";
      $keyLine.appendChild(span("json-bracket", openChar));

      // Render nested content
      const $nestedValue = this.renderValue(value, path, depth + 1);
      $item.appendChild($nestedValue);

      // Closing bracket on its own line
      const closeChar = Array.isArray(value) ? "]" : "}";
      const $closeLine = Div.make();
      $closeLine.className = "json-close-line";
      $closeLine.appendChild(span("json-bracket", closeChar));
      if (hasComma) {
        $closeLine.appendChild(span("json-punctuation", ","));
      }

      $item.appendChild($closeLine);
    } else {
      // For primitives, render value inline
      const $value = this.renderValue(value, path, depth + 1);
      $keyLine.appendChild($value);
      if (hasComma) {
        $keyLine.appendChild(span("json-punctuation", ","));
      }
    }
    return $item;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        font-family: monospace, monospace;
        --font-size: var(--text-8px);
        --margin-top: 4px;
        --margin-bottom: 4px;
      }

      #root {
        position: relative;
        min-width: 120px;
      }

      .json-container {
        display: flex;
        flex-direction: column;
      }

      .json-nested-container {
        display: flex;
        flex-direction: column;
      }

      .json-value-wrapper {
        display: flex;
        flex-direction: column;
        margin-left: 10px;
      }

      .json-items {
        display: flex;
        flex-direction: column;
        margin-left: 10px;
      }

      .json-item {
        display: flex;
        flex-direction: column;
        position: relative;
      }

      .json-array-item {
        --font-size: var(--text-8px);
      }

      .json-key-line {
        display: flex;
        flex-direction: row;
      }

      .json-close-line {
      }

      .json-chevron {
        position: absolute;
        left: -16px;
        top: 1px;
        cursor: pointer;
        transition: transform 0.3s ease, opacity 0.3s ease;
        color: var(--text-ter);
        opacity: 0.5;
        flex-shrink: 0;
      }

      .json-chevron:hover {
        color: var(--text-sec);
        opacity: 1;
      }

      .json-key {
        color: var(--blue);
      }

      .json-string {
        color: var(--green);
        line-break: anywhere;
      }

      .json-number {
        color: var(--orange);
      }

      .json-boolean {
        color: var(--purple);
      }

      .json-null {
        color: var(--red);
      }

      .json-unknown {
        color: var(--text-ter);
      }

      .json-punctuation {
        color: var(--text-ter);
        margin-right: 6px;
      }

      .json-bracket {
        color: var(--text-sec);
      }

      .json-collapsed {
        color: var(--text-ter);
        font-style: italic;
      }

      .json-collapsed.clickable {
        cursor: pointer;
      }

      .json-collapsed.clickable:hover {
        color: var(--text-sec);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root" class=spanned-typography></div>
  `;
}
