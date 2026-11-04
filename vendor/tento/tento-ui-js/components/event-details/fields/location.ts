import { EventDetailsField } from "@tento-ui/components/event-details/event-details-field";
import { EditableText } from "@tento-ui/components/editable-text";

export namespace EventDetailsFieldLocation {
  export function make(): EventDetailsField<EditableText> {
    const $e = EventDetailsField.make().assignStyles({
      padding: "9px 12px",
    });

    const $location = EditableText.make();
    $location.assignStyles({
      width: "100%",
      "--font-size": "var(--small-size)",
      color: "var(--text-sec)",
    });
    $location.bind(null, "Add a location");
    $e.appendChild($location);

    return $e as unknown as EventDetailsField<EditableText>;
  }
}
