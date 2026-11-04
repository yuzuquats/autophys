import "../round";

import { DateUnit } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Button } from "../button/button";
import { Overlay } from "../overlay";
import { Round } from "../round";

@component({
  name: "std-time-scale-selector-interval-row",
})
export class TimeScaleSelectorIntervalRow extends LonaWebComponent {
  private $buttons: HTMLButtonElement[] = [];
  private $moreButton!: HTMLButtonElement;
  private modal?: TimeScaleSelectorIntervalRow.Modal;

  private type: DateUnit.Type = "day";
  value: number = 1;
  private onChange?: ((value: number) => void) | undefined;

  private static defaultVariableValue(type: DateUnit.Type): number {
    return type === "day" ? 7 : 4;
  }

  constructor() {
    super();
    const $buttonContainer = this.$("button-container");

    for (let i = 0; i < 5; i++) {
      const $button = document.createElement("button");
      $button.className = "time-scale-button";

      if (i < 4) {
        GESTURE_MANAGER.addPointerEvent($button, {
          onClick: () => {
            const val = parseInt($button.dataset.value!);
            this.deselectAll();
            $button.classList.add("selected");
            this.value = val;
            this.onChange?.(val);
          },
        });
      } else {
        $button.textContent = "···";
        $button.dataset.value = "more";
        $button.setAttribute("aria-label", "More interval options");
        this.$moreButton = $button;

        GESTURE_MANAGER.addPointerEvent($button, {
          onClick: () => {
            this.openModal();
          },
        });
      }

      this.$buttons.push($button);
      $buttonContainer.appendChild($button);
    }
  }

  bind(props: TimeScaleSelectorIntervalRow.Props): this {
    this.type = props.type;
    this.value = props.value ?? 1;
    this.onChange = props.onChange;

    const variableValue = TimeScaleSelectorIntervalRow.defaultVariableValue(this.type);
    const options = [1, 2, 3, variableValue];
    for (let i = 0; i < 4; i++) {
      this.$buttons[i].textContent = options[i].toString();
      this.$buttons[i].dataset.value = options[i].toString();
    }

    this.setInitialSelection();

    return this;
  }

  static makeWith(
    props: TimeScaleSelectorIntervalRow.Props,
  ): TimeScaleSelectorIntervalRow {
    const row = TimeScaleSelectorIntervalRow.make();
    row.bind(props);
    return row;
  }

  private openModal(): void {
    if (!this.modal) {
      this.modal = TimeScaleSelectorIntervalRow.Modal.make();
      this.modal.bind({
        type: this.type,
        currentValue: this.value,
        onSelect: (value: number) => {
          this.value = value;
          this.$buttons[3].textContent = value.toString();
          this.$buttons[3].dataset.value = value.toString();
          this.onChange?.(value);
          this.setInitialSelection();
          this.modal?.dismiss();
        },
      });
    }
    this.modal.reveal();
  }

  private deselectAll(): void {
    // Clear all button selections
    for (const btn of this.$buttons) {
      btn.classList.remove("selected");
    }
  }

  private setInitialSelection(): void {
    this.deselectAll();
    this.$moreButton.textContent = "···";

    for (let i = 0; i < 4; i++) {
      if (parseInt(this.$buttons[i].dataset.value!) === this.value) {
        this.$buttons[i].classList.add("selected");
        return;
      }
    }

    // Value not in any visible button — update the variable slot and select it
    this.$buttons[3].textContent = this.value.toString();
    this.$buttons[3].dataset.value = this.value.toString();
    this.$buttons[3].classList.add("selected");
  }

