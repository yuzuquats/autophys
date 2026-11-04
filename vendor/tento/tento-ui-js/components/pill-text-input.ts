import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { LonaIcons, XIcon } from "../ui/icons";
import { Typography } from "../ui/typography";
import { PillButton } from "./pill-button";

@component({ name: "std-pill-text-input" })
export class PillTextInput extends LonaWebComponent {
  private props: Option<PillTextInput.Props>;
  private pills: string[] = [];
  private pendingText: string = "";
  private editable: boolean = true;

  private $container: HTMLElement = this.$("container");
  private $input: HTMLInputElement = this.$("input") as HTMLInputElement;

  constructor() {
    super();
    this.setupEventListeners();
  }

  connectedCallback() {
    super.connectedCallback();
    GESTURE_MANAGER.setOnClickOutside(this, () => {
      this.blur();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    GESTURE_MANAGER.clearOnClickOutside(this);
  }

  bind(props: PillTextInput.Props): void {
    this.props = props;
    this.pills = props?.pills ?? [];
    this.pendingText = props?.pendingText ?? "";
    this.editable = props?.editable ?? true;

    this.renderPills();
    this.$input.value = this.pendingText;
    this.$input.placeholder =
      props?.placeholder ?? "Type and press space or enter...";
    this.$input.style.display = this.editable ? "" : "none";
    this.$input.disabled = !this.editable;
    this.style.cursor = this.editable ? "text" : "default";
  }

  private setupEventListeners(): void {
    GESTURE_MANAGER.addPointerEvent(this.$container, {
      onClick: () => {
        this.$input.focus();
      },
    });

    this.$input.addEventListener("input", () => {
      this.pendingText = this.$input.value;
      this.props?.onPendingTextChange?.(this.pendingText);
    });

    this.$input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return;

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        this.handleDelimiter();
      } else if (
        e.key === "Backspace" &&
        this.pendingText === "" &&
        this.pills.length > 0
      ) {
        e.preventDefault();
        this.removeLastPill();
      }

      e.stopPropagation();
    });

    this.$input.addEventListener("keyup", (e) => {
      e.stopPropagation();
    });

    GESTURE_MANAGER.addPointerEvent(this, {});
  }

  private handleDelimiter(): void {
    const trimmedText = this.pendingText.trim();
    if (trimmedText === "") return;

    if (this.props?.validator && !this.props.validator(trimmedText)) return;

    this.pills.push(trimmedText);
    this.pendingText = "";
    this.$input.value = "";

    this.renderPills();
    this.props?.onChange?.(this.pills);
    this.props?.onPendingTextChange?.("");
  }

  private removeLastPill(): void {
    if (this.pills.length > 0) {
      this.pills.pop();
      this.renderPills();
      this.props?.onChange?.(this.pills);
    }
  }

  private renderPills(): void {
    const existingPills = this.$container.querySelectorAll("std-pill-button");
    for (const pill of existingPills) {
      pill.remove();
    }

    for (let i = 0; i < this.pills.length; i++) {
      const $pill = this.createPill(this.pills[i], i);
      this.$container.insertBefore($pill, this.$input);
    }
  }

  private createPill(text: string, index: number): PillButton {
    const pillOptions: PillButton.Options = {
      padding: this.editable
        ? "var(--input-pill-padding, 6px 6px 6px 12px)"
        : "var(--input-pill-padding, 6px 12px)",
      borderRadius: 16,
      fontSize: "var(--text-14px)",
      background: this.props?.colorFn?.(text) ?? "var(--blue-dimmed)",
    };

    const $pill = PillButton.makeWith(text, pillOptions);
    $pill.setAttribute("data-pill-value", text);
    $pill.classList.add("pill-input-item");

    $pill.textContent = "";
    const $text = Typography.small(text);
    $pill.appendChild($text);

    if (this.editable) {
      const $closeButton = document.createElement("button");
      $closeButton.classList.add("pill-close");
      $closeButton.setAttribute("aria-label", `Remove ${text}`);
      const $icon = LonaIcons.$svg(XIcon);
      $icon.setAttribute("aria-hidden", "true");
      $closeButton.appendChild($icon);

      GESTURE_MANAGER.addPointerEvent($closeButton, {
        onClick: () => {
          this.pills.splice(index, 1);
          this.renderPills();
          this.props?.onChange?.(this.pills);
        },
      });

      $pill.appendChild($closeButton);
    }

    return $pill;
  }

  getSelectedPills(): string[] {
    return [...this.pills];
  }

  static makeWith(props: PillTextInput.Props): PillTextInput {
    const component = PillTextInput.make();
    component.bind(props ?? {});
    return component;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        background: var(--bg);
        border-radius: 12px;
        cursor: text;
        min-height: 44px;
        padding: 8px;
      }

      #container {
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
        height: 100%;
      }

      std-pill-button {
        min-height: var(--input-pill-min-height, 28px);
      }

      std-pill-button.pill-input-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: default;
      }

      .pill-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        margin-left: 4px;
        background: transparent;
        border: none;
        color: var(--text-sec);
        cursor: pointer;
        border-radius: 50%;
      }

      .pill-close svg {
        width: 12px;
        height: 12px;
      }

      .pill-close:hover {
        background: var(--bg-hover);
        color: var(--text-pri);
      }

      .pill-close:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #input {
        flex: 1;
        min-width: 120px;
        padding: 4px 4px;
        background: transparent;
        border: none;
        outline: none;
        color: var(--text-pri);
        --font-size: var(--small-size);
        min-height: var(--input-min-height, 36px);

        text-overflow: ellipsis;
        white-space: nowrap;
        overflow: hidden;
      }

      #input::placeholder {
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`
    <std-row id="container">
      <input type="text" id="input" class=text />
    </std-row>
  `;
}

export namespace PillTextInput {
  export type Props = Optional<{
    pills: string[];
    pendingText: string;
    validator: (text: string) => boolean;
    colorFn: (text: string) => string;
    onChange: (pills: string[]) => void;
    onPendingTextChange: (text: string) => void;
    placeholder: string;
    editable: boolean;
  }>;
}
