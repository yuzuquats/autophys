import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Button } from "../../components/button/button";

@component({
  name: "std-floating-navbar-item",
})
export class FloatingNavbarItem extends LonaWebComponent {
  static $styles = [
    Button.$style,
    css`
      #root {
        border-radius: 16px;
        color: #444;
      }

      p {
        font-weight: 600;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <button flat id="root">
      <p><slot></slot></p>
    </button>
  `;
}
