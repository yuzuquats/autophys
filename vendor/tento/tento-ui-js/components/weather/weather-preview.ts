import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";

@component({
  name: "std-weather-preview",
})
export class WeatherPreview extends LonaWebComponent {
  bind(props: { label: string; value: string }): this {
    this.$("caption").textContent = props.label;
    this.$("label").textContent = `${props.value}`;
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        height: 100%;
      }

      #root {
        padding: 12px;
        padding-bottom: 24px;
        height: 100%;
        align-items: center;
      }

      #caption {
        color: var(--text-ter);
        transform: scale(calc(1 / var(--scale, 1)));
        transform-origin: top;
      }

      #caption-container {
        display: block;
        height: calc(10px * 1 / var(--scale, 1));
      }

      #label-container {
        flex-grow: 1;
        position: relative;
      }

      #centered {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(calc(1 / var(--scale, 1)));
        width: max-content;
        transform-origin: center;
      }

      #label {
        --font-size: calc(var(--text-1px) * 36 * var(--scale));
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <div id=caption-container>
        <p id=caption></p>
      </div>
      <std-col id=label-container>
        <std-block id=centered>
          <p id=label></p>
        </std-block>
      </std-col>
    </std-col>
  `;
}

export namespace WeatherPreview {
  @component({
    name: "std-weather-preview-container",
  })
  export class Container extends LonaWebComponent {
    static makeWith(): Container {
      return Container.make();
    }

    static $styles: Style.Compat[] = [
      css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      #root {
        position: relative;
        width: 100%;
        height: 100%;
        padding: var(--padding, 16px);
      }

      #root::after {
        position: absolute;
        content: "";
        inset: 0px;
        border: calc(var(--border-width, 1px) * 1 / (var(--scale))) solid var(--bg-hover-opaque);
        background: var(--bg);
        border-radius: calc(20px * 1 / (var(--scale)));
        z-index: -1;
      }
    `,
    ];

    static $html = html`
      <std-col id="root">
        <slot></slot>
      </std-col>
    `;
  }
}
