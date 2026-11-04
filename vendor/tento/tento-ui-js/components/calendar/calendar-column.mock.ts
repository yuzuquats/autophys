import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { CalendarColumn } from "@tento-ui/components/calendar/calendar-column";
import { CalendarColumnCell } from "@tento-ui/components/calendar/calendar-column-cell";
import { CalendarColumnCellContent } from "@tento-ui/components/calendar/calendar-column-cell-content";
import { CalendarColumnLayoutGroup } from "@tento-ui/components/calendar/calendar-column-layout-group";
import { DomUtils } from "@tento-ui/dom";
import { TimePoint } from "@tento-chrono";

@component({
  name: "std-mock-calendar-row",
})
export class MockCalendarRow extends LonaWebComponent {
  $previewColumn: CalendarColumn = this.hydrate("preview-column");

  bind(
    events: (CalendarColumnCellContent.Props & {
      id: string;
      background: string;
    })[],
  ) {
    DomUtils.clearChildren(this.$previewColumn);
    const $layout = CalendarColumnLayoutGroup.make();
    for (const event of events) {
      const $cell = CalendarColumnCell.basic();
      $cell.$content().bind(event);
      $cell.bind({
        id: event.label,
        time: new TimePoint.Range(
          event.time.start,
          event.time.start.add(event.time.duration),
        ),
      });
      $cell.assignStyles({
        "--std-calendar-cell-background": event.background,
      });
      $layout.appendChild($cell);
    }
    $layout.layout();
    this.$previewColumn.appendChild($layout);
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        background: var(--sheet-background-color, var(--bg));
      }

      #preview-column {
        width: 100%;
        height: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-calendar-column id="preview-column"></std-calendar-column>
  `;
}
