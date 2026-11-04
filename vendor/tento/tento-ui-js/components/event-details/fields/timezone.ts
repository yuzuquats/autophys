import "@tento-ui/components/controls/switch";
import "@tento-ui/components/icon-button";

import { EventDetailsField } from "@tento-ui/components/event-details/event-details-field";
import { DateTimeRangeModal } from "../datetime-range-modal";
import { EventTime } from "../event-time";
import { html } from "../../../component";
import { component } from "../../../component-decorators";
import { css, Style } from "../../../component-styles";
import { IconButton } from "@tento-ui/components/icon-button";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { ToggleFieldBase } from "./toggle-field-base";
import questionIcon from "@tento-ui/icons/question.svg";

export namespace EventDetailsFieldTimezone {
  @component({
    name: "std-event-details-field-timezone-input",
  })
  export class Input extends ToggleFieldBase {
    $info: IconButton = this.hydrate("info");

    $modal: Option<DateTimeRangeModal>;
    modalContext: Option<string>;
    callbacks: Option<Callbacks>;

    protected label = "This is a flight";

    constructor() {
      super();
      this.$info.bindIcon(questionIcon);
      // The info button is its own hit target: its pointerup stops propagation
      // before the whole-row toggle handler runs, so tapping it opens the doc
      // without flipping the flight switch.
      GESTURE_MANAGER.addPointerEvent(this.$info, {
        onClick: (_captured, _offset, e) => {
          this.callbacks?.onInfoClick?.();
        },
      });
    }

    bind(callbacks: Callbacks, modalContext: string, isEnabled: boolean) {
      this.callbacks = callbacks;
      this.modalContext = modalContext;
      this.$switch.setChecked(isEnabled);
    }

    protected onToggle(enabled: boolean): void {
      if (enabled) {
        this.showModal();
      }
      this.callbacks?.onEnableTimezone?.(enabled);
    }

    showModal() {
      const dtr = this.callbacks?.onShowModal?.();
      if (!dtr) return;
      this.$modal?.dismiss();
      this.$modal = DateTimeRangeModal.show({
        title: "Traveling to timezone",
        initialData: dtr,
        onSave: (date) => {
          this.callbacks?.onUpdate?.(date);
        },
        modalContext: this.modalContext,
        start: {
          disableEditing: true,
        },
        end: {},
      });
    }

    dismissModal() {
      this.$modal?.dismiss();
      this.$modal = null;
    }

    static $styles: Style.Compat[] = [
      ToggleFieldBase.$rowStyle,
      css`
        #label-group {
          align-items: center;
          gap: 4px;
        }

        #info {
          --std-icon-button-dimension: 20px;
          --std-icon-button-padding: 4px;
          --std-icon-background-color: var(--bg-surface-light);
          --std-icon-hover-color: var(--bg-hover);
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-row id=root>
        <std-row id=label-group>
          <p id=label class=small></p>
          <std-icon-button id="info" aria-label="About flight mode"></std-icon-button>
        </std-row>
        <std-switch id="switch"></std-switch>
      </std-row>
    `;
  }

  export type Callbacks = Optional<{
    onShowModal: () => Option<EventTime>;
    onUpdate: (eventTime: EventTime) => void;
    onEnableTimezone: (b: boolean) => void;
    onInfoClick: () => void;
  }>;

  export function make(): EventDetailsField<Input> {
    return EventDetailsField.makeWith(Input.make());
  }
}
