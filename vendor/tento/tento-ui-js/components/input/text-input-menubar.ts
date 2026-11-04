import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";
import { Row } from "../../component-builtin";
import { DomUtils } from "../../dom";

@component({
  name: "std-text-input-menubar",
})
export class TextInputMenubar extends LonaWebComponent {
  private $toolbar: HTMLElement = this.$("toolbar");

  private onBold?: EmptyFunction;
  private onItalic?: EmptyFunction;
  private onUnderline?: EmptyFunction;
  private onHeading?: (level: number) => void;
  private onList?: (type: "bullet" | "ordered") => void;
  private onLink?: EmptyFunction;
  private onCode?: EmptyFunction;
  private onClear?: EmptyFunction;

  public activeStates = {
    bold: false,
    italic: false,
    underline: false,
    heading: 0,
    bulletList: false,
    orderedList: false,
    link: false,
    code: false,
  };

  bind(props: TextInputMenubar.Props = {}): this {
    this.onBold = props.onBold;
    this.onItalic = props.onItalic;
    this.onUnderline = props.onUnderline;
    this.onHeading = props.onHeading;
    this.onList = props.onList;
    this.onLink = props.onLink;
    this.onCode = props.onCode;
    this.onClear = props.onClear;

    this.renderToolbar(props);

    if (props.activeStates) {
      this.updateActiveStates(props.activeStates);
    }

    return this;
  }

  private renderToolbar(props: TextInputMenubar.Props) {
    DomUtils.clearChildren(this.$toolbar);

    const groups = props.groups ?? TextInputMenubar.defaultGroups();

    groups.forEach((group, index) => {
      if (index > 0) {
        const $separator = document.createElement("div");
        $separator.className = "separator";
        this.$toolbar.appendChild($separator);
      }

      const $group = Row.make();
      $group.className = "button-group";

      group.forEach((button) => {
        const $button = this.createButton(button);
        if ($button) {
          $group.appendChild($button);
        }
      });

      this.$toolbar.appendChild($group);
    });
  }

  private createButton(type: TextInputMenubar.ButtonType): Option<HTMLElement> {
    switch (type) {
      case "bold":
        return this.createIconButton("B", () => this.onBold?.(), "bold");
      case "italic":
        return this.createIconButton(
          "I",
          () => this.onItalic?.(),
          "italic",
          true,
        );
      case "underline":
        return this.createIconButton(
          "U",
          () => this.onUnderline?.(),
          "underline",
          false,
          true,
        );
      case "h1":
        return this.createIconButton("H1", () => this.onHeading?.(1), "h1");
      case "h2":
        return this.createIconButton("H2", () => this.onHeading?.(2), "h2");
      case "h3":
        return this.createIconButton("H3", () => this.onHeading?.(3), "h3");
      case "bulletList":
        return this.createIconButton(
          "•",
          () => this.onList?.("bullet"),
          "bulletList",
        );
      case "orderedList":
        return this.createIconButton(
          "1.",
          () => this.onList?.("ordered"),
          "orderedList",
        );
      case "link":
        return this.createIconButton("🔗", () => this.onLink?.(), "link");
      case "code":
        return this.createIconButton("</>", () => this.onCode?.(), "code");
      case "clear":
        return this.createIconButton("✕", () => this.onClear?.(), "clear");
      default:
        return undefined;
    }
  }

  private static ARIA_LABELS: Record<TextInputMenubar.ButtonType, string> = {
    bold: "Bold",
    italic: "Italic",
    underline: "Underline",
    h1: "Heading 1",
    h2: "Heading 2",
    h3: "Heading 3",
    bulletList: "Bullet list",
    orderedList: "Numbered list",
    link: "Insert link",
    code: "Code",
    clear: "Clear formatting",
  };

  private createIconButton(
    content: string,
    onClick: EmptyFunction,
    buttonType: TextInputMenubar.ButtonType,
    italic = false,
    underline = false,
  ): HTMLButtonElement {
    const $button = Button.makeLight();
    $button.className = "toolbar-button";
    $button.setAttribute("data-type", buttonType);
    $button.setAttribute("aria-label", TextInputMenubar.ARIA_LABELS[buttonType]);
    $button.textContent = content;

    if (italic) {
      $button.style.fontStyle = "italic";
    }
    if (underline) {
      $button.style.textDecoration = "underline";
    }
    if (buttonType === "bold") {
      $button.style.fontWeight = "bold";
    }

    GESTURE_MANAGER.addPointerEvent($button, {
      onClick: () => {
        onClick();
        this.updateButtonState($button, buttonType);
      },
    });

    return $button;
  }

  private updateButtonState(
    $button: HTMLElement,
    buttonType: TextInputMenubar.ButtonType,
  ) {
    const isActive =
      this.activeStates[buttonType as keyof typeof this.activeStates];
    $button.toggleAttribute("active", !!isActive);
  }

  updateActiveStates(states: Partial<TextInputMenubar.ActiveStates>): void {
    Object.assign(this.activeStates, states);

    this.$toolbar.querySelectorAll(".toolbar-button").forEach(($button) => {
      const type = $button.getAttribute("data-type");
      if (type && type in this.activeStates) {
        const isActive =
          this.activeStates[type as keyof typeof this.activeStates];
        $button.toggleAttribute("active", !!isActive);
      }
    });
  }

  static makeWith(props: TextInputMenubar.Props): TextInputMenubar {
    const menubar = TextInputMenubar.make();
    menubar.bind(props);
    return menubar;
  }

  static defaultGroups(): TextInputMenubar.ButtonType[][] {
    return [
      ["bold", "italic", "underline"],
      ["h1", "h2", "h3"],
      ["bulletList", "orderedList"],
      ["link", "code"],
      ["clear"],
    ];
  }

  static $html = html`
    <div id="toolbar"></div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        background: var(--bg);
        border: 1px solid var(--divider);
        border-radius: 4px;
        padding: 4px;
      }

      #toolbar {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .button-group {
        display: flex;
        flex-direction: row;
        gap: 2px;
      }

      .separator {
        width: 1px;
        height: 24px;
        background: var(--divider);
        margin: 0 4px;
      }

      .toolbar-button {
        width: 32px;
        height: 32px;
        padding: 4px;
        border: none;
        background: transparent;
        color: var(--text-pri);
        cursor: pointer;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--text-14px);
        transition: background-color 0.15s ease;
        user-select: none;
      }

      .toolbar-button:hover {
        background: var(--bg-hover);
      }

      .toolbar-button[active] {
        background: var(--bg-selected);
        color: var(--blue);
      }

      .toolbar-button:focus {
        outline: none;
      }

      .toolbar-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      .toolbar-button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];
}

export namespace TextInputMenubar {
  export type ButtonType =
    | "bold"
    | "italic"
    | "underline"
    | "h1"
    | "h2"
    | "h3"
    | "bulletList"
    | "orderedList"
    | "link"
    | "code"
    | "clear";

  export interface ActiveStates {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    heading: number;
    bulletList: boolean;
    orderedList: boolean;
    link: boolean;
    code: boolean;
  }

  export interface Props {
    groups?: ButtonType[][];
    onBold?: EmptyFunction;
    onItalic?: EmptyFunction;
    onUnderline?: EmptyFunction;
    onHeading?: (level: number) => void;
    onList?: (type: "bullet" | "ordered") => void;
    onLink?: EmptyFunction;
    onCode?: EmptyFunction;
    onClear?: EmptyFunction;
    activeStates?: Partial<ActiveStates>;
  }
}
