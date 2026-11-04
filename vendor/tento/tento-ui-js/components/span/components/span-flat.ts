import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { SpanColumn } from "./span-column";

@component({
  name: "std-span-flat",
})
export class SpanFlat extends LonaWebComponent {
  bind($icon: HTMLElement) {
    this.clearChildren();
    $icon.slot = "icon";
    this.appendChild($icon);
  }

  static $styles: Style.Compat[] = [
    SpanColumn.$inThePast,
    css`
      :host {
        background: var(--blue);
      }

      #icon {
        position: absolute;
        top: 3px;
        left: 3px;
        width: calc(100% - 6px);
        aspect-ratio: 1;
        max-width: 24px;
        border-radius: 50%;
        background: var(--icon-bg, var(--bg));
      }

      #root {
        height: 100%;
        width: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-center id=icon>
        <slot name=icon></slot>
      </std-center>
    </std-col>
  `;
}
