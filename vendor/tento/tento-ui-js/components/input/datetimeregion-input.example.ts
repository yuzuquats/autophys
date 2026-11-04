import {
  DateTime,
  DateTimeRegion,
  TimezoneRegion,
  Tzname,
} from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Typography } from "../../ui/typography";
import { DateTimeRegionInput } from "./datetimeregion-input";
import { Toast } from "../toast/toast";

export class DateTimeRegionInputStoryBook {
  tags(): string[] {
    return ["std-datetimeregion-input"];
  }

  title() {
    return "DateTime Region Input";
  }

  preview() {
    return {
      title: "DateTime Region Input Preview",
      render: () => {
        return DateTimeRegionInput.makeWith({
          onChange: (dtr) => {
            Toast.info("Preview datetime with timezone:", {
              description: dtr?.toString(),
            });
          },
        });
      },
    };
  }

  examples() {
    return [
      {
        title: "Basic DateTime Region Input",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $input = DateTimeRegionInput.makeWith({
            onChange: (dtr) => {
              $result.textContent = `Selected: ${dtr?.toString()}`;
            },
            onInvalid: (message) => {
              $result.textContent = `Invalid: ${message}`;
              Tracing.dev("Invalid input:", message);
            },
          });

          const $result = Typography.p("No datetime/timezone selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($input);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "With Initial Values",
        render: async () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const now = DateTime.utc.now();
          const timezone = "America/New_York" as Tzname;
          const tz = await TimezoneRegion.get(timezone);
          // Use the UTC NaiveDateTime directly - DateTimeRegion will handle timezone conversion
          const dtr = new DateTimeRegion(now.ndt, tz);

          const $input = DateTimeRegionInput.makeWith({
            value: dtr,
            onChange: (dtr) => {
              $result.textContent = `Selected: ${dtr?.toString()}`;
            },
          });

          const $result = Typography.p(
            `Initial: ${dtr.toString()} in ${timezone}`,
          );
          $result.style.marginTop = "12px";

          $container.appendChild($input);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "Custom Placeholders",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $input = DateTimeRegionInput.makeWith({
            onChange: (dtr) => {
              $result.textContent = `Selected: ${dtr?.toString()}`;
            },
            options: {
              placeholders: {
                date: "Pick date",
                time: "Pick time",
                timezone: "Pick Timezone",
              },
            },
          });

          const $result = Typography.p("Using custom placeholders");
          $result.style.marginTop = "12px";

          $container.appendChild($input);
          $container.appendChild($result);

          return $container;
        },
      },
    ];
  }
}
