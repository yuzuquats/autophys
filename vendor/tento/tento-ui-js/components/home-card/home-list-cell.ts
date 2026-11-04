import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { CellGroup } from "@tento-ui/components/sheet/cell-group";
import { Typography } from "@tento-ui/ui/typography";
import { NaiveDate } from "@tento-chrono";

/**
 * One row of the home screen's list mode, which reports its size as it
 * changes.
 */
@component({
  name: "std-home-list-cell",
})
export class HomeListCell extends LonaWebComponent {
  private _onSizeChange: Option<(s: Size) => void>;

  size: Option<Size>;
  onSizeChange: Option<(s: Size) => void> = (s) => {
    this.size = s;
    this.setAttribute("dbg-size", s.height + "");
    this._onSizeChange?.(s);
  };

  bind(props: HomeListCell.Props): this {
    this._onSizeChange = props.onSizeChange;

    this.$("title").textContent = props.title;
    // Collapse the caption row when empty (e.g. the placeholder action row) so
    // it stays a single line. Real cards always have a non-empty caption (date
    // label fallback), so they're unaffected.
    this.$("caption").textContent = props.caption;
    this.$("caption").style.display = props.caption ? "" : "none";

    // TODO: clear content children
    if (props.$content) {
      const $content =
        typeof props.$content === "string"
          ? Typography.small(props.$content)
          : props.$content;
      $content.slot = "content";
      this.appendChild($content);
    }

    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        flex-direction: row;
        align-items: start;
        width: 100%;
      }

      #title-container {
        padding: 12px;
        align-items: center;
      }

      #title-content {
        flex-grow: 1;
        min-width: 0;
      }

      #root {
        width: 100%;
      }

      #content-container {
        flex-grow: 1;
        min-width: 0;
        // border-top: 1px solid var(--divider);
        align-self: stretch;
        width: 100%;
      }

      #title {
        color: var(--text-sec);
        --margin-top: 0px;
      }

      #caption {
        color: var(--text-ter);
        --margin-top: 6px;
      }

      #content-slot {
        display: block;
      }

      ::slotted(*) {
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-row id=title-container>
        <slot name=avatar></slot>
        <std-col id=title-content>
          <p id=title></p>
          <p id=caption class=small></p>
        </std-col>
        <slot name=accessory></slot>
      </std-row>
      <std-col id=content-container>
        <slot name=content></slot>
      </std-col>
    </std-col>
  `;

  static getDateLabel(
    date: Option<NaiveDate.Partial>,
    localDate: Option<NaiveDate>,
  ): string {
    if (!date || !localDate) return "Today";

    switch (date.type) {
      case "day": {
        const diff = date.start.daysSinceEpoch - localDate.daysSinceEpoch;
        if (diff === 0) return "Today";
        if (diff === 1) return "Tomorrow";
        if (diff === -1) return "Yesterday";
        break;
      }
      case "week": {
        const localYw = localDate.isoYw1;
        if (date.yr === localYw.yr && date.wno === localYw.wno) {
          return "This week";
        }
        const nextWeekDate = localDate.addDays(7);
        const nextYw = nextWeekDate.isoYw1;
        if (date.yr === nextYw.yr && date.wno === nextYw.wno) {
          return "Next week";
        }
        const lastWeekDate = localDate.addDays(-7);
        const lastYw = lastWeekDate.isoYw1;
        if (date.yr === lastYw.yr && date.wno === lastYw.wno) {
          return "Last week";
        }
        break;
      }
      case "month": {
        if (date.yr === localDate.yr && date.mth === localDate.mth) {
          return "This month";
        }
        const nextMonth = localDate.addMonths(1);
        if (date.yr === nextMonth.yr && date.mth === nextMonth.mth) {
          return "Next month";
        }
        const lastMonth = localDate.addMonths(-1);
        if (date.yr === lastMonth.yr && date.mth === lastMonth.mth) {
          return "Last month";
        }
        break;
      }
      case "year": {
        if (date.yr === localDate.yr) return "This year";
        if (date.yr === localDate.yr + 1) return "Next year";
        if (date.yr === localDate.yr - 1) return "Last year";
        break;
      }
    }

    // Fallback to CellGroup.tooltipText
    const tooltip = CellGroup.tooltipText(date);
    return tooltip.subtitle
      ? `${tooltip.title} (${tooltip.subtitle})`
      : tooltip.title;
  }
}

export namespace HomeListCell {
  export type Props = {
    title: string;
    caption: string;
    //
    $content?: Option<HTMLElement>;
    onSizeChange?: (s: Size) => void;
  };
}
