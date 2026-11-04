import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { CheckmarkIcon, XIcon } from "../../icon-exports";
import { LonaIcons } from "../../ui/icons";
import { ListCellLayout } from "../list/list-cell-layout";

@component({ name: "std-auth-page-status" })
export class AuthPageStatus extends LonaWebComponent {
  bind(props: AuthPageStatus.Props): this {
    this.clearChildren();
    this.setAttribute("variant", props.variant);

    const isPromo = props.variant === "promo";

    const $cell = ListCellLayout.makeText(props.message, {
      $icon: LonaIcons.make(isPromo ? CheckmarkIcon : XIcon, {
        color: isPromo ? "var(--green)" : "var(--red)",
      }).assignStyles({
        padding: "6px",
      }),
      caption: props.code ?? undefined,
    });
    // Gray for promo, red tint for errors.
    const bg = isPromo ? "var(--bg-hover-opaque)" : "var(--red-dimmed)";
    $cell.style.setProperty("--list-cell-background-color", bg);
    $cell.style.setProperty("--list-cell-layout-hover-color", bg);
    $cell.style.setProperty("--cell-align", "center");
    $cell.style.flex = "1";
    $cell.style.minWidth = "0";
    this.appendChild($cell);

    return this;
  }

  static $styles = [
    css`
      :host {
        display: flex;
      }
    `,
  ];

  static $html = html`<slot></slot>`;
}

export namespace AuthPageStatus {
  export type Variant = "error" | "promo";
  export type Props = {
    variant: Variant;
    message: string;
    // Promo code surfaced as the cell caption; `null` when there's no code.
    code: Option<string>;
  };
}
