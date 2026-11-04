import { NumberField } from "./number-field";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function $inputOf($field: NumberField): HTMLInputElement {
  const $input = $field.shadowRoot?.querySelector("input");
  if (!($input instanceof HTMLInputElement)) throw new Error("NumberField input is missing");
  return $input;
}
function type($input: HTMLInputElement, text: string): void {
  $input.value = text;
  $input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
}

export function verifyNumberField(): string[] {
  const passed: string[] = [];
  const values: Option<number>[] = [];
  const $field = NumberField.make();
  let current: Option<number> = 0.25;
  let format: Option<Intl.NumberFormatOptions> = { style: "percent", maximumFractionDigits: 0 };
  const base: NumberField.Props = { value: current, min: null, max: null, step: 0.01, label: "Percentage", format, onChange: (value) => {
    current = value;
    values.push(value);
    $field.bind({ ...base, value, format });
  } };
  $field.bind(base); document.body.appendChild($field);
  const $input = $inputOf($field);
  try {
    $input.focus();
    check($input.value === "0.25", "Focused percentage must edit the raw value");
    type($input, "0.26");
    check(current === 0.26 && $input.value === "0.26", "Rebinding on input must preserve the raw edit");
    $input.blur();
    check($input.value === new Intl.NumberFormat(undefined, base.format ?? undefined).format(0.26), "Blur must restore percent formatting");
    passed.push("percent editing reports a fraction and formats on blur");

    format = { style: "currency", currency: "USD" };
    $field.bind({ ...base, value: 12.5, label: "Price", format });
    $input.focus();
    check($input.value === "12.5", "Currency symbols must not enter the editor");
    type($input, "12.75");
    check(values[values.length - 1] === 12.75, "Currency editing must report the raw amount");
    $input.blur();
    check($input.value === new Intl.NumberFormat(undefined, format).format(12.75), "Blur must restore currency formatting");
    passed.push("currency editing reports an unformatted amount");

    format = null;
    $field.bind({ ...base, value: null, format }); $input.focus();
    type($input, "-"); type($input, "-0.");
    check($input.value === "-0.", "Rebinding must preserve a partial decimal");
    type($input, "-0.5");
    check(values[values.length - 1] === -0.5, "A negative decimal must remain editable");
    const count = values.length; type($input, "26%");
    check(values.length === count, "Formatted display text must not be parsed as a raw value");
    $field.bind({ ...base, value: 0.75, format });
    check($input.value === "0.75", "An external value change must replace the focused draft");
    passed.push("partial decimals survive rebind and formatted input is rejected");

    $field.bind({ ...base, value: 0.75, min: 0, max: 1, format });
    const composingCount = values.length;
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      $input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, composed: true }));
    }
    check($input.value === "0.75" && values.length === composingCount, "IME navigation must not step or replace the numeric draft");
    $input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, composed: true }));
    check($input.value === "0.76", "Ordinary arrow stepping must remain enabled");
    passed.push("composition owns navigation keys while ordinary stepping remains enabled");
  } finally { $field.remove(); }
  return passed;
}
