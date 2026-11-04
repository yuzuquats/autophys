import "./input/radio-button";
import "./list/list-cell-layout";

import { LonaWebComponent, html } from "../component";
import { Column } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Typography } from "../ui/typography";
import { Button } from "./button/button";
import { RadioButton } from "./input/radio-button";
import { ListCellLayout } from "./list/list-cell-layout";

@component({ name: "std-radio-button-cell" })
export class RadioButtonCell extends LonaWebComponent {
  private $layout: ListCellLayout = this.hydrate("layout");
  private $radioButton: RadioButton = this.hydrate("radio");
  $subtitle: Option<HTMLElement>;

  private onChecked?: ((cell: RadioButtonCell) => void) | undefined;

  get $content(): HTMLElement {
    return this.$layout.$content;
  }

  get checked(): boolean {
    return this.$radioButton.checked;
  }

  set checked(value: boolean) {
    this.$radioButton.checked = value;
  }

  bind(props: RadioButtonCell.Props): this {
    // Clear existing content
    const $contentCol = this.$("content-col");
    DomUtils.clearChildren($contentCol);

    // Create and append title
    const $title = Typography.p(props.title);
    $title.assignStyles({
      color: "var(--text-sec)",
      "--margin-bottom": "4px",
    });
    $contentCol.appendChild($title);

    // Handle subtitle if provided
    if (props.options?.$subtitle) {
      $contentCol.appendChild(props.options?.$subtitle);
    }
    this.$subtitle = props.options?.$subtitle;

    // Set radio button properties
    if (props.options?.name) {
      this.$radioButton.name = props.options.name;
    }

    if (props.options?.value) {
      this.$radioButton.value = props.options.value;
      this.setAttribute("value", props.options.value);
    }

    // Set callback
    this.onChecked = props.options?.onChecked ?? undefined;

    return this;
  }

  static makeWith(props: RadioButtonCell.Props): RadioButtonCell {
    const $cell = RadioButtonCell.make();
    $cell.bind(props);
    return $cell;
  }

  connectedCallback() {
    // Handle click on entire cell
    GESTURE_MANAGER.addPointerEvent(this.$layout, {
      onClick: () => {
        // Don't change checked state - just notify parent
        this.onChecked?.(this);
      },
    });

    // Override RadioButton's default behavior
    // RadioButton normally manages its own checked state
    // We need to prevent that and let parent control it
    this.$radioButton.onChange = (checked, _value) => {
      // Revert the change - parent will decide
      this.$radioButton.checked = !checked;
      this.onChecked?.(this);
    };
  }

  static $html = html`
    <std-list-cell-layout id="layout">
      <std-radio-button id="radio" slot="icon"></std-radio-button>
      <std-col id="content-col" slot="content"></std-col>
    </std-list-cell-layout>
  `;

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
        --list-cell-layout-hover-color: transparent;
        cursor: default;
      }

      #content-col {
        align-items: flex-start;
        gap: 4px;
        margin-top: 4px;
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];
}

export namespace RadioButtonCell {
  export type Options = Optional<{
    $subtitle: HTMLElement;
    onChecked: (cell: RadioButtonCell) => void;
    name: string;
    value: string;
  }>;

  export interface Props {
    title: string;
    options?: Option<Options>;
  }

  /**
   * Manages a group of RadioButtonCells with exclusive selection.
   * When a cell is clicked, the onSelected callback is invoked.
   * If the callback returns true, that cell is selected and others are deselected.
   */
  export class Group {
    $cells: RadioButtonCell[] = [];
    private selectedCell?: RadioButtonCell | undefined;
    private onSelected?: (($cell: RadioButtonCell) => boolean) | undefined;

    constructor(options?: {
      onSelected?: ($cell: RadioButtonCell) => boolean;
    }) {
      this.onSelected = options?.onSelected;
    }

    bind($cells: RadioButtonCell[]): void {
      this.$cells = $cells;
      for (const $cell of $cells) {
        const originalOnChecked = $cell["onChecked"];
        $cell["onChecked"] = (clickedCell: RadioButtonCell) => {
          this.handleCellClick(clickedCell);
          originalOnChecked?.(clickedCell);
        };
      }
    }

    private handleCellClick(cell: RadioButtonCell): void {
      const shouldSelect = this.onSelected?.(cell) ?? true;
      if (shouldSelect) this.select(cell);
    }

    select(cellToSelect: RadioButtonCell): void {
      for (const cell of this.$cells) {
        cell.checked = false;
      }
      cellToSelect.checked = true;
      this.selectedCell = cellToSelect;
    }

    getSelected(): Option<RadioButtonCell> {
      return this.selectedCell;
    }

    clearSelection(): void {
      for (const $cell of this.$cells) {
        $cell.checked = false;
      }
      this.selectedCell = undefined;
    }

    addCell(cell: RadioButtonCell): void {
      this.$cells.push(cell);
      const originalOnChecked = cell["onChecked"];
      cell["onChecked"] = (clickedCell: RadioButtonCell) => {
        this.handleCellClick(clickedCell);
        originalOnChecked?.(clickedCell);
      };
    }

    removeCell(cell: RadioButtonCell): void {
      const index = this.$cells.indexOf(cell);
      if (index !== -1) {
        this.$cells.splice(index, 1);
        if (this.selectedCell === cell) {
          this.selectedCell = undefined;
        }
      }
    }

    getCells(): RadioButtonCell[] {
      return [...this.$cells];
    }

    build(): HTMLElement {
      const $p = Column.make();
      $p.style.gap = "6px";
      for (const $c of this.$cells) {
        $p.appendChild($c);
      }
      return $p;
    }
  }
}
