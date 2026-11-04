import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Toast } from "../toast/toast";
import { Checkbox } from "./checkbox";

export class CheckboxStoryBook extends Storybook.Default {
  title(): string {
    return "Checkbox";
  }

  tags(): string[] {
    return ["std-checkbox"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Checkbox",
        render: () => {
          return Checkbox.makeWith({
            onChange: (checked) => {
              Toast.info(`Checkbox is ${checked ? "checked" : "unchecked"}`);
            },
          });
        },
      },
      {
        title: "Round Checkbox",
        render: () => {
          return Checkbox.makeWith({
            round: true,
            onChange: (checked) => {
              Toast.info(`Checkbox is ${checked ? "checked" : "unchecked"}`);
            },
          });
        },
      },
      {
        title: "Round Checkbox (Large)",
        render: () => {
          return Checkbox.makeWith({
            round: true,
            onChange: (checked) => {
              Toast.info(`Checkbox is ${checked ? "checked" : "unchecked"}`);
            },
          }).assignStyles({
            "--size": "24px",
          });
        },
      },
    ];
  }
}

export class CheckboxCellStoryBook extends Storybook.Default {
  title(): string {
    return "Checkbox Cell";
  }

  tags(): string[] {
    return ["std-checkbox-cell"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return Storybook.fill(Checkbox.Cell.makeWith({
            title: "I agree to the terms and conditions",
            options: {
              checked: true,
              $subtitle: Typography.caption(
                "By checking this, you waive your rights",
                "small",
              ).assignStyles({
                color: "var(--text-ter)",
              }),
              onCheckedChanged: (_$cell, checked) => {
                Toast.info(
                  `Terms and Conditions: ${checked ? "enabled" : "disabled"}`,
                );
              },
            },
          }), "320px");
        },
      },
    ];
  }
}
