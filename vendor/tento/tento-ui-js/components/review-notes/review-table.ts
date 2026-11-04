import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Documentation } from "../documentation/documentation";
import { TableParser } from "../../review-dsl/block-parsers";
import { NotesInline } from "./notes-inline";

// Decision table — options × criteria with the chosen row marked, authored as
//   ```review-table
//   | option | bundle | verdict |
//   | tags   | 0      | lossy inner content |
//   | * fences | 0    | degrades to code    |
//   ```
// The ADR "alternatives considered" section in a shape a reviewer can scan.

@component({ name: "std-review-table" })
export class ReviewTable extends LonaWebComponent {
  private $table: HTMLElement = this.$("table");

  bind({ table }: ReviewTable.Props): void {
    const $thead = document.createElement("thead");
    const $headRow = document.createElement("tr");
    for (const cell of table.header) {
      const $th = document.createElement("th");
      $th.appendChild(NotesInline.$format(cell));
      $headRow.appendChild($th);
    }
    $thead.appendChild($headRow);

    const $tbody = document.createElement("tbody");
    for (const row of table.rows) {
      const $tr = document.createElement("tr");
      if (row.chosen) $tr.className = "chosen";
      row.cells.forEach((cell, i) => {
        const $td = document.createElement("td");
        if (i === 0 && row.chosen) {
          const $check = document.createElement("span");
          $check.className = "check";
          $check.textContent = "✓ ";
          $td.appendChild($check);
        }
        $td.appendChild(NotesInline.$format(cell));
        $tr.appendChild($td);
      });
      $tbody.appendChild($tr);
    }
    this.$table.replaceChildren($thead, $tbody);
  }

  static $styles = [
    Documentation.$tableStyle,
    css`
      :host {
        display: block;
        margin-block: 16px;
        overflow-x: auto;
      }
      table {
        margin-block: 0;
      }
      tr.chosen td {
        background: color-mix(in srgb, var(--fg-green) 8%, transparent);
      }
      tr.chosen td:first-child {
        border-left: 3px solid var(--fg-green);
        font-weight: 600;
      }
      .check {
        color: var(--fg-green);
        font-weight: 700;
      }
      code {
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 11px;
        background: var(--bg-surface, rgba(128, 128, 128, 0.12));
        padding: 1px 4px;
        border-radius: 3px;
      }
    `,
  ];

  static $html = html`<table id="table"></table>`;
}

export namespace ReviewTable {
  export type Props = { table: TableParser.Table };
}
