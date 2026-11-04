import "../input/datetimeregion-input";
import "../controls/checkbox";
import "../round";

import { DateTimeRegion } from "@tento-chrono";
import { html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Button } from "../button/button";
import { Checkbox } from "../controls/checkbox";
import { DateTimeRegionInput } from "../input/datetimeregion-input";
import { Overlay } from "../overlay";
import { Round } from "../round";
import { Toast } from "../toast/toast";
import { Disclaimer } from "../disclaimer";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { EventTime } from "./event-time";

@component({
  name: "std-datetime-range-modal",
})
export class DateTimeRangeModal extends LonaModalWebComponent {
  private _$bg = this.hydrate<Round>("bg").bind(Round.Props.MODAL);
  private $title: HTMLElement = this.$("title");
  private $startDateTimeRegionInput: DateTimeRegionInput = this.hydrate(
    "start-datetimeregion-input",
  );
  private $endDateTimeRegionInput: DateTimeRegionInput = this.hydrate(
    "end-datetimeregion-input",
  );
  private $allDayCheckbox: Checkbox = this.hydrate("all-day-checkbox");
  private $cancelButton: HTMLButtonElement = this.$("cancel-button");
  private $saveButton: HTMLButtonElement = this.$("save-button");

  private onUpdate?: Option<(data: EventTime) => void>;
  private onSave?: Option<(data: EventTime) => void>;
  private currentRange?: DateTimeRegion.Range;
  private isAllDay: boolean = false;

