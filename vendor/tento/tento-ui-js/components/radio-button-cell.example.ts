import { Row } from "../component-builtin";
import { DomUtils } from "../dom";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { NumberInput } from "./input/number-input";
import { RadioButtonCell } from "./radio-button-cell";
import { Toast } from "./toast/toast";

export class RadioButtonCellStoryBook extends Storybook.Default {
  title(): string {
    return "Radio Button Cell";
  }

  tags(): string[] {
    return ["std-radio-button-cell"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Using RadioButtonCell.Group",
        render: () => {
          const group = new RadioButtonCell.Group({
            onSelected: ($cell) => {
              Toast.info(`Selected Option ${$cell.title}`);
              return true;
            },
          });
          const $cells: RadioButtonCell[] = [
            RadioButtonCell.makeWith({
              title: "Apples",
              options: {
                $subtitle: Typography.caption(
                  "Pretty crunchy but not my favorite",
                ).assignStyles({
                  color: "var(--text-ter)",
                }),
                name: "group-example",
                value: "option-a",
              },
            }),
            RadioButtonCell.makeWith({
              title: "Oranges",
              options: {
                $subtitle: Typography.caption("Very juicy").assignStyles({
                  color: "var(--text-ter)",
                }),
                name: "group-example",
                value: "option-b",
              },
            }),
            RadioButtonCell.makeWith({
              title: "Blueberries",
              options: {
                $subtitle: Typography.caption("Great in pies").assignStyles({
                  color: "var(--text-ter)",
                }),
                name: "group-example",
                value: "disabled",
              },
            }),
            RadioButtonCell.makeWith({
              title: "Custom Amount",
              options: {
                $subtitle: (() => {
                  const $inputRow = Row.make();
                  $inputRow.assignStyles({
                    gap: "8px",
                    alignItems: "center",
                    marginTop: "0px",
                  });

                  const $numberInput = NumberInput.make();
                  $numberInput.bind(5, { placeholder: "5" });
                  $numberInput.enableEditing();
                  $numberInput.toggleAttribute("opaque", true);
                  $numberInput.assignStyles({
                    height: "32px",
                    width: "40px",
                    paddingInline: "8px",
                  });
                  $inputRow.appendChild($numberInput);

                  const $label = Typography.caption("items");
                  $label.style.color = "var(--text-sec)";
                  $inputRow.appendChild($label);
                  return $inputRow;
                })(),
                name: "group-example",
                value: "custom",
              },
            }),
          ];

          group.bind($cells);
          group.select(group.$cells[0]);
          return group.build();
        },
      },
    ];
  }
}
