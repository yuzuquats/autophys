import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PIXELS_PER_HOUR } from "./calendar-hour";

/**
 * `CalendarColumnLayout.HOST_CSS`: the host's custom properties, as text so it
 * can be read as data. The hour-line period is one hour row.
 */
const HOST_CSS = /* css */ `
      :host {
        --std-calendar-column-layout-width: ${PIXELS_PER_HOUR}px;
        --std-calendar-column-layout-transition: none;
      }
`;

@component({
  name: "std-calendar-column-layout",
})
export class CalendarColumnLayout extends LonaWebComponent {
  static $lines = css`
    .calendar-lines::before {
      position: absolute;
      top: var(--lines-offset, 0px);
      left: 0px;
      margin-top: 0px;
      content: "";
      width: 100%;
      height: var(--lines-height, calc(100% + 1px));
      z-index: 1;
      pointer-events: none;

      background-image: repeating-linear-gradient(
        180deg,
        var(--std-calendar-column-layout-horizontal-color, var(--divider)) 0 1px,
        transparent 1px 100%
      );
      background-size: 100% var(--std-calendar-column-layout-width);

      box-sizing: border-box;
      transition: var(--std-calendar-column-layout-transition);
    }
  `;
  /** The host's custom properties (`HOST_CSS`), read as data by its tests. */
  static readonly HOST_CSS: string = HOST_CSS;
  static $styles = [
    CalendarColumnLayout.$lines,
    css(HOST_CSS),
    css`
      #root {
        position: relative;
        height: 100%;
      }

      slot {
        z-index: 0;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id="root" class=calendar-lines>
      <slot></slot>
    </div>
  `;
}
