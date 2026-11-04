import { LonaWebComponent, html } from "../component.js";
import { component } from "../component-decorators.js";
import { Style, css } from "../component-styles.js";
import { Scrollbars } from "./scrollbars.js";

@component({
  name: "std-disclaimer",
})
export class Disclaimer extends LonaWebComponent {
  static makeWith(content: string | HTMLElement): Disclaimer {
    return Disclaimer.make().bind(content);
  }

  bind(content: string | HTMLElement): this {
    const $content = this.$("content");
    if (typeof content === "string") {
      $content.textContent = content;
    } else {
      $content.textContent = "";
      $content.appendChild(content);
    }
    return this;
  }

  static $styles: Style.Compat[] = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
      }

      #root {
        background: var(--bg-surface-light);
        border-radius: 8px;

        overflow-y: scroll;
        overflow-x: scroll;
        max-height: inherit;
      }

      /* The inset is a knob for the same reason the size is: a caller that
         puts a caption above the bubble has to indent that caption to the same
         line, and it cannot do that against a number it has to guess. The
         default is the geometry this component always had — 4px on the root
         plus 8px here — now stated once. */
      #pad {
        padding: var(--disclaimer-inset, 12px);
      }

      /* The size is a knob, not a constant. A disclaimer is used both as a
         footnote under a form — where the ramp's small is right, and is the
         default here — and as a standing block a reader is meant to actually
         read, where small is too quiet. An id selector so it beats the .small
         class the content paragraph carries; the default is that class's own
         value, so every existing consumer is unchanged. */
      #content {
        --font-size: var(--disclaimer-font-size, var(--small-size));
      }

      p {
        height: 100%;
        white-space: break-spaces;
      }

      slot[name="cta"]::slotted(*) {
        margin-top: 4px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <div id=pad>
        <p id=content class=small></p>
      </div>
      <slot name=cta></slot>
    </std-col>
  `;
}
