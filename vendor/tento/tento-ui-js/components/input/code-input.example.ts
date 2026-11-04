import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { CodeInput } from "./code-input";

export class CodeInputStoryBook extends Storybook.Default {
  title(): string {
    return "Code Input";
  }

  tags(): string[] {
    return ["std-code-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => {
          return CodeInput.makeWith({});
        },
      },
      {
        title: "With onComplete callback",
        render: () => {
          const $col = Column.make();
          $col.style.gap = "16px";
          $col.style.alignItems = "center";

          const $status = Typography.p("Enter a 6-digit code");
          $status.style.color = "var(--text-ter)";

          const $input = CodeInput.makeWith({
            onChange: (value) => {
              $status.textContent = value
                ? `Code: ${value} (${value.length}/6)`
                : "Enter a 6-digit code";
            },
            onComplete: (value) => {
              $status.textContent = `Complete: ${value}`;
              $status.style.color = "var(--green)";
            },
          });

          $col.appendChild($input);
          $col.appendChild($status);
          return $col;
        },
      },
      {
        title: "Masked five-digit PIN",
        render: () => {
          return CodeInput.makeWith({ digitCount: 5, masked: true });
        },
      },
      {
        title: "Invalid state",
        render: () => {
          const $input = CodeInput.makeWith({});
          $input.setValue("12345");
          $input.setInvalid(true);
          return $input;
        },
      },
    ];
  }
}
