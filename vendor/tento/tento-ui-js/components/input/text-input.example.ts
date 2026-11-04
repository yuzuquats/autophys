import { Column } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { TextInput } from "./text-input";

export class TextInputStoryBook extends Storybook.Default {
  title(): string {
    return "Text Input";
  }

  tags(): string[] {
    return ["std-text-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic with label",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Username",
            name: "username",
            placeholder: "Enter your username",
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Required field",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Email Address",
            name: "email",
            type: "email",
            placeholder: "you@example.com",
            required: true,
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "With helper text",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Password",
            name: "password",
            type: "password",
            placeholder: "Enter a strong password",
            helperText: "Must be at least 8 characters",
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Required with helper",
        render: () => {
          const $input = TextInput.makeWith({
            label: "API Key",
            name: "apiKey",
            placeholder: "sk-xxxxxxxxxxxx",
            required: true,
            helperText: "You can find this in your dashboard settings",
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Different types",
        render: () => {
          const $col = Column.make();
          $col.style.gap = "8px";
          $col.style.width = "300px";

          const types: Array<"text" | "email" | "password" | "url" | "tel" | "search"> = [
            "text",
            "email",
            "password",
            "url",
            "tel",
            "search",
          ];

          for (const type of types) {
            const $input = TextInput.makeWith({
              label: type.charAt(0).toUpperCase() + type.slice(1),
              name: type,
              type: type,
              placeholder: `Enter ${type}...`,
            });
            $col.appendChild($input);
          }

          return $col;
        },
      },
      {
        title: "Disabled state",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Disabled Input",
            name: "disabled",
            value: "Cannot edit this",
            disabled: true,
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "With onChange callback",
        render: () => {
          const $col = Column.make();
          $col.style.gap = "8px";
          $col.style.width = "300px";

          const $status = Typography.p("Type something...");
          $status.style.color = "var(--text-ter)";

          const $input = TextInput.makeWith({
            label: "Live Update",
            name: "live",
            placeholder: "Start typing...",
            onChange: (value) => {
              $status.textContent = value ? `You typed: "${value}"` : "Type something...";
            },
          });

          $col.appendChild($input);
          $col.appendChild($status);

          return $col;
        },
      },
      {
        title: "No label",
        render: () => {
          const $input = TextInput.makeWith({
            name: "search",
            type: "search",
            placeholder: "Search...",
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Label, field text and helper on one edge",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Host id",
            name: "id",
            placeholder: "rwc-04",
            helperText: "Lowercase letters, digits and dashes.",
          });
          $input.style.width = "300px";
          return $input;
        },
      },
      {
        title: "Retune the field, and the lines follow it",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Host id",
            name: "id",
            placeholder: "rwc-04",
            helperText: "Lowercase letters, digits and dashes.",
          });
          $input.style.width = "300px";
          $input.style.setProperty("--input-pad-x", "20px");
          return $input;
        },
      },
      {
        title: "A field error, on that same edge",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Host id",
            name: "id",
            value: "gcp-05",
          });
          $input.style.width = "300px";
          $input.setInvalid(true, "gcp-05 is already in the fleet");
          return $input;
        },
      },
      {
        title: "The error follows the field too",
        render: () => {
          const $input = TextInput.makeWith({
            label: "Host id",
            name: "id",
            value: "gcp-05",
          });
          $input.style.width = "300px";
          $input.style.setProperty("--input-pad-x", "20px");
          $input.setInvalid(true, "gcp-05 is already in the fleet");
          return $input;
        },
      },
      {
        // The only view that shows the pooling path. `make()` hands back a
        // previously used instance, so an input whose listeners were removed on
        // its last detach comes back rendering correctly and reporting nothing.
        // `_recycle` is the synchronous half of `recycle()` — used directly here
        // because the deferred half would make this story depend on frame
        // timing, and a card that flakes is worse evidence than no card.
        title: "A reused instance still reports changes",
        render: () => {
          const $used = TextInput.make();
          TextInput._recycle($used);
          const $input = TextInput.makeWith({
            label: "Type here — this input came back out of the pool",
            name: "reused",
            placeholder: "each keystroke calls onChange",
            onChange: (value) => Tracing.log("text-input.reused", { value }),
          });
          $input.style.width = "300px";
          return $input;
        },
      },
    ];
  }
}
