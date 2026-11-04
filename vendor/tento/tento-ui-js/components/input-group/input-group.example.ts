import "../input/text-input";

import { SearchIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { TextInput } from "../input/text-input";
import { InputGroup } from "./input-group";

function $group(props: InputGroup.Props, placeholder: string): InputGroup {
  const $g = InputGroup.makeWith(props);
  $g.appendChild(TextInput.makeWith({ placeholder, onChange: () => {} }));
  return $g;
}

export class InputGroupStoryBook extends Storybook.Default {
  title(): string {
    return "Input Group";
  }

  tags(): string[] {
    return ["std-input-group"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Text prefix and suffix", render: () => $group({ leading: "https://", trailing: ".lona.so", label: "Workspace", helper: null, error: null }, "acme") },
      { title: "Glyph prefix", render: () => $group({ leading: { svg: SearchIcon }, trailing: null, label: null, helper: null, error: null }, "Search") },
      { title: "With an error", render: () => $group({ leading: "$", trailing: "USD", label: "Amount", helper: null, error: "Enter a number." }, "0.00") },
    ];
  }
}
