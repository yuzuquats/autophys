import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";

@component({
  name: "std-theme-context",
})
export class ThemeContext extends LonaWebComponent {
  bind(props: ThemeContext.Props): this {
    if (props.theme) {
      this.style.colorScheme = props.theme;
    } else {
      this.style.colorScheme = "";
    }
    if (props.styles) {
      for (let i = 0; i < props.styles.length; i++) {
        this.addStyle(`theme-${i}`, props.styles[i]);
      }
    }
    if (props.children) {
      this.clearChildren();
      for (const c of props.children) {
        this.$("root").appendChild(c);
      }
    }
    return this;
  }

  static $styles = [
    css`
      :host {
        display: contents;
      }
    `,
  ];

  static $html = html`<slot></slot><std-flex id=root></std-flex>`;
}

export namespace ThemeContext {
  export type Props = {
    theme?: Option<"dark" | "light">;
    styles?: Option<Style.Compat[]>;
    children?: Option<HTMLElement[]>;
  };
}
