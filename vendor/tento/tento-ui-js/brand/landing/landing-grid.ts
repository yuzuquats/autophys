import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-landing-grid" })
export class LandingGrid extends LonaWebComponent {
  static observedAttributes = ["columns", "gap"];

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (name === "columns") {
      this.style.setProperty("--columns", value);
    } else if (name === "gap") {
      this.style.setProperty("--gap", `${value}px`);
    }
  }

  static makeWith(props: LandingGrid.Props): LandingGrid {
    const $el = LandingGrid.make() as LandingGrid;
    if (props.columns != null) {
      $el.setAttribute("columns", String(props.columns));
    }
    if (props.gap != null) {
      $el.setAttribute("gap", String(props.gap));
    }
    if (props.layout != null) {
      $el.setAttribute("layout", props.layout);
    }
    return $el;
  }

  static $html = html`<slot></slot>`;

  static $styles = [
    css`
      :host {
        --columns: 3;
        --gap: 20px;
        display: grid;
        grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
        align-items: stretch;
        gap: var(--gap);
      }

      ::slotted(*) {
        min-height: 100%;
      }

      :host([layout="hero"]) {
        --columns: 2;
      }

      :host([layout="hero"]) ::slotted(:first-child) {
        grid-column: 1 / -1;
      }

      @media (max-width: 1024px) {
        :host {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 768px) {
        :host {
          grid-template-columns: 1fr;
        }

        ::slotted(*) {
          grid-column: auto !important;
        }
      }
    `,
  ];
}

export namespace LandingGrid {
  export type Props = {
    columns?: Option<number>;
    gap?: Option<number>;
    layout?: Option<"hero">;
  };
}
