import { EventDetailsField } from "@tento-ui/components/event-details/event-details-field";
import { RecurrenceInput } from "../../input/recurrence-input";

export namespace EventDetailsFieldRecurrenceInput {
  export function make(): EventDetailsField<RecurrenceInput> {
    const $e = EventDetailsField.make();
    $e.assignStyles({
      padding: "0px",
    });

    const $recurrenceInput = RecurrenceInput.make();
    $recurrenceInput.assignStyles({
      width: "100%",
      background: "transparent",
    });
    $e.appendChild($recurrenceInput);

    return $e as EventDetailsField<RecurrenceInput>;
  }
}

// static makeEditable(
//   text: Option<string>,
//   placeholder: Option<string>,
// ): EventDetailsField<EditableText> {
//   const $e = EventDetailsField.make();
//   const $editor = EditableText.make();
//   $editor.style.width = "100%";
//   $editor.bind(text, placeholder);
//   $e.appendChild($editor);
//   // $e.addPointerEvent({
//   //   onClick: () => $editor.enableEditing(true, true),
//   // });
//   // $e.onClickOutside = () => {
//   //   $editor.blur();
//   // };
//   return $e as EventDetailsField<EditableText>;
// }
