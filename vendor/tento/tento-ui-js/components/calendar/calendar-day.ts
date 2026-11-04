import "./calendar-column";

import { DateFragment } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { CalendarColumn } from "./calendar-column";

@component({
  name: "std-calendar-day",
})
export class CalendarDay<
  NamedChildren extends Record<string, HTMLElement> = {},
> extends LonaWebComponent {
  $before: CalendarColumn<NamedChildren> = this.hydrate("before");
  $after: CalendarColumn<NamedChildren> = this.hydrate("after");
  private fragmentsOverlap: boolean = false;
  private noGesturesActive: boolean = true;

  #theme: Option<CalendarDay.Theme>;

  init(theme: Option<CalendarDay.Theme>, callbacks: CalendarDay.Callbacks) {
    this.#theme = theme;
    this.addPointerEvent({
      onPointerDown: callbacks.onPointerDownEmpty,
      onClick: callbacks.onPointerUpEmpty,
    });
  }

  removeNamedChild<Name extends keyof NamedChildren>(name: Name) {
    this.$before.removeNamedChild(name);
    this.$after.removeNamedChild(name);
  }

  toggleModifying(force: boolean) {
    this.$before.toggleAttribute("modifying", force);
    this.$after.toggleAttribute("modifying", force);
  }

  private updateTooltipState() {
    const enabled = this.fragmentsOverlap && this.noGesturesActive;
    this.$before.toggleTzAbbrTooltipAction(enabled);
    this.$after.toggleTzAbbrTooltipAction(enabled);
  }

  bindNoGesturesActive(noGesturesActive: boolean) {
    this.noGesturesActive = noGesturesActive;
    this.updateTooltipState();
  }

  bindFragmentsOverlap(overlap: boolean) {
    this.fragmentsOverlap = overlap;
    this.updateTooltipState();
  }

  bindFragment(
    $column: CalendarColumn,
    windowed: Option<DateFragment.Windowed>,
  ): boolean {
    if (!windowed) {
      $column.park();
      $column.assignStyles({ "--background": "" });
      return false;
    }
    $column.assignStyles({
      display: "block",
      "--background": this.#theme?.backgroundColor(windowed.fragment) ?? "",
    });
    return $column.bind(windowed);
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: relative;
      }

      #root {
        position: relative;
        height: 100%;
      }

      :host([revealed="before"]) #before {
        z-index: 1;
      }

      :host([revealed="after"]) #after {
        z-index: 1;
      }

      std-calendar-column {
        position: absolute;
        top: 0px;
        height: 100%;
        width: 100%;
      }

      std-calendar-column [modifying] {
        opacity: 0.5;
      }

      :host::before {
        position: absolute;
        content: "";
        top: 0px;
        left: -0.5px;
        width: 1px;
        background: var(--subcolumn-divider);
        height: 100%;
        z-index: 2;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-calendar-column id="before"></std-calendar-column>
      <std-calendar-column id="after"></std-calendar-column>
    </div>
  `;
}

export namespace CalendarDay {
  export type Theme = {
    backgroundColor: (df: Option<DateFragment>) => Option<string>;
  };

  export type Callbacks = {
    onPointerDownEmpty: () => void;
    onPointerUpEmpty: () => void;
  };
}
