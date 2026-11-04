import { Storybook } from "../../ui/storybook";
import { InputLayout } from "./input-layout";

export class InputLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "Input Layout";
  }

  tags(): string[] {
    return ["std-input-layout"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With Label Only",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Username",
          });

          const $input = document.createElement("input");
          $input.type = "text";
          $input.placeholder = "Enter username";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "With Label and Caption",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Email",
            caption: "We'll never share your email",
          });

          const $input = document.createElement("input");
          $input.type = "email";
          $input.placeholder = "you@example.com";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "With Description",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Password",
            description: "Must be at least 8 characters",
            caption: "Use a mix of letters and numbers",
          });

          const $input = document.createElement("input");
          $input.type = "password";
          $input.placeholder = "Enter password";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Required Field",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Full Name",
            required: true,
          });

          const $input = document.createElement("input");
          $input.type = "text";
          $input.placeholder = "John Doe";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Invalid State",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Email",
            caption: "Please enter a valid email address",
            invalid: true,
          });

          const $input = document.createElement("input");
          $input.type = "email";
          $input.value = "invalid-email";
          $input.style.borderColor = "var(--red)";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Textarea",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Description",
            description: "Tell us about yourself",
          });

          const $textarea = document.createElement("textarea");
          $textarea.placeholder = "Enter your description...";
          $layout.appendChild($textarea);

          return $layout;
        },
      },
      {
        title: "Select Dropdown",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Country",
            caption: "Select your country of residence",
          });

          const $select = document.createElement("select");
          const options = ["", "United States", "Canada", "United Kingdom"];
          for (const opt of options) {
            const $opt = document.createElement("option");
            $opt.value = opt;
            $opt.textContent = opt || "Select a country...";
            if (!opt) $opt.disabled = true;
            $select.appendChild($opt);
          }
          $layout.appendChild($select);

          return $layout;
        },
      },
      {
        title: "Color Input",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Theme Color",
            caption: "Choose your preferred accent color",
          });

          const $input = document.createElement("input");
          $input.type = "color";
          $input.value = "#3b82f6";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Date Input",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Birth Date",
            required: true,
          });

          const $input = document.createElement("input");
          $input.type = "date";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Number Input",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Quantity",
            caption: "Enter a value between 1 and 100",
          });

          const $input = document.createElement("input");
          $input.type = "number";
          $input.min = "1";
          $input.max = "100";
          $input.value = "1";
          $layout.appendChild($input);

          return $layout;
        },
      },
      {
        title: "Label, field text and caption on one edge",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Kind",
            caption: "How the machine is reached.",
          });

          const $select = document.createElement("select");
          for (const label of ["macOS", "Ubuntu"]) {
            const $option = document.createElement("option");
            $option.textContent = label;
            $select.appendChild($option);
          }
          $layout.appendChild($select);

          return $layout;
        },
      },
      {
        title: "Retune the field, and the lines follow it",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({
            label: "Kind",
            caption: "How the machine is reached.",
          });

          const $select = document.createElement("select");
          for (const label of ["macOS", "Ubuntu"]) {
            const $option = document.createElement("option");
            $option.textContent = label;
            $select.appendChild($option);
          }
          $layout.appendChild($select);

          $layout.style.setProperty("--input-pad-x", "20px");
          return $layout;
        },
      },
      {
        title: "An error on a non-text row",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({ label: "Kind", caption: "How the machine is reached." });

          const $select = document.createElement("select");
          for (const label of ["macOS", "Ubuntu"]) {
            const $option = document.createElement("option");
            $option.textContent = label;
            $select.appendChild($option);
          }
          $layout.appendChild($select);

          $layout.setInvalid(true, "pick a kind before continuing");
          return $layout;
        },
      },
      {
        title: "The error follows the field too",
        render: () => {
          const $layout = InputLayout.make();
          $layout.bind({ label: "Kind", caption: "How the machine is reached." });

          const $select = document.createElement("select");
          for (const label of ["macOS", "Ubuntu"]) {
            const $option = document.createElement("option");
            $option.textContent = label;
            $select.appendChild($option);
          }
          $layout.appendChild($select);

          $layout.style.setProperty("--input-pad-x", "20px");
          $layout.setInvalid(true, "pick a kind before continuing");
          return $layout;
        },
      },
    ];
  }
}
