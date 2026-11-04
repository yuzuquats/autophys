import "./datetime-range-modal";

import {
  DateTime,
  DateTimeRegion,
  Local,
  TimezoneRegion,
  Tzname,
  Utc,
} from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { Toast } from "../toast/toast";
import { DateTimeRangeModal } from "./datetime-range-modal";
import { EventTime } from "./event-time";
import { FlightStatusCard } from "./flight-status-card";

export class FlightStatusCardStoryBook extends Storybook.Default {
  title(): string {
    return "Flight Status Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Round-trip observation · exact times unknown",
        render: () =>
          FlightStatusCard.make().bindObservation({
            title: "SFO ⇄ LIS · date comparison",
            outbound: { dateLabel: "Nov 12 · outbound", route: "SFO → LIS" },
            returning: { dateLabel: "Nov 16 · return", route: "LIS → SFO" },
          }),
      },
      {
        title: "Flight Status Card",
        render: async () => {
          const $c = FlightStatusCard.make();
          const now = Local.now().withTime();

          // Get timezone regions
          const sfoTz = await TimezoneRegion.get(
            "America/Los_Angeles" as Tzname,
          );
          const snaTz = await TimezoneRegion.get(
            "America/Los_Angeles" as Tzname,
          );

          // Create DateTimeRegion objects
          const departureTime = now.add({ hrs: 16, mins: 40 });
          const arrivalTime = now.add({ hrs: 18, mins: 13 });

          const departureDtr = new DateTimeRegion(
            DateTime.fromMse(departureTime.mse, Utc).ndt,
            sfoTz,
          );
          const arrivalDtr = new DateTimeRegion(
            DateTime.fromMse(arrivalTime.mse, Utc).ndt,
            snaTz,
          );

          const flightRange = new DateTimeRegion.Range(
            departureDtr,
            arrivalDtr,
          );

          $c.bind({
            title: "SFO → SNA",
            time: flightRange,
            onSectionClick: async () => {
              DateTimeRangeModal.show({
                title: "Edit Flight Details",
                initialData: new EventTime(flightRange, false),
                onSave: (data) => {
                  const depWall = data.range.start.asWallClock();
                  const arrWall = data.range.end.asWallClock();
                  Toast.info("Flight info updated", {
                    description:
                      `Departure: ${depWall.ndt.toString()}\nArrival: ${arrWall.ndt.toString()}`,
                  });
                },
              });
            },
          });
          return $c;
        },
      },
    ];
  }
}
