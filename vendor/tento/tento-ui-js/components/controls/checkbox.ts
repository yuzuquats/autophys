import "../list/list-cell-layout";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { CheckmarkIcon, LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ListCellLayout } from "../list/list-cell-layout";

@component({
  name: "std-checkbox",
})
export class Checkbox extends LonaWebComponent {
  private $checkbox = this.hydrate("checkbox");
  private $checkmark = this.hydrate("checkmark");

  checked: boolean = false;
  disabled: boolean = false;
  onChange?: Option<(checked: boolean) => void>;

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.toggle();
    }
  };

  connectedCallback(): void {
    // Set up ARIA attributes
    this.$checkbox.setAttribute("role", "checkbox");
    this.$checkbox.setAttribute("tabindex", "0");
    this.updateAriaChecked();

    GESTURE_MANAGER.addPointerEvent(this.$checkbox, {
      onClick: () => this.toggle(),
    });

    // Keyboard support for Space and Enter
    this.$checkbox.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    this.$checkbox.removeEventListener("keydown", this.handleKeydown);
    GESTURE_MANAGER.unregister(this.$checkbox);
  }

  private toggle(): void {
    if (this.disabled) return;
    this.setChecked(!this.checked);
    this.onChange?.(this.checked);
  }

  private updateAriaChecked(): void {
    this.$checkbox.setAttribute("aria-checked", String(this.checked));
  }

  /** The accessible name of the `role=checkbox` node, which lives in this
   * shadow root where an embedder's `aria-labelledby` cannot reach it. */
  setLabel(label: Option<string>): void {
    if (label) {
      this.$checkbox.setAttribute("aria-label", label);
    } else {
      this.$checkbox.removeAttribute("aria-label");
    }
  }

  bind(props: {
    checked?: boolean;
    disabled?: boolean;
    round?: boolean;
    onChange?: Option<(checked: boolean) => void>;
  }): this {
    this.onChange = props.onChange;
    this.disabled = props.disabled ?? false;

    if (this.disabled) {
      this.setAttribute("disabled", "");
    } else {
      this.removeAttribute("disabled");
    }

    if (props.round) {
      this.setAttribute("round", "");
    } else {
      this.removeAttribute("round");
    }

    if (props.checked != null) {
      this.setChecked(props.checked);
    }
    return this;
  }

  setChecked(checked: boolean): void {
    this.checked = checked;
    this.updateAriaChecked();

    if (checked) {
      this.setAttribute("checked", "");
      DomUtils.clearChildren(this.$checkmark);
      const icon = LonaIcons.make(CheckmarkIcon, {
        color: "white",
      });
      icon.style.height = "calc(var(--size, 18px) - 4px)";
      icon.style.width = "calc(var(--size, 18px) - 4px)";
      this.$checkmark.appendChild(icon);
    } else {
      this.removeAttribute("checked");
      DomUtils.clearChildren(this.$checkmark);
    }
  }

  static makeWith(props: {
    checked?: boolean;
    disabled?: boolean;
    round?: boolean;
    onChange?: (checked: boolean) => void;
  }): Checkbox {
    const instance = Checkbox.make();
    instance.bind(props);
    return instance;
  }

  static $styles = [
    css`
      :host {
        display: inline-flex;
        align-items: center;
        cursor: pointer;
        user-select: none;
        width: var(--size, 18px);
        /* A slotted width from the embedder (a form sets auto) beats :host,
           and the box inside is 100% of this; the floor keeps it a box. */
        min-width: var(--size, 18px);
        height: var(--size, 18px);
        flex-shrink: 0;
      }

      #checkbox {
        position: relative;
        width: 100%;
        height: 100%;
        border: 2px solid var(--divider);
        border-radius: 4px;
        background-color: var(--bg);
        transition: all 0.15s ease;
      }

      :host([checked]) #checkbox {
        background-color: var(--blue);
        border-color: var(--blue);
      }

      :host([disabled]) {
        cursor: not-allowed;
        opacity: 0.5;
      }

      :host(:not([disabled]):hover) #checkbox {
        border-color: var(--blue);
      }

      :host([round]) #checkbox {
        border-radius: 50%;
      }

      #checkbox:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #checkmark {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: none;
        color: var(--text-pri-inv);
        width: calc(0.6 * var(--size));
        height: calc(0.6 * var(--size));
        width: calc(var(--size, 18px) - 4px);
        height: calc(var(--size, 18px) - 4px);
      }

      :host([checked]) #checkmark {
        display: flex;
      }

    `,
  ];

  static $html = html`
    <div id="checkbox">
      <div id="checkmark"></div>
    </div>
  `;
}

export namespace Checkbox {
  @component({
    name: "std-checkbox-cell",
  })
  export class Cell extends LonaWebComponent {
    private $layout: ListCellLayout = this.hydrate("layout");
    private $checkbox: Checkbox = this.hydrate("checkbox");
    $subtitle: Option<HTMLElement>;

