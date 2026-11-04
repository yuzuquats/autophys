import {
  Duration,
  NaiveTime,
  TimeOfDay,
  TimeWithMeridiem,
} from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomEventUtils } from "../../dom-event-utils";
import { Tracing } from "@tento-core/tracing";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { Tooltip } from "../tooltip/tooltip";

@component({
  name: "std-time-picker",
})
export class TimePicker extends LonaWebComponent {
  private $root = this.$("root");
  private $textInput = this.$("time-text-input");

  onSelected: Option<TimePicker.SelectedCallback>;
  onPending: Option<TimePicker.PendingCallback>;

  pendingTime: Option<TimeOfDay>;

  constructor() {
    super();

    for (let i = 0; i < 24; i += 0.25) {
      const time = TimeOfDay.wrap({
        hrs: i,
      });

      const $child = Button.makeLight();
      $child.replaceChildren(
        Typography.small(TimeOfDay.Formatter.render(time)),
      );
      $child.setAttribute("hr", time.toString());
      $child.onpointerup = (e) => {
        e.stopPropagation();
        this.bind(time);
      };
      this.$root.appendChild($child);
    }

    this.$textInput.onpointerup = DomEventUtils.STOP_PROPAGATION;
    this.$textInput.onkeydown = DomEventUtils.STOP_PROPAGATION_BLUR_ON_ENTER(
      () => this.$textInput.blur(),
    );
    this.$textInput.onkeyup = (e) => {
      this.clearError();
      if (this.$textInput.textContent === "") {
        return;
      }
      const timemr = TimeWithMeridiem.parse(this.$textInput.textContent!);
      if (!timemr) {
        this.showErrorString("Invalid Time");
        return;
      }

      const time = timemr.resolve("am");
      if (!time) {
        this.showErrorString("Invalid Time");
        return;
      }

      this.bind(time.time);
    };

    this.onblur = () => {
      this.clearError();
      this.$("time-text-input").textContent = this.pendingTime
        ? NaiveTime.Formatter.render(this.pendingTime)
        : null;
    };
  }

  bind(time: TimeOfDay) {
    if (!this.onPending) {
      this.bindSelected(time);
      return;
    }

    const pending = this.onPending(time);
    if (typeof pending === "string") {
      this.showErrorString(pending);
      return;
    }

    this.bindSelected(pending);
  }

  private bindSelected(time: TimeOfDay) {
    this.clearError();
    this.$qs_maybe(`[selected]`)?.toggleAttribute("selected", false);
    const $selectedTime = this.$qs_maybe(`[hr="${time.toString()}"]`);
    if (!$selectedTime) return;
    $selectedTime.toggleAttribute("selected", true);
    // $selectedTime.scrollIntoView({
    //   behavior: "auto",
    //   block: "center",
    //   inline: "center",
    // });
    this.pendingTime = time;
    this.$textInput.textContent = NaiveTime.Formatter.render(time);
    this.onSelected && this.onSelected(time);
  }

  private clearError() {
    this.toggleAttribute("invalid", false);
    this.removeAttribute("tooltip");
  }

  private showErrorString(text: string) {
    this.toggleAttribute("invalid", true);
    this.setAttribute("tooltip", text);
  }

  static $styles = [
    Button.$style,
    css(/* css */ `
      :host([invalid])::before {
        ${Tooltip.mixin}
        right: 8px;
        width: max-content;
        top: -4px;
        z-index: 99;
      }
    `),
    css`
      #root {
        height: 100%;
        width: 120px;
        align-items: stretch;
        padding-bottom: 8px;
        padding-right: 8px;
        overflow-y: scroll;
      }
      #time-text-input-container {
        background-color: var(--bg-elevated);
        position: sticky;
        top: 0px;
        border-radius: 8px;
      }
      #time-text-input {
        height: 100%;
        width: 100%;
        padding: 10px 12px;
        cursor: text;
        text-align: center;
      }
      :host([invalid]) #time-text-input {
        background-color: #fce8e6;
      }
      :host {
        position: relative;
      }
      #time-text-input:focus {
        outline: none;
      }
      button[selected] {
        background-color: var(--bg-selected);
      }
      button {
        padding: 8px 4px;
      }
      button:first-of-type {
        margin-top: 4px;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <div id="time-text-input-container">
        <p
          id="time-text-input"
          class="small"
          contenteditable
          placeholder="Type a time"
        ></p>
      </div>
    </std-col>
  `;
}

export namespace TimePicker {
  export type SelectedCallback = (time: TimeOfDay) => void;

  export type PendingCallback = (time: TimeOfDay) => TimeOfDay | string;
}
