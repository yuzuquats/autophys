import { Storybook } from "../../ui/storybook";
import { NumberField } from "./number-field";

function $field(over: Partial<NumberField.Props>): NumberField {
  let value: Option<number> = over.value ?? 3;
  const $f = NumberField.make();
  const base: NumberField.Props = { value: null, min: 0, max: 10, step: 1, label: "Guests", onChange: () => {}, format: null };
  const rebind = () => $f.bind({ ...base, ...over, value, onChange: (v) => { value = v; rebind(); } });
  rebind();
  $f.style.maxWidth = "200px";
  return $f;
}

export class NumberFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Number Field";
  }

  tags(): string[] {
    return ["std-number-field"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "0–10, step 1 (arrows step; Shift ×10)", render: () => $field({}) },
      { title: "Currency format, step 0.5", render: () => $field({ value: 12.5, min: 0, max: null, step: 0.5, label: "Price", format: { style: "currency", currency: "USD" } }) },
    ];
  }
}