  static $html = html`
    <div id="container">
      <div id="button-container"></div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }

      #container {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #button-container {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .time-scale-button {
        width: 32px;
        height: 32px;
        padding: 0;
        background: var(--bg-surface-light);
        border-radius: 6px;
        cursor: pointer;
        font-size: var(--text-14px);
        color: var(--text-pri);
        text-align: center;
        transition: all 0.2s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        border: none;
      }

      .time-scale-button.selected {
        box-shadow: 0 0 0 2px var(--blue);
      }

      .time-scale-button.selected:hover {
        box-shadow: 0 0 0 2px var(--blue);
      }

      .time-scale-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];
}

export namespace TimeScaleSelectorIntervalRow {
  export interface Props {
    type: DateUnit.Type;
    value?: number;
    onChange?: (value: number) => void;
  }

  @component({
    name: "std-time-scale-selector-modal",
  })
  export class Modal extends LonaModalWebComponent {
    private $title: HTMLHeadingElement = this.$("title");
    private $content: HTMLElement = this.$("content");
    private $cancelButton: HTMLButtonElement = this.hydrate("cancel-button");
    private $saveButton: HTMLButtonElement = this.hydrate("save-button");

    private _$bg: Round = this.hydrate<Round>("bg").bind(Round.Props.MODAL);

    private type: DateUnit.Type = "day";
    private currentValue: number = 1;
    private selectedValue: number = 1;
    private onSelect?: ((value: number) => void) | undefined;
    private $gridButtons: HTMLButtonElement[] = [];

    bind(props: Modal.Props): this {
      this.type = props.type;
      this.currentValue = props.currentValue ?? 1;
      this.selectedValue = this.currentValue;
      this.onSelect = props.onSelect;

      this.$title.textContent = "Select Interval";
      this.createGrid();
      this.setupButtons();

      return this;
    }

    private createGrid(): void {
      // Clear existing content
      DomUtils.clearChildren(this.$content);
      this.$gridButtons = [];

      const $grid = document.createElement("div");
      $grid.className = "number-grid";

      // Create numbers 1-8
      const numbers = [1, 2, 3, 4, 5, 6, 7, 8];

      // Add extra numbers for days (14, 21, 28, 35)
      if (this.type === "day") {
        numbers.push(14, 21, 28, 35);
      }

      for (const num of numbers) {
        const $button = document.createElement("button");
        $button.className = "grid-button";
        $button.textContent = num.toString();
        $button.dataset.value = num.toString();

        if (num === this.currentValue) {
          $button.classList.add("selected");
        }

        GESTURE_MANAGER.addPointerEvent($button, {
          onClick: () => {
            // Deselect all buttons
            for (const btn of this.$gridButtons) {
              btn.classList.remove("selected");
            }
            $button.classList.add("selected");
            this.selectedValue = num;
          },
        });

        this.$gridButtons.push($button);
        $grid.appendChild($button);
      }

      this.$content.appendChild($grid);
    }

    private setupButtons(): void {
      GESTURE_MANAGER.addPointerEvent(this.$cancelButton, {
        onClick: () => {
          this.dismiss();
        },
      });

      GESTURE_MANAGER.addPointerEvent(this.$saveButton, {
        onClick: () => {
          this.onSelect?.(this.selectedValue);
        },
      });
    }

    dismiss(): void {
      Overlay.dismiss(this);
    }

    static $styles: Style.Compat[] = [
      LonaModalWebComponent.$headerStyle,
      LonaModalWebComponent.$style,
      Button.$style,
      css`
        :host {
          --std-modal-max-width: 400px;
          --std-modal-min-height: auto;
        }

        #root {
          position: relative;
        }

        #content {
          padding: 20px;
        }

        .number-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
        }

        .grid-button {
          width: 100%;
          height: 48px;
          background: var(--bg-surface-light);
          border: none;
          border-radius: 8px;
          font-size: var(--text-16px);
          color: var(--text-pri);
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .grid-button:hover {
          background: var(--divider);
        }

        .grid-button.selected {
          background: var(--blue);
          color: var(--text-pri-inv);
        }

        .grid-button.selected:hover {
          background: var(--blue);
        }

        .grid-button:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 2px;
        }

        #footer {
          padding: 16px 20px;
          border-top: 1px solid var(--divider);
          justify-content: flex-end;
          gap: 12px;
        }
      `,
    ];

    static $html = html`
      <std-col id="root">
        <std-round floating id=bg></std-round>
        <std-col id="header" class=modal-header>
          <h3 id="title" class="h6 modal-title"></h3>
        </std-col>
        <std-col id="content">
        </std-col>
        <std-row id="footer">
          <button id="cancel-button" secondary>Cancel</button>
          <button id="save-button" primary>Save</button>
        </std-row>
      </std-col>
    `;
  }

  export namespace Modal {
    export interface Props {
      type: DateUnit.Type;
      currentValue?: number;
      onSelect?: (value: number) => void;
    }
  }
}
