import { html, LonaWebComponent } from "../component";
import { Center } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { LonaIcons } from "../ui/icons";
import { Typography } from "../ui/typography";

@component({
  name: "std-icon-button",
})
export class IconButton extends LonaWebComponent {
  static color(
    color: string,
    options?: Optional<{
      squarish: boolean;
      margin: string;
    }>,
  ): IconButton {
    return IconButton.makeWith({
      ...options,
      backgroundColor: color,
    });
  }

  static makeWith(options?: IconButton.Props): IconButton {
    return IconButton.make().bind(options);
  }

  static makeText(t: string): IconButton {
    return IconButton.makeWith({
      content: Center.makeWith(Typography.p(t, "small")),
    }).assignStyles({
      width: "40px",
      height: "40px",
      "--std-icon-background-color": "var(--bg-surface-light)",
      "--std-icon-hover-color": "var(--bg-selected)",
    });
  }

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
    }
  };

  connectedCallback(): void {
    this.setAttribute("role", "button");
    this.setAttribute("tabindex", "0");
    this.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback(): void {
    this.removeEventListener("keydown", this.handleKeydown);
  }

  bind(props?: IconButton.Props): this {
    this.clearChildren();
    props?.content &&
      (props.content.slot = "icon") &&
      this.appendChild(props.content);

    this.toggleAttribute("squarish", props?.squarish === true);

    // Set aria-label for accessibility (required for icon-only buttons)
    if (props?.ariaLabel) {
      this.setAttribute("aria-label", props.ariaLabel);
    } else this.removeAttribute("aria-label");

    this.assignStyles({
      "--std-icon-background-color": props?.backgroundColor ?? "",
      "--std-icon-hover-color": props?.hoverColor ?? "",
      margin: props?.margin ?? "",
      "--std-icon-button-dimension": props?.sizePx ? props.sizePx + "px" : "",
    });
    return this;
  }

  bindIcon(svg: string, options?: Option<IconButton.Options>): this {
    return this.bind({
      content: LonaIcons.$svg(svg),
      ...options,
    });
  }

  static $styles = [
    css`
      :host {
        position: relative;
        width: calc(var(--std-icon-button-dimension, 24px));
        height: calc(var(--std-icon-button-dimension, 24px));
        cursor: pointer;
        display: grid;
        place-items: center;
        background-color: var(--std-icon-background-color, transparent);
        border-radius: 50%;
        flex-shrink: 0;
      }
      :host::before {
        position: absolute;
        content: "";
        pointer-events: none;
      }
      :host(:hover) {
        background-color: var(--std-icon-hover-color, var(--bg-hover));
      }
      :host([selected]) {
        background-color: var(--std-icon-selected-color, var(--bg-selected));
      }
      :host([squarish]),
      :host([square]),
      :host([squarish]):before,
      :host([square])::before {
        border-radius: 5px;
      }
      slot[name="icon"]::slotted(*),
      slot::slotted(*) {
        color: var(--std-icon-button-color, var(--fg-icon-sec, #222));
        width: calc(var(--std-icon-button-dimension, 24px) - var(--std-icon-button-padding, 8px));
        height: calc(var(--std-icon-button-dimension, 24px) - var(--std-icon-button-padding, 8px));
        font-size: calc(var(--std-icon-button-dimension, 24px) - var(--std-icon-button-padding, 8px) - 2px);
      }

      :host:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`<slot name="icon"></slot><slot></slot>`;
}

export namespace IconButton {
  export type Props = Optional<{
    content: HTMLElement | SVGElement;
  }> &
    Options;

  export type Options = Optional<{
    backgroundColor: string;
    hoverColor: string;
    squarish: boolean;
    margin: string;
    sizePx: number;
    ariaLabel: string;
  }>;
}
