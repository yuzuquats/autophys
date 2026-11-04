import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({ name: "std-pill-select" })
export class PillSelect<T extends string> extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");

  private selectedValue: Option<T> = null;
  private entries: PillSelect.Item<T>[] = [];
  onSelected?: (value: T) => void;

  get selectedIdentifier(): Option<T> {
    return this.selectedValue;
  }

  connectedCallback(): void {
    this.$container.setAttribute("role", "radiogroup");
  }

  bind(selected: T, entries: PillSelect.Item<T>[]): this {
    this.selectedValue = selected;
    this.entries = entries;
    this.render();
    return this;
  }

  setSelected(value: T, notify: boolean = false): void {
    if (this.selectedValue === value) return;
    this.selectedValue = value;
    this.updateSelectedState();
    if (notify) {
      this.onSelected?.(value);
    }
  }

  private render(): void {
    DomUtils.clearChildren(this.$container);

    for (const entry of this.entries) {
      const $pill = document.createElement("button");
      $pill.className = "pill";
      $pill.setAttribute("data-value", entry.identifier);
      $pill.setAttribute("role", "radio");
      $pill.setAttribute(
        "aria-checked",
        String(entry.identifier === this.selectedValue),
      );
      $pill.textContent = entry.label;

      if (entry.identifier === this.selectedValue) {
        $pill.classList.add("selected");
      }

      GESTURE_MANAGER.addPointerEvent($pill, {
        onClick: () => {
          this.selectedValue = entry.identifier;
          this.updateSelectedState();
          this.onSelected?.(entry.identifier);
        },
      });

      this.$container.appendChild($pill);
    }
  }

  private updateSelectedState(): void {
    for (const $pill of this.$container.querySelectorAll(".pill")) {
      const value = $pill.getAttribute("data-value");
      const isSelected = value === this.selectedValue;
      $pill.classList.toggle("selected", isSelected);
      $pill.setAttribute("aria-checked", String(isSelected));
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #container {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .pill {
        border: none;
        background: var(--bg-surface-light);
        color: var(--text-sec);
        padding: 6px 12px;
        border-radius: 16px;
        cursor: pointer;
        font-family: inherit;
        font-size: var(--text-13px);
        transition: background-color 0.15s ease, color 0.15s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }

      .pill:hover {
        background: var(--divider);
      }

      .pill.selected {
        background: var(--blue);
        color: var(--text-pri-inv);
      }

      .pill.selected:hover {
        background: var(--blue);
      }

      .pill:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`<div id="container"></div>`;
}

export namespace PillSelect {
  export type Item<T extends string> = {
    label: string;
    identifier: T;
  };
}
