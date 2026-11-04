import "../editable-text";

import { NaiveTime, TimeOfDay, TimeWithMeridiem } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Row } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { AngleRightIcon, LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { ContextMenu } from "../context-menu";
import { EditableText } from "../editable-text";
import { Position } from "../../anchor-positioning-utils";

@component({
  name: "std-time-field",
})
export class TimeField extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $editableText: EditableText = this.hydrate("editable-text");
  private $chevron: Option<HTMLElement>;
  private $cm: Option<ContextMenu.Built>;
  private $dropdown: Option<TimeFieldDropdown>;

  private currentValidTime: Option<TimeOfDay>;
  private placeholder: Option<string>;
  private modalContext: Option<string>;
  private use24Hour: boolean = false;

  onChange?: ((time: TimeOfDay) => void) | undefined;
  onInvalid?: ((message: string) => void) | undefined;

  get value(): Option<TimeOfDay> {
    return this.currentValidTime;
  }

  static makeWith(props: TimeField.Props): TimeField {
    const $t = TimeField.make();
    $t.bind(props);
    return $t;
  }

  constructor() {
    super();

    // Set up editable text event handlers
    this.$editableText.controller.onTextChange = (text) => {
      if (!text) {
        this.clearError();
        this.currentValidTime = null;
        this.$dropdown?.bindSelectedTime(null); // Clear dropdown selection when text is empty
        return;
      }

      // First try parsing with AM/PM support
      const parsedWithMeridiem = TimeWithMeridiem.parse(text);
      if (parsedWithMeridiem) {
        const resolved = parsedWithMeridiem.resolve();
        if (resolved) {
          this.currentValidTime = resolved.time;
          this.$dropdown?.bindSelectedTime(resolved.time);
          this.clearError();
          return;
        }
      }

      // Use tryParseSofar for progressive validation
      const parseResult = TimeOfDay.tryParseSofar(text);

      // If parsing failed, show error and return
      if (parseResult.isErr) {
        this.showError("Invalid time format");
        this.onInvalid?.("Invalid time format");
        this.currentValidTime = null;
        this.$dropdown?.bindSelectedTime(null); // Clear dropdown selection
        return;
      }

      // Parsing succeeded - check if complete or incomplete
      const time = parseResult.exp();
      if (!time) {
        // Incomplete but potentially valid - don't show error
        this.clearError();
        this.currentValidTime = null;
        this.$dropdown?.bindSelectedTime(null); // Clear dropdown selection for incomplete input
        return;
      }

      // Complete valid time - store it but don't emit onChange yet
      this.currentValidTime = time;
      this.$dropdown?.bindSelectedTime(time);
      this.clearError();
    };

    // Handle focus/blur on the editable text
    this.$editableText.controller.onEditingStarted = () => this.openDropdown();
    this.$editableText.controller.onEditingFinished = () =>
      this.closeDropdown();

    this.$editableText.controller.onEnterKey = () => this.blur();
    this.$editableText.enableEditing(false);

    GESTURE_MANAGER.addBarrier(this);
  }

  bind(props: TimeField.Props): this {
    this.placeholder = props.placeholder;
    this.use24Hour = props.use24Hour ?? false;
    const timeText = props.value
      ? NaiveTime.Formatter.render(props.value, {
          includeSeconds: false,
          padHours: false,
          includeAmPm: !this.use24Hour,
          use24Hour: this.use24Hour,
        })
      : null;
    this.$editableText.bind(timeText, props.placeholder ?? "HH:MM", false);

    // Initialize current valid time from props
    this.currentValidTime = props.value ?? null;

    this.onChange = props.onChange;
    this.onInvalid = props.onInvalid;
    this.modalContext = props.modalContext;
    this.setAttribute("context", this.modalContext ?? "");

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
    $chevron.setAttribute("aria-label", "Toggle time picker");
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

    const expectedContext = this.modalContext ?? "time-field";

    if ($e) {
      const $ancestors = DomUtils.getAncestors($e);
      for (const $ancestor of $ancestors) {
        if ($ancestor instanceof Window) break;
        const context = $ancestor.getAttribute("context");
        if (context === expectedContext) return;
      }
    }

    this.closeDropdown();
  }

  private openDropdown() {
    this.toggleAttribute("open", true);
    this.$chevron?.setAttribute("aria-expanded", "true");

    this.$dropdown = TimeFieldDropdown.make();
    this.$dropdown.use24Hour = this.use24Hour;
    this.$dropdown.generateTimeOptions();
    this.$dropdown.onTimeSelected = (time) => {
      this.currentValidTime = time;
      this.clearError();
      this.closeDropdown();
    };
    this.$dropdown.bindSelectedTime(this.currentValidTime);
    this.$dropdown.setAttribute("context", this.modalContext ?? "");

    // Set the current selection if there's a valid time in the input
    const currentText = this.$editableText.controller.text;
    if (currentText) {
      const parseResult = TimeOfDay.tryParseSofar(currentText);
      if (parseResult.isOk) {
        const time = parseResult.exp();
        if (time) {
          this.$dropdown.bindSelectedTime(time);
        }
      }
    }

    const rect = this.getBoundingClientRect();
    this.$cm = ContextMenu.builder(160, 0)
      .row(this.$dropdown)
      .buildAndReveal(this.$("container"), {
        position: Position.fromPoint({
          x: rect.left,
          y: rect.top + rect.height,
        }),
        cleanup: () => {},
        hideOnClickOutside: false,
        context: this.modalContext ?? "time-field",
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
    if (this.currentValidTime) {
      this.onChange?.(this.currentValidTime);
      this.$editableText.bind(
        NaiveTime.Formatter.render(this.currentValidTime, {
          includeSeconds: false,
          padHours: false,
          includeAmPm: !this.use24Hour,
          use24Hour: this.use24Hour,
        }),
        this.placeholder ?? "HH:MM",
        false,
      );
    } else {
      this.$editableText.bind(null, this.placeholder ?? "HH:MM", false);
    }
    if (!this.$cm) return;
    this.toggleAttribute("open", false);
    this.$chevron?.setAttribute("aria-expanded", "false");
    GESTURE_MANAGER.clearOnClickOutside(this.$cm);
    GESTURE_MANAGER.clearOnClickOutside(this);
    Hotkeys.clearEscapeHandler(this);
    this.$cm.dismiss();
    this.$cm = null;
    this.$dropdown = null;
    this.blur();
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
        width: 80px;
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
  name: "std-time-field-dropdown",
})
class TimeFieldDropdown extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private times: TimeOfDay[] = [];
  use24Hour: boolean = false;
  onTimeSelected?: (time: TimeOfDay) => void;

  constructor() {
    super();
  }

  generateTimeOptions() {
    // Generate times in 15-minute increments
    for (let hours = 0; hours < 24; hours++) {
      for (let minutes = 0; minutes < 60; minutes += 15) {
        const time = TimeOfDay.wrap({ hrs: hours + minutes / 60 });
        this.times.push(time);

        const $option = this.createTimeOption(time, true);
        this.$container.appendChild($option);
      }
    }
  }

  private createTimeOption(time: TimeOfDay, persistent: boolean): HTMLElement {
    const $row = Row.make();
    $row.classList.add("time-option");
    persistent && $row.classList.add("persistent");

    const $text = Typography.p(
      NaiveTime.Formatter.render(time, {
        includeSeconds: false,
        includeAmPm: !this.use24Hour,
        use24Hour: this.use24Hour,
      }),
    );
    $row.appendChild($text);

    GESTURE_MANAGER.addPointerEvent($row, {
      onClick: () => {
        this.onTimeSelected?.(time);
      },
    });

    $row.setAttribute("data-time", time.toString());
    return $row;
  }

  bindSelectedTime(time: Option<TimeOfDay>): void {
    // Remove non-persistent options
    const nonPersistentOptions = this.$container.querySelectorAll(
      ".time-option:not(.persistent)",
    );
    for (const $option of nonPersistentOptions) {
      $option.remove();
    }

    // Clear previous selection
    const $prev = this.$qs_maybe(".selected");
    if ($prev) {
      $prev.classList.remove("selected");
    }

    // Early return if no time to select
    if (!time) return;

    // Check if time already exists in dropdown
    let $selected = this.$qs_maybe(`[data-time="${time.toString()}"]`);
    if ($selected) {
      $selected.classList.add("selected");
      $$.deferMutate(() => {
        $selected.scrollIntoView({
          behavior: "auto",
          block: "center",
        });
      });
      return;
    }

    // Time not found, need to create a custom option
    // Find the correct position to insert the custom time
    const allOptions = Array.from(
      this.$container.querySelectorAll(".time-option"),
    );
    let insertBefore: Option<Element> = null;

    for (const $option of allOptions) {
      const optionTimeStr = $option.getAttribute("data-time");
      if (!optionTimeStr) continue;

      const optionTime = TimeOfDay.parse(optionTimeStr);
      if (!optionTime.isOk) continue;

      if (optionTime.exp().toMs > time.toMs) {
        insertBefore = $option;
        break;
      }
    }

    // Create the custom time option (non-persistent)
    const $customOption = this.createTimeOption(time, false);

    if (insertBefore) {
      this.$container.insertBefore($customOption, insertBefore);
    } else {
      this.$container.appendChild($customOption);
    }

    // Select and scroll to the new custom option
    $customOption.classList.add("selected");
    $customOption.scrollIntoView({
      behavior: "auto",
      block: "center",
    });
  }

  static $styles = [
    css`
      :host {
        display: block;
        border-radius: 8px;
        max-height: 300px;
        overflow: hidden;
      }

      #container {
        max-height: 300px;
        overflow-y: auto;
        padding: 4px;
      }

      .time-option {
        padding: 8px 12px;
        cursor: pointer;
        border-radius: 6px;
        transition: background-color 0.3s ease;
        color: var(--text-sec);
      }

      .time-option:hover {
        background: var(--bg-hover);
      }

      .time-option.selected {
        background: var(--blue-dimmed);
      }

      .time-option p {
        margin: 0;
      }
    `,
  ];

  static $html = html`
    <std-col id="container"></std-col>
  `;
}

export namespace TimeField {
  export interface Props {
    value?: Option<TimeOfDay>;
    placeholder?: string;
    showChevron?: boolean;
    use24Hour?: boolean | undefined;
    onChange?: ((time: TimeOfDay) => void) | undefined;
    onInvalid?: ((message: string) => void) | undefined;
    modalContext?: Option<string>;
  }
}
