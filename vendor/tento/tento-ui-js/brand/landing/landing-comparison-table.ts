import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { ScrollShadows } from "../../ui/scroll-shadows";

@component({ name: "std-landing-comparison-table" })
export class LandingComparisonTable extends LonaWebComponent {
  private $viewport: HTMLElement = this.$("viewport");
  private $table: HTMLTableElement = this.$("table") as HTMLTableElement;
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: LandingComparisonTable.Props): LandingComparisonTable {
    return (LandingComparisonTable.make() as LandingComparisonTable).bind(props);
  }

  bind(props: LandingComparisonTable.Props): this {
    DomUtils.clearChildren(this.$table);
    this.$table.append(
      this.$colgroup(),
      this.$head(props.headings),
      this.$body(props.rows, props.markStyle),
    );
    this.updateScrollShadows();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.$viewport.addEventListener("scroll", this.updateScrollShadows);
    this.resizeObserver = new ResizeObserver(() => {
      this.updateScrollShadows();
    });
    this.resizeObserver.observe(this.$viewport);
    this.updateScrollShadows();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.$viewport.removeEventListener("scroll", this.updateScrollShadows);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private updateScrollShadows = (): void => {
    ScrollShadows.updateHorizontalScrollShadows(this, this.$viewport);
  };

  private $colgroup(): HTMLTableColElement {
    const $colgroup = document.createElement("colgroup");
    for (const className of [
      "comparison-column-legend",
      "comparison-column-value",
      "comparison-column-value",
    ]) {
      const $col = document.createElement("col");
      $col.className = className;
      $colgroup.appendChild($col);
    }
    return $colgroup;
  }

  private $head(headings: LandingComparisonTable.Headings): HTMLTableSectionElement {
    const $thead = document.createElement("thead");
    const $row = document.createElement("tr");
    for (const label of headings) {
      const $th = this.$text("th", "comparison-heading", label);
      $th.setAttribute("scope", "col");
      $row.appendChild($th);
    }
    $thead.appendChild($row);
    return $thead;
  }

  private $body(
    rows: LandingComparisonTable.Row[],
    markStyle: LandingComparisonTable.MarkStyle,
  ): HTMLTableSectionElement {
    const $tbody = document.createElement("tbody");
    for (const row of rows) {
      const $tr = document.createElement("tr");
      $tr.appendChild(this.$legendCell(row));
      $tr.appendChild(this.$valueCell(row.ours, markStyle));
      $tr.appendChild(this.$valueCell(row.theirs, markStyle));
      $tbody.appendChild($tr);
    }
    return $tbody;
  }

  private $legendCell(row: LandingComparisonTable.Row): HTMLTableCellElement {
    const $cell = document.createElement("td");
    $cell.className = "comparison-legend";
    $cell.appendChild(this.$text("p", "comparison-feature", row.feature));

    if (row.description) {
      $cell.appendChild(
        this.$text("p", "comparison-description", row.description),
      );
    }

    return $cell;
  }

  private $valueCell(
    cell: LandingComparisonTable.Cell,
    markStyle: LandingComparisonTable.MarkStyle,
  ): HTMLTableCellElement {
    const $td = document.createElement("td");
    $td.className = `comparison-copy state-${cell.tone}`;
    $td.setAttribute("aria-label", cell.label);

    const $inner = document.createElement("div");
    $inner.className = "comparison-cell";
    if (cell.tone !== "neutral") {
      $inner.appendChild(this.$mark(cell.tone, markStyle));
    }

    $td.appendChild($inner);
    return $td;
  }

  private $mark(
    tone: LandingComparisonTable.CellTone,
    markStyle: LandingComparisonTable.MarkStyle,
  ): HTMLElement {
    const $mark = document.createElement("span");
    $mark.className = `comparison-mark mark-${markStyle}`;
    $mark.setAttribute("aria-hidden", "true");

    if (markStyle === "unicode") {
      $mark.textContent = tone === "positive" ? "✓" : tone === "negative" ? "×" : "~";
      return $mark;
    }

    $mark.appendChild(this.$markSvg(tone));
    return $mark;
  }

  private $markSvg(tone: LandingComparisonTable.CellTone): SVGSVGElement {
    const $svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    $svg.setAttribute("viewBox", "0 0 24 24");
    $svg.setAttribute("focusable", "false");

    const paths =
      tone === "positive"
        ? ["M20 6 9 17l-5-5"]
        : tone === "negative"
          ? ["M18 6 6 18", "M6 6l12 12"]
          : ["M6 12h12"];

    for (const d of paths) {
      const $path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      $path.setAttribute("d", d);
      $svg.appendChild($path);
    }

    return $svg;
  }

  private $text(
    tag: keyof HTMLElementTagNameMap,
    className: string,
    text: string,
  ): HTMLElement {
    const $el = document.createElement(tag);
    $el.className = className;
    $el.textContent = text;
    return $el;
  }

  static $styles = [
    ScrollShadows.$horizontalStyles,
    css`
      :host {
        position: relative;
        display: block;
        width: 100%;
        max-width: 980px;
        margin-left: auto;
        margin-right: auto;
      }

      #viewport {
        overflow-x: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      #viewport::-webkit-scrollbar {
        display: none;
      }

      #scroll-shadows-container {
        position: absolute;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
      }

      #table {
        width: 100%;
        min-width: 720px;
        table-layout: fixed;
        border-collapse: separate;
        border-spacing: 0;
        background: transparent;
      }

      .comparison-column-legend {
        width: 58%;
      }

      .comparison-column-value {
        width: 21%;
      }

      th,
      td {
        padding: 17px 18px;
        text-align: left;
        vertical-align: middle;
        border-bottom: 1px solid var(--divider);
      }

      th {
        padding-top: 0;
        background: transparent;
      }

      th:nth-child(2),
      th:nth-child(3),
      td:nth-child(2),
      td:nth-child(3) {
        text-align: center;
      }

      th:nth-child(2),
      td:nth-child(2) {
        background: color-mix(in srgb, var(--bg) 97%, var(--green) 3%);
      }

      tbody tr:last-child td {
        border-bottom: none;
      }

      .comparison-heading,
      .comparison-feature,
      .comparison-description,
      .comparison-copy {
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: inherit;
      }

      .comparison-heading {
        --font-size: var(--text-10px);
        --line-height-ratio: 1;
        color: var(--text-sec);
      }

      .comparison-feature {
        --font-size: var(--text-12px);
        --line-height-ratio: 1.25;
        color: var(--text-pri);
        font-weight: 650;
      }

      .comparison-description {
        --font-size: var(--text-10px);
        --line-height-ratio: 1.35;
        color: var(--text-sec);
        --margin-top: 8px;
        max-width: 440px;
      }

      .comparison-copy {
        --font-size: var(--text-11px);
        --line-height-ratio: 1.42;
        color: var(--text-sec);
      }

      .comparison-cell {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .comparison-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        --font-size: var(--text-12px);
        line-height: 1;
        font-weight: 700;
      }

      .comparison-mark svg {
        width: 14px;
        height: 14px;
      }

      .comparison-mark svg path {
        fill: none;
        stroke: currentColor;
        stroke-width: 2.4;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .comparison-copy.state-positive .comparison-mark {
        color: color-mix(in srgb, var(--green) 70%, var(--text-pri) 30%);
        background: color-mix(in srgb, var(--bg) 88%, var(--green) 12%);
      }

      .comparison-copy.state-negative .comparison-mark {
        color: var(--text-ter);
        background: color-mix(in srgb, var(--bg) 88%, var(--text-pri) 12%);
      }

      .comparison-copy.state-partial .comparison-mark {
        color: color-mix(in srgb, var(--yellow) 65%, var(--text-pri) 35%);
        background: color-mix(in srgb, var(--bg) 86%, var(--yellow) 14%);
      }
    `,
  ];

  static $html = html`
    <div id="scroll-shadows-container">
      <div class="scroll-shadow-left"></div>
      <div class="scroll-shadow-right"></div>
    </div>
    <div id="viewport">
      <table id="table"></table>
    </div>
  `;
}

export namespace LandingComparisonTable {
  export type MarkStyle = "unicode" | "svg";
  export type CellTone = "positive" | "negative" | "partial" | "neutral";
  export type Headings = [string, string, string];

  export type Cell = {
    tone: CellTone;
    label: string;
  };

  export type Row = {
    feature: string;
    description: Option<string>;
    ours: Cell;
    theirs: Cell;
  };

  export type Props = {
    headings: Headings;
    rows: Row[];
    markStyle: MarkStyle;
  };
}
