import "../editable-text"; // Import to register the custom element
import "../controls/date-picker"; // Import to register the DatePicker

import { NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Row } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { Tracing } from "@tento-core/tracing";
import { AngleRightIcon, LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { ContextMenu } from "../context-menu";
import { DatePicker } from "../controls/date-picker";
import { EditableText } from "../editable-text";
import { Position } from "../../anchor-positioning-utils";

@component({
  name: "std-date-field",
})
export class DateField extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $editableText: EditableText = this.hydrate("editable-text");
  private $chevron: Option<HTMLElement> = null;
  private $cm: Option<ContextMenu.Built>;
  private $dropdown: Option<DateFieldDropdown>;
  private modalContext: Option<string>;

  private currentValidDate: Option<NaiveDate>;
  private placeholder: Option<string>;

  onChange?: ((date: Option<NaiveDate>) => void) | undefined;
  onInvalid?: ((message: string) => void) | undefined;

  get value(): Option<NaiveDate> {
    return this.currentValidDate;
  }

  static makeWith(props: DateField.Props): DateField {
    const $d = DateField.make();
    $d.bind(props);
    return $d;
  }

  constructor() {
    super();

    // Set up editable text event handlers
    this.$editableText.controller.onTextChange = (text) => {
      if (!text) {
        this.clearError();
        this.currentValidDate = null;
        this.$dropdown?.bindSelectedDate(null); // Clear dropdown selection when text is empty
        return;
      }

      // Try to parse the date using tento-chrono's flexible parser
      const parsed = NaiveDate.parseFlexibleOpt(text);
      if (!parsed) {
        this.showError("Invalid date format");
        this.onInvalid?.("Invalid date format");
        this.currentValidDate = null;
        this.$dropdown?.bindSelectedDate(null); // Clear dropdown selection on invalid input
        return;
      }

      // Valid date - update dropdown but don't emit onChange yet (similar to time-input)
      this.currentValidDate = parsed;
      this.$dropdown?.bindSelectedDate(parsed);
      this.clearError();
    };

    // Handle focus/blur on the editable text
    this.$editableText.controller.onEditingStarted = () => this.openDropdown();
    this.$editableText.controller.onEditingFinished = () =>
      this.closeDropdown();

    this.$editableText.controller.onEnterKey = () => this.blur();

    // Enable editing by default
    this.$editableText.enableEditing(false);

    GESTURE_MANAGER.addBarrier(this);
  }

  bind(props: DateField.Props): this {
    this.currentValidDate = props.value;
    this.$editableText.bind(
      this.currentValidDate?.toString(),
      props.placeholder ?? "YYYY-MM-DD",
      false,
    );
    this.placeholder = props.placeholder;
    this.modalContext = props.modalContext;

    this.onChange = props.onChange;
    this.onInvalid = props.onInvalid;

    // Show/hide chevron based on prop (default to hiding)
    const showChevron = props.showChevron ?? false;
    if (showChevron && !this.$chevron) {
      this.createChevron();
    } else if (!showChevron && this.$chevron) {
      DomUtils.removeFromDom(this.$chevron);
      this.$chevron = null;
    }

    return this;
  }

  private createChevron() {
    const $chevron = document.createElement("button");
    $chevron.id = "chevron";
    $chevron.type = "button";
    $chevron.setAttribute("aria-label", "Toggle date picker");
    $chevron.setAttribute("aria-expanded", "false");
    $chevron.innerHTML = /* html */ `
      <svg height="16" width="16" style="transform:rotate(90deg)" aria-hidden="true">
        <use href="#angle-right" />
      </svg>
    `;
    this.$container.appendChild($chevron);

    GESTURE_MANAGER.addPointerEvent($chevron, {
      onClick: () => {
        if (this.hasAttribute("open")) {
          this.closeDropdown();
        } else {
          this.openDropdown();
        }
      },
    });

    this.$chevron = $chevron;
  }

  private onClickOutside($e: Option<HTMLElement>) {
    if ($e === this.$cm || $e === this) return;

    const expectedContext = this.modalContext ?? "date-field";

    if ($e) {
      const $ancestors = DomUtils.getAncestors($e);
      for (const $ancestor of $ancestors) {
        if ($ancestor instanceof Window) break;
        const context = $ancestor.getAttribute("context");
        if (context === expectedContext) return;
      }
    }

    Tracing.dev("onClickOutside", $e);
    this.closeDropdown();
  }

  private openDropdown() {
    this.toggleAttribute("open", true);
    this.$chevron?.setAttribute("aria-expanded", "true");

    this.$dropdown = DateFieldDropdown.make();

    // Set up the callback for when a date is selected from dropdown
    this.$dropdown.bindSelectedDate(this.currentValidDate);
    this.$dropdown.onDateSelected = (date) => {
      this.$editableText.controller.text = date.toString();
      this.currentValidDate = date;
      this.clearError();
      this.blur();
    };

    const rect = this.getBoundingClientRect();
    this.$cm = ContextMenu.builder(280, 0)
      .row(this.$dropdown)
      .buildAndReveal(this.$container, {
        position: Position.fromPoint({
          x: rect.left,
          y: rect.top + rect.height,
        }),
        cleanup: () => {},
        hideOnClickOutside: false,
        context: this.modalContext ?? "date-field",
        autoFocus: false,
      });
    GESTURE_MANAGER.toggleCleanUpOnClickOutside(
      this.$cm,
      this.onClickOutside.bind(this),
    );
    GESTURE_MANAGER.toggleCleanUpOnClickOutside(
      this,
      this.onClickOutside.bind(this),
    );

    Hotkeys.pushEscapeHandler(this, () => {
      this.closeDropdown();
    });
  }

  private closeDropdown() {
    this.onChange?.(this.currentValidDate);
    if (!this.$cm) return;
    this.toggleAttribute("open", false);
    this.$chevron?.setAttribute("aria-expanded", "false");
    GESTURE_MANAGER.clearOnClickOutside(this.$cm);
    GESTURE_MANAGER.clearOnClickOutside(this);
    Hotkeys.clearEscapeHandler(this);
    this.$cm.dismiss();
    this.$cm = null;
    this.$dropdown = null;
    this.$editableText.bind(
      this.currentValidDate?.toString(),
      this.placeholder ?? "YYYY-MM-DD",
      false,
    );
  }

  private clearError() {
    this.toggleAttribute("invalid", false);
  }

  private showError(message: string) {
    this.toggleAttribute("invalid", true);
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        margin-bottom: var(--form-input-margin-bottom, 0px);
      }

      #container {
        width: 100%;
        height: 38px;
        box-sizing: border-box;
        border: var(--container-border-thickness, 2px) solid var(--container-border-color, transparent);
        border-radius: 8px;
        background: var(--container-bg, var(--bg));
        transition: border-color 0.3s ease;
        align-items: center;
        padding: 0 4px;
      }

      :host([open]) #container {
        border-color: var(--blue);
      }

      :host([invalid]) #container {
        border-color: var(--red);
        background: var(--red-dimmed);
      }

      std-editable-text {
        flex: 1;
        --font-size: var(--p-size);
        --padding-inline: 10px;
        --padding-block: 9px;
        color: var(--text-pri);
        width: 120px;
      }

      std-editable-text[placeholder]:empty::before {
        color: var(--text-ter);
      }

      #chevron {
        padding: 4px 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.3s ease;
        transform: rotate(270deg);
        background: none;
        border: none;
        border-radius: 4px;
      }

      :host([open]) #chevron {
        transform: rotate(360deg);
      }

      #chevron svg {
        fill: var(--text-sec);
      }

      #chevron:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $icons = [LonaIcons.symbol(AngleRightIcon)];

  static $html = html`
    <std-row id="container">
      <std-editable-text id="editable-text"></std-editable-text>
    </std-row>
  `;
}

