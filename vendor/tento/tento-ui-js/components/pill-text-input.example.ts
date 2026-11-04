import { Storybook } from "../ui/storybook";
import { PillTextInput } from "./pill-text-input";

export class PillTextInputStoryBook extends Storybook.Default {
  title(): string {
    return "Pill Text Input";
  }

  tags(): string[] {
    return ["std-pill-text-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pill Text Input",
        render: () => {
          const $component = PillTextInput.makeWith({
            pills: ["success", "warning", "error", "info"],
            placeholder: "Add status tags...",
            colorFn: (text) => {
              switch (text.toLowerCase()) {
                case "success":
                  return "var(--green-dimmed)";
                case "warning":
                  return "var(--yellow-dimmed)";
                case "error":
                  return "var(--red-dimmed)";
                case "info":
                  return "var(--blue-dimmed)";
                default:
                  return "var(--gray-dimmed)";
              }
            },
            onChange: (pills) => {
              console.log("Status pills:", pills);
            },
          });
          return $component;
        },
      },
      {
        title: "With Initial Pills",
        render: () => {
          const $component = PillTextInput.makeWith({
            pills: ["javascript", "typescript", "react", "vue"],
            placeholder: "Add more tags...",
            onChange: (pills) => {
              console.log("Pills changed:", pills);
            },
          });
          return $component;
        },
      },
      {
        title: "Email Validator",
        render: () => {
          const $component = PillTextInput.makeWith({
            pills: ["hello@lona.so"],
            placeholder: "Enter email addresses...",
            validator: (text) => {
              const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
              return emailRegex.test(text);
            },
            onChange: (pills) => {
              console.log("Valid emails:", pills);
            },
          });
          return $component;
        },
      },
      {
        title: "Empty",
        render: () => {
          const $component = PillTextInput.makeWith({
            placeholder: "Type tags and press space or enter...",
            onChange: (pills) => {
              console.log("Pills changed:", pills);
            },
          });
          return $component;
        },
      },
    ];
  }
}
