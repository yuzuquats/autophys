import { DateTimeRegion } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Typography } from "../../ui/typography";
import { AvatarEditable } from "../core/avatar-editable";
import { Button } from "../button/button";
import { Divider } from "../divider";
import { EventDetailsContent } from "../event-details/event-details-content";
import { EventTime } from "../event-details/event-time";
import { Overlay } from "../overlay";
import "../round";
import { RadioButtonCell } from "../radio-button-cell";
import { Round } from "../round";

@component({
  name: "std-timezone-time-range-caption",
})
export class TimezoneTimeRangeCaption extends LonaWebComponent {
  private $mainLine: HTMLElement = this.$("main-line");
  private $tooltip: HTMLElement = this.$("tooltip");
  private $timeRange: HTMLElement = this.$("time-range");
  private $tzName: HTMLElement = this.$("tz-name");
  private $utcTime: HTMLElement = this.$("utc-time");
  private $localLabel: HTMLElement = this.$("local-label");
  private $localTime: HTMLElement = this.$("local-time");

  constructor() {
    super();
    this.$mainLine.addEventListener("mouseenter", () => {
      this.$tooltip.classList.add("visible");
    });
    this.$mainLine.addEventListener("mouseleave", () => {
      this.$tooltip.classList.remove("visible");
    });
  }

  bind(props: TimezoneTimeRangeCaption.Props): this {
    const tzDisplay =
      props.givenTz.tzAbbrev ??
      props.givenTz.tzName.split("/").pop() ??
      props.givenTz.tzName;
    const localDisplay =
      props.localTz.tzAbbrev ??
      props.localTz.tzName.split("/").pop() ??
      props.localTz.tzName;

    this.$timeRange.textContent = `${props.givenTz.startTime} → ${props.givenTz.endTime}`;
    this.$tzName.textContent = tzDisplay;
    this.$utcTime.textContent = `${props.utc.startTime} → ${props.utc.endTime}`;
    this.$localLabel.textContent = `${localDisplay} (Local):`;
    this.$localTime.textContent = `${props.localTz.startTime} → ${props.localTz.endTime}`;

    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: relative;
        border-radius: 4px;
      }

      :host::before {
        content: "";
        position: absolute;
        inset: -4px -8px;
        background: var(--bg-hover);
        border-radius: 4px;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }

      :host(:hover)::before {
        opacity: 1;
      }