  static show(props: DateTimeRangeModal.Props): DateTimeRangeModal {
    const $modal = DateTimeRangeModal.make();
    $modal.bind(props);
    $modal.reveal(Overlay.instance.get(), props.modalContext);
    return $modal;
  }

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$cancelButton, {
      onClick: () => Overlay.dismiss(this),
    });
    GESTURE_MANAGER.addPointerEvent(this.$saveButton, {
      onClick: () => {
        if (!this.currentRange) return;
        this.onSave?.(new EventTime(this.currentRange, this.isAllDay));
        Overlay.dismiss(this);
      },
    });
  }

  bind(props: DateTimeRangeModal.Props): this {
    this.$title.textContent = props.title;
    this.onUpdate = props.onUpdate;
    this.onSave = props.onSave;
    this.currentRange = props.initialData.range;
    this.isAllDay = props.initialData.isAllDay;
    this.setAttribute("context", props.modalContext ?? "");
    this.updateTimeInputsDisabled();
    this.updateDurationDisplay();

    this.$allDayCheckbox.bind({
      checked: this.isAllDay,
      onChange: (checked) => {
        this.isAllDay = checked;
        this.updateTimeInputsDisabled();
        this.updateDurationDisplay();
        this.emitUpdate();
      },
    });

    this.$startDateTimeRegionInput.bind({
      value: this.currentRange.start,
      onChange: (dtr) => {
        if (!dtr || !this.currentRange) return;
        this.updateCurrentTime(
          new DateTimeRegion.Range(dtr, this.currentRange.end),
        );
      },
      options: {
        placeholders: {
          date: "YYYY-MM-DD",
          time: "HH:MM",
          timezone: "Select timezone",
        },
        modalContext: props.modalContext,
        disableTimezone: props.start?.disableEditing ?? false,
      },
    });
    this.$endDateTimeRegionInput.bind({
      value: this.currentRange.end,
      onChange: (dtr) => {
        if (!dtr || !this.currentRange) return;
        this.updateCurrentTime(
          new DateTimeRegion.Range(this.currentRange.start, dtr),
        );
      },
      options: {
        placeholders: {
          date: "YYYY-MM-DD",
          time: "HH:MM",
          timezone: props.end?.placeholder ?? "Select timezone",
        },
        modalContext: props.modalContext,
      },
    });
    return this;
  }

  private updateCurrentTime(range: DateTimeRegion.Range) {
    this.currentRange = range;
    this.updateDurationDisplay();
    this.emitUpdate();
    this.$("save-button").toggleAttribute(
      "disabled",
      range.duration().toMs <= 0,
    );
  }

  private updateTimeInputsDisabled(): void {
    this.$startDateTimeRegionInput.setTimeDisabled(this.isAllDay);
    this.$endDateTimeRegionInput.setTimeDisabled(this.isAllDay);
  }

  private updateDurationDisplay(): void {
    if (!this.currentRange) return;
    const $duration = this.$("duration");
    if (this.isAllDay) {
      const startDate = this.currentRange.start.ndt.date;
      const endDate = this.currentRange.end.ndt.date;
      const days = endDate.differenceInDays(startDate);
      $duration.textContent = days === 1 ? "1 day" : `${days} days`;
    } else {
      $duration.textContent = this.currentRange.duration().formatReadable();
    }
  }

  private emitUpdate(): void {
    if (!this.currentRange) return;
    this.onUpdate?.(new EventTime(this.currentRange, this.isAllDay));
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$headerStyle,
    LonaModalWebComponent.$style,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 520px;
        --std-modal-max-height: min(600px, calc(100dvh - 40px));
        height: 100%;
      }

      #root {
        padding: 0;
        display: flex;
        flex-direction: column;
        position: relative;
      }

      #content {
        padding: 20px;
        gap: 20px;
      }

      .field-group {
        gap: 12px;
      }

      .field-label {
        color: var(--text-sec);
        --margin-bottom: 12px;
        margin-left: 4px;
      }

      #start-datetimeregion-input,
      #end-datetimeregion-input {
        width: 100%;
      }

      #footer {
        padding: 12px 16px;
        border-top: 1px solid var(--divider);
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      std-datetimeregion-input {
        --container-bg: var(--bg-surface-light);
        --container-border-thickness: 1px;
        --container-border-color: transparent;
        --dropdown-background-color: var(--bg-surface-light);
        --dropdown-active-background-color: var(--bg);
      }

      #all-day-row {
        padding: 12px 20px;
        border-top: 1px solid var(--divider);
        align-items: center;
        gap: 8px;
      }

      #all-day-label {
        color: var(--text-sec);
      }

    `,
  ];

  static $html = html`
    <std-col opaque id="root">
      <std-round floating id=bg></std-round>
      <std-col id="header" class="modal-header">
        <h3 id="title" class="h6 modal-title"></h3>
      </std-col>
      <std-col id="content">
        <div class="field-group">
          <p class="field-label" class=h5>Departure</p>
          <std-datetimeregion-input id="start-datetimeregion-input"></std-datetimeregion-input>
        </div>
        <div class="field-group">
          <p class="field-label" class=h5>Arrival</p>
          <std-datetimeregion-input id="end-datetimeregion-input"></std-datetimeregion-input>
        </div>
      </std-col>
      <std-spacer></std-spacer>
      <slot name=disclaimer></slot>
      <std-row id="all-day-row">
        <std-checkbox id="all-day-checkbox"></std-checkbox>
        <p id="all-day-label">All-day</p>
      </std-row>
      <std-row id="footer">
        <std-row style=align-self:center;><p style=margin-right:8px;color:var(--text-ter)>Duration</p><p id=duration></p></std-row>
        <std-spacer></std-spacer>
        <button id="cancel-button" secondary>Cancel</button>
        <button id="save-button" primary>Save</button>
      </std-row>
    </std-col>
  `;
}

export namespace DateTimeRangeModal {
  export type Props = {
    title: string;
    initialData: EventTime;
    onUpdate?: Option<(data: EventTime) => void>;
    onSave?: Option<(data: EventTime) => void>;
    modalContext?: Option<string>;

    start?: Optional<{
      disableEditing: boolean;
    }>;
    end?: Optional<{
      placeholder: string;
    }>;
  };

  export function showDefault(
    initialRange: DateTimeRegion.Range,
    isAllDay: boolean = false,
  ) {
    const initialData = new EventTime(initialRange, isAllDay);
    const props: Props = {
      title: "Edit Event Time",
      initialData,
      onSave: (data) => {
        const departureTzChanged =
          initialRange.start.tz.fullname !== data.range.start.tz.fullname;
        if (departureTzChanged) {
          Toast.info("changing previous tz");
        }
      },
      onUpdate: (data) => {
        $modal.clearChildren();
        const departureTzChanged =
          initialRange.start.tz.fullname !== data.range.start.tz.fullname;

        if (departureTzChanged) {
          const $disclaimer = Disclaimer.makeWith(
            "Updating the starting timezone will also change the timezone for your previous flight",
          ).assignStyles({
            margin: "8px",
            marginTop: "0px",
          });
          $disclaimer.slot = "disclaimer";
          $modal.appendChild($disclaimer);
        }

        if (data.range.duration().toMs < 0) {
          const $disclaimer = Disclaimer.makeWith(
            "End time must be after start time",
          ).assignStyles({
            margin: "8px",
            marginTop: "0px",
          });
          $disclaimer.slot = "disclaimer";
          $modal.appendChild($disclaimer);
        }
      },
    };
    const $modal = DateTimeRangeModal.show(props);
  }
}