@component({
  name: "std-date-field-dropdown",
})
class DateFieldDropdown extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $datePicker: DatePicker = this.hydrate("date-picker");
  onDateSelected?: (date: NaiveDate) => void;

  constructor() {
    super();

    // Set up the date picker
    const today = NaiveDate.today();
    this.$datePicker.bindToToday(today);

    // Forward date selection events
    this.$datePicker.onSelectedDate = (date) => {
      this.onDateSelected?.(date);
      return true; // Accept the selection
    };
  }

  bindSelectedDate(date: Option<NaiveDate>): void {
    if (!date) return;
    this.$datePicker.bindToDate(date, NaiveDate.today());
  }

  static $styles = [
    css`
      :host {
        display: block;
        border-radius: 8px;
        overflow: hidden;
      }

      #container {
        padding: 12px;
      }

      std-date-picker {
        width: 100%;
        z-index: 1;
      }
    `,
  ];

  static $html = html`
    <std-col id="container">
      <std-date-picker id="date-picker"></std-date-picker>
    </std-col>
  `;
}

export namespace DateField {
  export interface Props {
    value?: Option<NaiveDate>;
    placeholder?: string;
    min?: Option<NaiveDate>;
    max?: Option<NaiveDate>;
    modalContext?: Option<string>;
    showChevron?: boolean;
    onChange?: ((date: Option<NaiveDate>) => void) | undefined;
    onInvalid?: ((message: string) => void) | undefined;
  }
}

// Date parsing is now handled by NaiveDate.parseFlexibleOpt in tento-chrono
// which supports multiple date formats:
// - ISO/RFC3339 format: YYYY-MM-DD
// - US format: MM/DD/YYYY or MM-DD-YYYY
// - European format: DD.MM.YYYY or DD/MM/YYYY
// - Compact format: YYYYMMDD