      #main-line {
        gap: 4px;
        align-items: center;
        color: var(--text-sec);
        font-size: var(--text-12px);
        cursor: help;
        transition: color 0.3s ease;
      }

      #main-line:hover {
        color: var(--text-pri);
      }

      #tz-name {
        color: var(--text-ter);
      }

      #tooltip {
        position: absolute;
        top: calc(100% + 1px);
        left: -8px;
        margin-top: 4px;
        padding: 8px 8px;
        background: var(--bg-elevated);
        color: var(--text-sec);
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        gap: 4px;
        z-index: 1000; /* ZIndex.FLOATING_PANEL */
        display: none;
        white-space: nowrap;
        font-size: var(--text-11px);
      }

      #tooltip.visible {
        display: flex;
      }

      .tooltip-row {
        gap: 4px;
      }

      .tooltip-label {
        color: var(--text-ter-inv);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="main-line">
      <span id="time-range"></span>
      <span id="tz-name"></span>
    </std-row>
    <std-col id="tooltip">
      <std-row class="tooltip-row">
        <span class="tooltip-label">UTC:</span>
        <span id="utc-time"></span>
      </std-row>
      <std-row class="tooltip-row">
        <span id="local-label" class="tooltip-label"></span>
        <span id="local-time"></span>
      </std-row>
    </std-col>
  `;
}

export namespace TimezoneTimeRangeCaption {
  export interface TimeRangeInfo {
    startTime: string;
    endTime: string;
    tzName: string;
    tzAbbrev?: string;
  }

  export interface Props {
    givenTz: TimeRangeInfo;
    utc: TimeRangeInfo;
    localTz: TimeRangeInfo;
  }
}

@component({
  name: "std-timezone-confirmation-modal",
})
export class TimezoneConfirmationModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg")
    .bind(Round.Props.MODAL);

  private $radioGroup: RadioButtonCell.Group;
  private selectedValue: Option<string> = null;
  private resolve: Option<(result: TimezoneConfirmationModal.Result) => void> =
    null;
  private $eventDetails: EventDetailsContent = this.hydrate("event-details");
  private $avatar: AvatarEditable = this.hydrate("avatar");
  private optionsMap: Map<string, TimezoneConfirmationModal.TimezoneOption> =
    new Map();

  static async show(
    props: TimezoneConfirmationModal.Props,
  ): Promise<TimezoneConfirmationModal.Result> {
    return new Promise((resolve) => {
      const $modal = TimezoneConfirmationModal.make();
      $modal.bind(props, resolve);
      $modal.reveal();
    });
  }

  constructor() {
    super();

    this.$radioGroup = new RadioButtonCell.Group({
      onSelected: (cell) => {
        this.selectedValue = cell.getAttribute("value");
        if (this.selectedValue) {
          const option = this.optionsMap.get(this.selectedValue);
          if (option) {
            this.$eventDetails.bindTime(
              new EventTime(option.resolvedTime, false),
            );
          }
        }
        return true;
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$("cancel-button"), {
      onClick: () => {
        this.resolve?.(null);
        this.resolve = null;
        Overlay.dismiss(this);
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$("confirm-button"), {
      onClick: () => {
        if (this.selectedValue) {
          this.resolve?.({ selectedTimezone: this.selectedValue });
        } else {
          this.resolve?.(null);
        }
        this.resolve = null;
        Overlay.dismiss(this);
      },
    });
  }

  bind(
    props: TimezoneConfirmationModal.Props,
    resolve: (result: TimezoneConfirmationModal.Result) => void,
  ): this {
    this.resolve = resolve;
    this.selectedValue = null;
    this.optionsMap.clear();

    this.$("title").textContent = props.title;

    const $description = this.$("description");
    if (props.description) {
      $description.textContent = props.description;
      $description.style.display = "block";
    } else {
      $description.style.display = "none";
    }

    // Build options map
    for (const option of props.options) {
      this.optionsMap.set(option.value, option);
    }

    // Setup event preview
    const defaultOption =
      props.options.find((o) => o.isDefault) ?? props.options[0];
    this.$avatar.bind({
      content: props.eventIcon,
      contentBg: props.eventIconBg,
      badgeBg: "var(--gray)",
      badgeContent: null,
      disabled: true,
    });
    this.$eventDetails.bind({
      title: props.eventTitle,
      time: defaultOption.resolvedTime,
      onUpdateTime: Constants.EMPTY_FUNCTION,
      editable: false,
      modalContext: "timezone-confirmation",
    });

    const $content = this.$("content");
    DomUtils.clearChildren($content);

    const $cells: RadioButtonCell[] = [];
    for (const option of props.options) {
      const $subtitle =
        typeof option.description === "string"
          ? Typography.p(option.description, "caption").assignStyles({
              color: "var(--text-ter)",
            })
          : option.description;

      const $cell = RadioButtonCell.makeWith({
        title: option.label,
        options: { $subtitle },
      });
      $cell.setAttribute("value", option.value);
      if (option.isDefault) {
        $cell.checked = true;
        this.selectedValue = option.value;
      }
      $cells.push($cell);
      $content.appendChild($cell);
    }

    this.$radioGroup.bind($cells);

    this.$("confirm-button").textContent = props.completionText ?? "Confirm";
    this.$("cancel-button").textContent = props.cancelText ?? "Cancel";

    return this;
  }

  onModalDismiss(): void {
    this.resolve?.(null);
    this.resolve = null;
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$style,
    Divider.$hr,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 440px;
        --std-modal-min-height: 0px;
        background: var(--bg);
        border-radius: 12px;
      }

      #root {
        height: 100%;
        position: relative;
      }

      #header {
        padding: 20px;
      }

      #title {
        --margin-bottom: 8px;
      }

      #description {
        color: var(--text-sec);
      }

      hr {
        margin: 0;
      }

      #event-preview {
        padding: 28px 20px;
      }

      #event-popover {
        padding: 16px 12px;
      }

      #content {
        padding: 20px;
        gap: 8px;
      }

      #footer {
        padding: 12px 20px;
        gap: 12px;
        justify-content: flex-end;
        border-top: 1px solid var(--divider);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-round id="bg" floating></std-round>
      <std-col id="header">
        <h1 id="title" class="h6"></h1>
        <p id="description" class="small"></p>
      </std-col>
      <hr />
      <std-center id="event-preview">
        <std-round id="event-popover" bg="var(--bg)" radius="20" shadow="0 1px 2px rgba(0,0,0,0.4)">
          <std-event-details-content id="event-details">
            <std-editable-avatar id="avatar" slot="icon" style="margin-right:16px;"></std-editable-avatar>
          </std-event-details-content>
        </std-round>
      </std-center>
      <hr />
      <std-col id="content"></std-col>
      <std-row id="footer">
        <button id="cancel-button">Cancel</button>
        <button id="confirm-button" primary>Confirm</button>
      </std-row>
    </std-col>
  `;
}

export namespace TimezoneConfirmationModal {
  export interface TimezoneOption {
    label: string;
    description: string | HTMLElement;
    value: string;
    isDefault?: boolean;
    resolvedTime: DateTimeRegion.Range;
  }

  export interface Props {
    title: string;
    description?: string;
    options: TimezoneOption[];
    eventTitle: string;
    eventIcon: string;
    eventIconBg: string;
    completionText?: string;
    cancelText?: string;
  }

  export type Result = { selectedTimezone: string } | null;

  export type TimeRangeInfo = TimezoneTimeRangeCaption.TimeRangeInfo;

  export function createTimeRangeDescription(
    givenTz: TimeRangeInfo,
    utc: TimeRangeInfo,
    localTz: TimeRangeInfo,
  ): HTMLElement {
    return TimezoneTimeRangeCaption.make().bind({ givenTz, utc, localTz });
  }
}
