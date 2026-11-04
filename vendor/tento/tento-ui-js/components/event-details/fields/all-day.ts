import { component } from "../../../component-decorators";
import { EventDetailsContent } from "../event-details-content";
import { ToggleFieldBase } from "./toggle-field-base";

@component({
  name: "std-all-day-field",
})
export class AllDayField extends ToggleFieldBase {
  protected label = "All-day";

  static makeWith(): AllDayField {
    const $e = AllDayField.make();
    $e.bind(null, false);
    return $e;
  }

  bind(onChange: Option<(enabled: boolean) => void>, initialEnabled: boolean) {
    this.onChangeCb = onChange;
    this.$switch.setChecked(initialEnabled);
  }
}

export namespace EventDetailsFieldAllDay {
  export function make(): EventDetailsContent.Field<AllDayField> {
    return EventDetailsContent.Field.makeWith(AllDayField.makeWith());
  }
}