    private onCheckedChanged?: ((cell: Cell, checked: boolean) => void) | undefined;

    get $content(): HTMLElement {
      return this.$layout.$content;
    }

    get checked(): boolean {
      return this.$checkbox.checked;
    }

    set checked(value: boolean) {
      this.$checkbox.setChecked(value);
    }

    setDisabled(disabled: boolean): void {
      this.$checkbox.disabled = disabled;
      if (disabled) {
        this.setAttribute("disabled", "");
      } else {
        this.removeAttribute("disabled");
      }
    }

    bind(props: Cell.Props): this {
      const $contentCol = this.$("content-col");

      // Create and append title. A rich title (inline code, links) replaces
      // the plain paragraph; `title` stays its accessible name.
      const $title = props.options?.$title ?? Typography.p(props.title);
      $title.assignStyles({
        color: "var(--text-sec)",
        "--margin-bottom": "4px",
      });
      // Reconcile by identity: clearing first would schedule a reused
      // component title or subtitle for deferred recycling.
      const children = [$title];
      if (props.options?.$subtitle) children.push(props.options.$subtitle);
      DomUtils.reconcileChildren($contentCol, children);
      this.$subtitle = props.options?.$subtitle;
      this.$checkbox.setLabel(props.title);

      // Set initial checked state if provided
      if (props.options?.checked != null) {
        this.$checkbox.setChecked(props.options.checked);
      }

      // Set disabled state if provided
      if (props.options?.disabled != null) {
        this.$checkbox.disabled = props.options.disabled;
      }

      // Set callback
      this.onCheckedChanged = props.options?.onCheckedChanged ?? undefined;

      return this;
    }

    static makeWith(props: Cell.Props): Cell {
      const $cell = Cell.make();
      $cell.bind(props);
      return $cell;
    }

    connectedCallback() {
      // Handle click on entire cell
      GESTURE_MANAGER.addPointerEvent(this.$layout, {
        onClick: () => {
          if (!this.$checkbox.disabled) {
            // Toggle the checkbox state
            const newChecked = !this.$checkbox.checked;
            this.$checkbox.setChecked(newChecked);
            // Notify parent with new state
            this.onCheckedChanged?.(this, newChecked);
          }
        },
      });

      // Bypass the row gesture before pointer-down can cancel native focus
      // or caret placement. The same filter on release prevents row toggles.
      const pointerDown = this.$layout.onpointerdown;
      const pointerUp = this.$layout.onpointerup;
      this.$layout.onpointerdown = (event) => {
        if (!this.isInteractiveTitleEvent(event)) {
          pointerDown?.call(this.$layout, event);
        }
      };
      this.$layout.onpointerup = (event) => {
        if (!this.isInteractiveTitleEvent(event)) {
          pointerUp?.call(this.$layout, event);
        }
      };

      // Override Checkbox's default behavior to prevent double-toggling
      this.$checkbox.onChange = (checked: boolean) => {
        // The checkbox already changed its state, just notify parent
        this.onCheckedChanged?.(this, checked);
      };
    }

    private isInteractiveTitleEvent(event: PointerEvent): boolean {
      // Inspect the composed path so controls inside shadow roots work too.
      for (const target of event.composedPath()) {
        if (target === this.$layout) break;
        if (target instanceof Element && target.matches(
          "a[href], button, input, select, textarea, summary, " +
          "[contenteditable]:not([contenteditable='false']), " +
          "[role='link'], [role='button']",
        )) return true;
      }
      return false;
    }

    disconnectedCallback() {
      GESTURE_MANAGER.unregister(this.$layout);
    }

    static $styles = [
      Button.$style,
      css`
        :host {
          display: block;
          --list-cell-layout-hover-color: transparent;
          cursor: default;
        }

        :host([disabled]) {
          opacity: 0.4;
          pointer-events: none;
        }

        /* The title's first line centers on the box. Typography trims the
           paragraph to its cap height (--p-size), so offsetting the column by
           half the difference puts the cap's middle at the box's middle. */
        #content-col {
          align-items: flex-start;
          gap: 4px;
          margin-top: calc((var(--size, 18px) - var(--p-size)) / 2);
        }

        #checkbox {
          align-items: flex-start;
        }
      `,
    ];

    static $html = html`
      <std-list-cell-layout id="layout">
        <std-checkbox id="checkbox" slot="icon"></std-checkbox>
        <std-col id="content-col" slot="content"></std-col>
      </std-list-cell-layout>
    `;
  }

  export namespace Cell {
    export type Options = Optional<{
      $title: HTMLElement;
      $subtitle: HTMLElement;
      onCheckedChanged: ($cell: Cell, checked: boolean) => void;
      checked: boolean;
      disabled: boolean;
    }>;

    export interface Props {
      title: string;
      options?: Option<Options>;
    }
  }
}
