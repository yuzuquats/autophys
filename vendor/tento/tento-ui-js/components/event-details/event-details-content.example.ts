import {
  DateTime,
  DateTimeRegion,
  Duration,
  Local,
  TimezoneRegion,
  Utc,
} from "@tento-chrono";
import { Constants } from "@tento-core/constants";
import { Storybook } from "../../ui/storybook";
import { Round } from "../round";
import { EventDetailsContent } from "./event-details-content";

export class EventDetailsContentStoryBook extends Storybook.Default {
  title(): string {
    return "Event Details";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: async () => {
          const $c = Round.makeWith(Round.Props.MODAL).assignStyles({
            padding: "16px 12px",
          });
          const $details = EventDetailsContent.make().bind({
            title: "Brunch with Sally",
            time: DateTimeRegion.Range.fromSingleTz(
              defaultTimeRange(),
              await TimezoneRegion.local(),
            ),
            onUpdateTime: Constants.EMPTY_FUNCTION,
            editable: false,
            modalContext: "storybook",
          });
          $c.appendChild($details);
          return $c;
        },
      },
      {
        render: async () => {
          const $c = Round.makeWith(Round.Props.MODAL).assignStyles({
            padding: "16px 12px",
          });
          const $details = EventDetailsContent.make().bind({
            title: "Brunch with Sally",
            time: DateTimeRegion.Range.fromSingleTz(
              defaultTimeRange(),
              await TimezoneRegion.local(),
            ),
            onUpdateTime: Constants.EMPTY_FUNCTION,
            cta: {
              title: "Join Meeting",
              onAction: Constants.EMPTY_FUNCTION,
            },
            editable: false,
            modalContext: "storybook",
          });
          const $content = EventDetailsContent.FieldContainer.make();
          $content
            .bind(
              {
                time: EventDetailsContent.Field.makeText("Tue, Feb 4"),
                repeats: EventDetailsContent.Field.makeText("Does not repeat"),
                repeats2: EventDetailsContent.Field.makeText("Every tuesday"),
              },
              ["time", "repeats", "repeats2"],
            )
            .bindVisible(new Set(["time", "repeats", "repeats2"]));
          $details.appendChild($content);
          $c.appendChild($details);
          return $c;
        },
      },
    ];
  }
}

function defaultTimeRange(): DateTime.Range<Utc> {
  const start = Local.now().nearest(Duration.Time.MIN15);
  return new DateTime.Range(
    start,
    start.add({
      hrs: 8,
    }),
  ).toUtc();
}
