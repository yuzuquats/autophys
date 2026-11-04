import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { SpotlightRow } from "../spotlight/spotlight-row";
import { Typography } from "../../ui/typography";

// A dependency-free static panel of the command spotlight — a search bar over a
// list of rows. The PANEL CHROME is a static preview (no Spotlight search infra,
// squircle, contenteditable, or focus/gBCR positioning) so it renders reliably
// as a landing asset under transform:scale, but each row is the REAL
// @tento-ui SpotlightRow so the row visual can't drift from the product. Feeds
// both the spotlight asset and the quick-add asset (whose single row carries a
// QuickAddCard subtitle), mirroring how the app shows quick-add inside spotlight.
@component({ name: "std-spotlight-preview" })
export class SpotlightPreview extends LonaWebComponent {
  private $query: HTMLElement = this.$("query");
  private $rows: HTMLElement = this.$("rows");

  static makeWith(props: SpotlightPreview.Props): SpotlightPreview {
    return (SpotlightPreview.make() as SpotlightPreview).bind(props);
  }

  bind(props: SpotlightPreview.Props): this {
    this.$query.textContent = props.query ?? props.placeholder;
    this.$query.toggleAttribute("placeholder-shown", props.query === null);

    DomUtils.clearChildren(this.$rows);
    for (let i = 0; i < props.rows.length; i++) {
      const row = props.rows[i];
      const $title =
        typeof row.title === "string"
          ? SpotlightRow.$title(row.title)
          : row.title;
      const $row = (SpotlightRow.make() as SpotlightRow).bind(
        $title,
        row.icon ? row.icon() : null,
        row.subtitle,
        async () => {},
      );
      if (i === props.selectedIndex) $row.setAttribute("aria-selected", "true");
      this.$rows.appendChild($row);
    }
    return this;
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
        width: 100%;
      }

      #panel {
        background: var(--bg);
        border-radius: 14px;
        border: 1px solid var(--divider);
        box-shadow: 0 18px 48px color-mix(in srgb, var(--text-pri) 12%, transparent);
        overflow: hidden;
      }

      #search {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 15px 18px;
        border-bottom: 1px solid var(--divider);
      }

      .glyph {
        flex: none;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-icon-sec);
      }

      .glyph svg {
        width: 22px;
        height: 22px;
      }

      #query {
        --font-size: var(--text-14px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-pri);
      }

      #query[placeholder-shown] {
        color: var(--text-ter);
      }

      #rows {
        display: flex;
        flex-direction: column;
        padding: 6px;
      }

      /* Highlight the selected row like the live spotlight does (the row
         component itself only reveals its Enter hint on aria-selected). */
      #rows std-spotlight-row[aria-selected="true"] {
        background: var(--bg-surface-light);
        border-radius: 10px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="panel">
      <div id="search">
        <div class="glyph">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="10.5" cy="10.5" r="6.5"></circle>
            <line x1="15.5" y1="15.5" x2="21" y2="21"></line>
          </svg>
        </div>
        <p id="query"></p>
      </div>
      <div id="rows"></div>
    </div>
  `;
}

export namespace SpotlightPreview {
  export type Row = {
    // A plain string is wrapped in the standard row title; pass a pre-styled
    // element (e.g. with Typography `--margin-top`/`--margin-bottom` vars) when a
    // row needs custom title spacing — as the quick-add row does above its card.
    title: string | HTMLElement;
    icon: Option<() => HTMLElement>;
    subtitle: Option<HTMLElement>;
  };

  export type Props = {
    placeholder: string;
    query: Option<string>;
    rows: Row[];
    // Which row to highlight (aria-selected, the darker bg). `null` = no row
    // selected — the rest state, for a single-row preview that shouldn't look
    // like a live keyboard selection.
    selectedIndex: Option<number>;
  };
}
