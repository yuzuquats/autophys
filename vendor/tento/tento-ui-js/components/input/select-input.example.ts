import { Storybook } from "../../ui/storybook";
import { SelectInput } from "./select-input";

export class SelectInputStoryBook extends Storybook.Default {
  title(): string {
    return "Select Input";
  }

  tags(): string[] {
    return ["std-select-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic",
        render: () => {
          const $input = SelectInput.makeWith({
            label: "Country",
            name: "country",
            placeholder: "Select a country",
            options: [
              { label: "United States", value: "us" },
              { label: "Canada", value: "ca" },
              { label: "United Kingdom", value: "uk" },
            ],
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "With onChange",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Selected: light");
          const $input = SelectInput.makeWith({
            label: "Theme",
            name: "theme",
            value: "light",
            options: [
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
              { label: "System", value: "system" },
            ],
            onChange: (value) => {
              $status.bindText(`Selected: ${value}`);
            },
          });
          $input.style.width = "300px";
          return { $content: $input, $status };
        },
      },
      {
        title: "Required",
        render: () => {
          const $input = SelectInput.makeWith({
            label: "Priority",
            name: "priority",
            placeholder: "Choose priority",
            required: true,
            options: [
              { label: "Low", value: "low" },
              { label: "Medium", value: "medium" },
              { label: "High", value: "high" },
            ],
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Disabled",
        render: () => {
          const $input = SelectInput.makeWith({
            label: "Plan",
            name: "plan",
            value: "pro",
            disabled: true,
            options: [
              { label: "Free", value: "free" },
              { label: "Pro", value: "pro" },
              { label: "Enterprise", value: "enterprise" },
            ],
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "No label",
        render: () => {
          const $input = SelectInput.makeWith({
            name: "sort",
            placeholder: "Sort by...",
            options: [
              { label: "Name (A-Z)", value: "name_asc" },
              { label: "Name (Z-A)", value: "name_desc" },
              { label: "Date (Newest)", value: "date_desc" },
            ],
          });
          $input.style.width = "200px";
          return $input;
        },
      },
    ];
  }
}
