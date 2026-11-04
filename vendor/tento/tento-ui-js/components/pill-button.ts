import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Typography } from "../ui/typography";

@component({
  name: "std-pill-button",
})
export class PillButton extends LonaWebComponent {
  static makeWith(t: string, options?: PillButton.Options) {
    const $pill = PillButton.make();
    $pill.bind(t, options);
    return $pill;
  }

  bind(t: string, options?: PillButton.Options) {
    this.clearChildren();
    const $p = Typography.p(t, "small");
    $p.style.setProperty(
      "--font-size",
      "var(--pill-button-font-size, var(--p-size))",
    );
    this.appendChild($p);
    this.assignStyles({
      "--pill-button-padding": options?.padding ?? "",
      "--pill-button-color": options?.color ?? "",
      "--pill-button-background": options?.background ?? "",
      "--pill-button-border-radius": options?.borderRadius
        ? options.borderRadius + "px"
        : "",
      "--pill-button-font-size": options?.fontSize ?? "",
      "--pill-button-border": options?.border ?? "",
    });
  }

  static $style = css`
    .pill-button {
      padding: var(--pill-button-padding, 6px 8px);
      background-color: var(--pill-button-background, #fee2dd);
      border-radius: var(--pill-button-border-radius, 8px);
      border: var(--pill-button-border, none);
      width: fit-content;
      color: var(--pill-button-color, var(--text-pri));
      white-space: nowrap;
      min-height: inherit;
    }
  `;

  static $styles = [PillButton.$style];
  static $html = html`
    <std-row id="root" class="pill-button" style=align-items:center>
      <slot></slot>
    </std-row>
  `;
}

export namespace PillButton {
  export type Options = Optional<{
    color: string;
    background: string;
    borderRadius: number;
    border: string;
    margin: string;
    padding: string;
    fontSize: string;
  }>;

  export namespace Options {
    export const SMALL: PillButton.Options = {
      color: "black",
      borderRadius: 8,
      padding: "6px 8px",
      fontSize: "var(--small-size)",
    };
  }
}
