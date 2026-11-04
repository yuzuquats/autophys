import { Storybook } from "../../ui/storybook";
import { TextArea } from "./text-area";

const base: TextArea.Props = {
  value: "", label: "Notes", placeholder: "Anything the next reader should know", rows: 3, autoGrow: false,
  maxLength: null, helper: null, error: null, disabled: false, required: false, name: null,
  onChange: () => {}, onBlur: null,
};

function $area(over: Partial<TextArea.Props>): TextArea {
  let value = over.value ?? base.value;
  const $t = TextArea.make();
  const rebind = () => $t.bind({ ...base, ...over, value, onChange: (v) => { value = v; rebind(); } });
  rebind();
  return Storybook.fill($t, "320px");
}

export class TextAreaStoryBook extends Storybook.Default {
  title(): string {
    return "Text Area";
  }

  tags(): string[] {
    return ["std-text-area"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Plain, three rows", render: () => $area({}) },
      { title: "Auto-grow with a count", render: () => $area({ autoGrow: true, rows: 1, maxLength: 140, helper: "Grows as you type" }) },
      { title: "Required, with an error", render: () => $area({ required: true, error: "Say what changed.", value: "" }) },
      { title: "Disabled", render: () => $area({ disabled: true, value: "Read-only note" }) },
    ];
  }
}
