import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";

@component({
  name: "std-sheet-legend-layout",
})
export class SheetLegendLayout extends LonaWebComponent {
  bind(onRevealRowOptions: (target: "default" | "emoji") => void): this {
    GESTURE_MANAGER.addPointerEvent(this.$("icon"), {
      onClick: () => onRevealRowOptions("default"),
    });
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        margin-right: -1px;
        --additional-sticky-top: 12px;
      }

      #icon {
        position: sticky;
        top: calc(var(--sticky-top, 0px) + 8px + var(--depth, 0) * 32px);
        height: 16px;
        width: 16px;
        cursor: pointer;
        background: var(--bg);
        margin-left: 4px;
        padding-top: 1px;
      }

      #icon:hover::after {
        content: "";
        position: absolute;
        background: var(--bg-hover);
        top: -8px;
        inset: -4px;
        z-index: -1;
        border-radius: 4px;
      }

      #icon::before {
        content: "";
        position: absolute;
        background: var(--std-calendar-legend-background-color);
        top: -7px;
        bottom: -8px;
        left: -10px;
        right: -10px;
        z-index: -2;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <std-center id="icon" emoji-target>
        <slot name="icon"></slot>
      </std-center>
      <std-spacer></std-spacer>
      <slot></slot>
    </std-row>
  `;
}
