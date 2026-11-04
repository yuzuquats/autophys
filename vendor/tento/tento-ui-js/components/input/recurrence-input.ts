import "../recurrence-editor-modal";

import { Month, NaiveDate, RRule, Weekday } from "@tento-chrono";
import { Position } from "../../anchor-positioning-utils";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { CheckmarkIcon, EmptyIcon } from "../../ui/icons";
import { Utils } from "../../utils";
import { Anchor, AnchorInstance } from "../anchor";
import { ContextMenu } from "../context-menu";
import { RecurrenceModel } from "../recurrence-editor";
import { RecurrenceEditorModal } from "../recurrence-editor-modal";

@component({
  name: "std-recurrence-input",
})
export class RecurrenceInput extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $icon: HTMLElement = this.$("icon");

  referenceDate: NaiveDate = NaiveDate.today();
  private selectedModel: Option<RecurrenceModel> = undefined;
  private onChange?: ((model: Option<RecurrenceModel>) => void) | undefined;
  private placeholder: string = "Does not repeat";
  private showChevron: boolean = true;
  private popoverContext: Option<string>;
  private $popover: Option<AnchorInstance>;
  /** Whether the menu opens; a read-only bind shows the rule only. */
  #editable = true;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => this.toggleMenu(),
    });
    this.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleMenu();
      }
    });
  }

  static makeWith(options: {
    referenceDate?: NaiveDate;
    model?: Option<RecurrenceModel>;
    onChange?: (model: Option<RecurrenceModel>) => void;
    placeholder?: string;
    showChevron?: boolean;
    context?: string;
  }): RecurrenceInput {
    const input = RecurrenceInput.make();
    input.bind(options);
    return input;
  }

  bind(options?: {
    referenceDate?: NaiveDate;
    model?: Option<RecurrenceModel>;
    onChange?: (model: Option<RecurrenceModel>) => void;
    placeholder?: string;
    showChevron?: boolean;
    context?: string;
    /** Whether the rule can be changed (default true); false shows it without a menu. */
    editable?: boolean;
  }) {
    this.referenceDate = options?.referenceDate ?? NaiveDate.today();
    this.selectedModel = options?.model;
    this.onChange = options?.onChange;
    this.placeholder = options?.placeholder ?? "Does not repeat";
    this.showChevron = options?.showChevron ?? true;
    this.popoverContext = options?.context;
    this.#editable = options?.editable ?? true;

    this.setAttribute("role", "button");
    this.setAttribute("aria-haspopup", "menu");
    this.setAttribute("tabindex", this.#editable ? "0" : "-1");
    this.toggleAttribute("readonly", !this.#editable);
    if (this.#editable) this.removeAttribute("aria-disabled");
    else {
      this.setAttribute("aria-disabled", "true");
      this.dismissPopover();
    }

    this.updateChevron();
    this.updateLabel();
  }

  private toggleMenu(): void {
    if (!this.#editable) return;
    if (this.$popover != null) {
      this.dismissPopover();
      return;
    }
    this.openMenu();
  }

  private dismissPopover(): void {
    const popover = this.$popover;
    this.$popover = null;
    popover?.dismiss();
  }

  // Anchor the preset menu to the field itself (absolute, width-matched,
  // scroll-tracked), matching the calendar-list picker in EventFields —
  // rather than a viewport-fixed context menu placed at a click point.
  private openMenu(): void {
    const $parent = this.parentElement;
    if ($parent == null) return;

    const $menu = this.buildMenu();

    // Anchor.reveal("anchor" mode) appends the menu into this.parentElement and
    // positions it `absolute` in that parent's coordinate space, so the field
    // wrapper must be the positioned containing block — keeps the menu glued to
    // the field. Lift it (and restore on dismiss).
    const prevPosition = $parent.style.position;
    const prevParentOverflow = $parent.style.overflow;
    $parent.style.position = "relative";
    $parent.style.overflow = "visible";

    // The field wrapper sits inside the fields container (FieldContainer), which
    // clips with `overflow: hidden`; an anchor-relative menu that drops below the
    // field gets cut off there. Lift the container's overflow for the popover's
    // lifetime — the same escape the calendar-list picker applies in EventFields.
    const $container = $parent.parentElement;
    const prevContainerOverflow = $container?.style.overflow;
    if ($container != null) $container.style.overflow = "visible";

    this.$popover = Anchor.reveal({
      $anchor: this,
      $content: $menu,
      escapeContainer: false,
      positionRelativeTo: "anchor",
      position: Position.BOTTOM_LEFT_X,
      offset: {
        outer: {
          vertical: 0,
          horizontal: 0,
        },
      },
      onDismiss: () => {
        $parent.style.position = prevPosition;
        $parent.style.overflow = prevParentOverflow;
        if ($container != null) {
          $container.style.overflow = prevContainerOverflow ?? "";
        }
        this.$popover = null;
      },
    });
  }

  private buildMenu(): ContextMenu.Built {
    const options = getRecurrenceOptions(this.referenceDate);
    const builder = ContextMenu.builder(this.offsetWidth);
    for (const option of options) {
      const icon = this.isOptionSelected(option) ? CheckmarkIcon : EmptyIcon;
      builder.cellRow(option.label, icon, (state) => {
        if (option.isCustom) {
          this.openCustomEditor(this.popoverContext);
        } else {
          this.selectOption(option);
        }
        // Close via the Anchor.reveal lifecycle (restores parent styles,
        // tears down the scroll observer) rather than the builder's own
        // detach.
        state.shouldDismiss = false;
        this.dismissPopover();
      });
    }
    return builder.build({ onDismiss: () => {} });
  }

  private openCustomEditor(context: Option<string>) {
    const defaultModel: RecurrenceModel = this.selectedModel ?? {
      interval: 1,
      frequency: "weekly",
      weekdays: [],
      monthDays: [],
      monthWeekday: null,
      endType: "never",
      endDate: null,
      occurrences: null,
    };

    RecurrenceEditorModal.show(
      "Edit Recurrence",
      this.referenceDate,
      defaultModel,
      (model) => {
        this.selectedModel = model;
        this.updateLabel();
        this.onChange?.(model);
      },
      context,
    );
  }

  private isOptionSelected(option: RecurrenceOption): boolean {
    if (!this.selectedModel && !option.value && !option.isCustom) {
      return true; // "Does not repeat" is selected
    }

    if (!this.selectedModel || !option.value || option.isCustom) {
      return false;
    }

    // Compare the models to see if they match
    return (
      this.selectedModel.frequency === option.value.frequency &&
      this.selectedModel.interval === option.value.interval &&
      Utils.arraysEqual(this.selectedModel.weekdays, option.value.weekdays) &&
      Utils.arraysEqual(this.selectedModel.monthDays, option.value.monthDays) &&
      this.selectedModel.monthWeekday?.n === option.value.monthWeekday?.n &&
      this.selectedModel.monthWeekday?.weekday ===
        option.value.monthWeekday?.weekday
    );
  }

  private selectOption(option: RecurrenceOption) {
    this.selectedModel = option.value;
    this.updateLabel();
    this.onChange?.(this.selectedModel);
  }

  private updateLabel() {
    if (!this.selectedModel) {
      this.$label.textContent = this.placeholder;
      this.$label.classList.add("placeholder");
    } else {
      // Convert model to RRule and get readable display
      const rrule = this.modelToRRule(this.selectedModel);
      const readableText = rrule.toReadableDisplay();
      this.$label.textContent = readableText;
      this.$label.classList.remove("placeholder");
    }
  }

  private updateChevron() {
    this.$icon.style.display = this.showChevron ? "block" : "none";
  }

  modelToRRule(model: RecurrenceModel): RRule {
    const rruleLike: any = {
      freq: model.frequency,
      options: {
        interval: model.interval,
      },
    };

    if (model.weekdays.length > 0) {
      rruleLike.options.byday = model.weekdays;
    }

    if (model.monthWeekday) {
      rruleLike.options.bynthday = [model.monthWeekday];
    }

    if (model.monthDays.length > 0) {
      if (model.frequency === "yearly") {
        // For yearly frequency, month days represent the actual month
        const currentMonth = this.referenceDate.mth;
        rruleLike.options.bymonth = [currentMonth];
        rruleLike.options.bymonthday = model.monthDays;
      } else {
        rruleLike.options.bymonthday = model.monthDays;
      }
    }

    if (model.endType === "after-occurrences" && model.occurrences) {
      rruleLike.options.count = model.occurrences;
    } else if (model.endType === "on-date" && model.endDate) {
      rruleLike.options.until = {
        trunc: () => model.endDate!,
        ical: () => model.endDate!.toString(),
      };
    }

    return new RRule(rruleLike);
  }

  get model(): Option<RecurrenceModel> {
    return this.selectedModel;
  }

  set model(value: Option<RecurrenceModel>) {
    this.selectedModel = value;
    this.updateLabel();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.dismissPopover();
  }

  onRecycle(): void {
    super.onRecycle();
    this.dismissPopover();
  }

  static $styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;

        background: var(--bg-surface-light);
        border-radius: 8px;
        transition: all 0.3s ease;
        min-width: 180px;
        cursor: pointer;
        min-height: 36px;
      }

      :host([readonly]) {
        cursor: default;
      }

      #input-content {
        display: flex;
        align-items: center;
        flex-grow: 1;
        gap: 8px;
        padding: 8px 12px;
        height: 100%;
        width: 100%;
      }

      #label {
        flex: 1;
        margin: 0;
        --font-size: var(--small-size);
        color: var(--text-pri);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #label.placeholder {
        color: var(--text-ter);
      }

      #icon {
        flex-shrink: 0;
        color: var(--text-sec);
      }
    `,
  ];

  static $html = html`
    <std-row id="input-content">
      <p id="label" class="placeholder"></p>
      <svg id="icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 5L6 8L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </std-row>
  `;
}

export namespace RecurrenceInput {
  export interface Props {
    referenceDate?: NaiveDate;
    model?: Option<RecurrenceModel>;
    onChange?: (model: Option<RecurrenceModel>) => void;
    placeholder?: string;
    showChevron?: boolean;
  }
}

interface RecurrenceOption {
  label: string;
  value: Option<RecurrenceModel>;
  isCustom?: boolean;
}

function getRecurrenceOptions(referenceDate: NaiveDate): RecurrenceOption[] {
  const weekday = referenceDate.dayOfWeek;
  const dayOfMonth = referenceDate.day1;
  const month = referenceDate.mth;

  // Calculate which week of the month this is (1st, 2nd, 3rd, 4th, or last)
  const weekOfMonth = Math.ceil(dayOfMonth / 7);
  const isLastWeek = dayOfMonth > 21; // Rough check for last week

  const weekdayName = Weekday.fullName(weekday.dow);
  const monthName = Month.MONTHS_OF_YEAR[month - 1];

  const ordinal = Utils.getOrdinal(weekOfMonth);

  return [
    {
      label: "Does not repeat",
      value: undefined,
    },
    {
      label: "Daily",
      value: {
        interval: 1,
        frequency: "daily" as const,
        weekdays: [],
        monthDays: [],
        monthWeekday: null,
        endType: "never" as const,
        endDate: null,
        occurrences: null,
      },
    },
    {
      label: `Weekly on ${weekdayName}`,
      value: {
        interval: 1,
        frequency: "weekly" as const,
        weekdays: [weekday],
        monthDays: [],
        monthWeekday: null,
        endType: "never" as const,
        endDate: null,
        occurrences: null,
      },
    },
    {
      label: `Monthly on the ${ordinal} ${weekdayName}`,
      value: {
        interval: 1,
        frequency: "monthly" as const,
        weekdays: [],
        monthDays: [],
        monthWeekday: {
          n: isLastWeek ? -1 : weekOfMonth,
          weekday: weekday,
        },
        endType: "never" as const,
        endDate: null,
        occurrences: null,
      },
    },
    {
      label: `Annually on ${monthName} ${dayOfMonth}`,
      value: {
        interval: 1,
        frequency: "yearly" as const,
        weekdays: [],
        monthDays: [dayOfMonth],
        monthWeekday: null,
        endType: "never" as const,
        endDate: null,
        occurrences: null,
      },
    },
    {
      label: "Every weekday (Mon to Fri)",
      value: {
        interval: 1,
        frequency: "weekly" as const,
        weekdays: [
          Weekday.MON,
          Weekday.TUE,
          Weekday.WED,
          Weekday.THU,
          Weekday.FRI,
        ],
        monthDays: [],
        monthWeekday: null,
        endType: "never" as const,
        endDate: null,
        occurrences: null,
      },
    },
    {
      label: "Custom...",
      value: undefined,
      isCustom: true,
    },
  ];
}
