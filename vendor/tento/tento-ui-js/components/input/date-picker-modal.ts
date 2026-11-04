import "../round";

import { NaiveDate } from "@tento-chrono";
import { html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Button } from "../button/button";
import { Overlay } from "../overlay";
import { DatePicker } from "../controls/date-picker";
import { Round } from "../round";

@component({
  name: "std-date-picker-modal",
})
export class DatePickerModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg")
    .bind(Round.Props.MODAL);
  private $datePicker: DatePicker = this.hydrate("date-picker");
  private $cancelButton: HTMLButtonElement = this.hydrate("cancel-button");
  private $selectButton: HTMLButtonElement = this.hydrate("select-button");
  private $title: HTMLElement = this.hydrate("title");

  private onDateSelected?: ((date: Option<NaiveDate>) => void) | undefined;
  private selectedDate: Option<NaiveDate>;

  static async show(
    title: string,
    currentDate: Option<NaiveDate>,
    onDateSelected: (date: Option<NaiveDate>) => void,
  ): Promise<void> {
    const modal = DatePickerModal.make();
    modal.bind(title, currentDate, onDateSelected);
    modal.reveal();
  }

  bind(
    title: string,
    currentDate: Option<NaiveDate>,
    onDateSelected: (date: Option<NaiveDate>) => void,
  ) {
    this.$title.textContent = title;
    this.onDateSelected = onDateSelected;
    this.selectedDate = currentDate;

    const today = NaiveDate.today();
    if (currentDate) {
      this.$datePicker.bindToDate(currentDate, today);
    } else {
      this.$datePicker.bindToToday(today);
    }

    // Handle date selection in the calendar
    this.$datePicker.onSelectedDate = (date) => {
      this.selectedDate = date;
      return true;
    };

    // Handle cancel button
    this.$cancelButton.onclick = () => {
      Overlay.dismiss(this);
    };

    // Handle select button
    this.$selectButton.onclick = () => {
      this.onDateSelected?.(this.selectedDate);
      Overlay.dismiss(this);
    };
  }

  onModalDismiss() {
    // Cleanup
    this.onDateSelected = undefined;
    this.selectedDate = undefined;
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$headerStyle,
    LonaModalWebComponent.$style,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 320px;
      }

      #root {
        position: relative;
        padding: 0;
        display: flex;
        flex-direction: column;
      }

      #content {
        padding: 16px;
        justify-content: center;
        align-items: center;
      }

      #footer {
        padding: 12px 16px;
        border-top: 1px solid var(--divider);
        display: flex;
        justify-content: flex-end;
        gap: 8px;
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
        <std-date-picker id="date-picker"></std-date-picker>
      </std-col>
      <std-row id="footer">
        <button id="cancel-button" secondary>Cancel</button>
        <button id="select-button" primary>Select</button>
      </std-row>
    </std-col>
  `;
}
