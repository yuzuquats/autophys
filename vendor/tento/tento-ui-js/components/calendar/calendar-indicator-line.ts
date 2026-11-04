import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PIXELS_PER_HOUR } from "./calendar-hour";

@component({ name: "std-calendar-indicator-line" })
export class CalendarIndicatorLine extends LonaWebComponent {
  attributeChangedCallback(
    name: string,
    oldValue: Option<string>,
    newValue: Option<string>,
  ) {
    switch (name) {
      case "data-time":
        if (!newValue) {
          this.style.removeProperty("--p-start-time-hrs");
          return;
        }
        const [hr, mins] = newValue.split(":");
        this.style.setProperty(
          "--p-start-time-hrs",
          String(parseInt(hr) + (mins ? parseInt(mins) / 60 : 0)),
        );
        break;
    }
  }

  static observedAttributes = ["data-time"];
  static $styles = [
    css(`
      :host {
        position: absolute;
        width: 100%;
        left: 0px;
        top: calc(${PIXELS_PER_HOUR}px * var(--p-start-time-hrs));
      }

      #line {
        width: 100%;
        height: 2px;
        border-radius: 2px;
        background: red;
      }
    `),
  ];
  static $html: Option<HTMLTemplateElement> = html` <div id="line"></div> `;
}
