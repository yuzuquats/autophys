import { Center } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { TimeScaleSelector } from "./time-scale-selector";
import { Round } from "../round";
import { Toast } from "../toast/toast";

export class TimeScaleSelectorStoryBook extends Storybook.Default {
  title(): string {
    return "Time Scale Selector";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Time Scale Selector",
        render: () => {
          const $content = Center.make().assignStyles({
            height: "320px",
            width: "100%",
          });
          $content.appendChild(
            Round.makeWithContent(
              TimeScaleSelector.makeWith({
                value: 1,
                type: "day",
                onChange: (value, type, usePersonalTimezone) => {
                  Toast.info(
                    `${value} ${type}${value > 1 ? "s" : ""}` +
                      (usePersonalTimezone ? " (personal tz)" : ""),
                  );
                },
              }),
              Round.Props.MODAL,
            ).assignStyles({ height: "unset", padding: "24px 12px" }),
          );
          return $content;
        },
      },
      {
        title: "Preselected",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("3 years");
          const $content = Center.make().assignStyles({
            height: "320px",
            width: "100%",
          });
          $content.appendChild(
            Round.makeWithContent(
              TimeScaleSelector.makeWith({
                value: 3,
                type: "year",
                onChange: (value, type, usePersonalTimezone) => {
                  $status.bindText(
                    `${value} ${type}${value > 1 ? "s" : ""}` +
                      (usePersonalTimezone ? " (personal tz)" : ""),
                  );
                },
              }),
              Round.Props.MODAL,
            ).assignStyles({ height: "unset", padding: "24px 12px" }),
          );
          return {
            $status,
            $content,
          };
        },
      },
    ];
  }
}
