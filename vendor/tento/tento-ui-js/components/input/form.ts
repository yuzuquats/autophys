import "../controls/pill-select";
import "../controls/dropdown";
import "./date-input";
import "./date-field";
import "./time-input";
import "./time-field";
import "./datetime-input";
import "./datetime-field";
import "./color-input";
import "./color-field";

import { NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { $jsx } from "../../ui/jsx";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { Checkbox } from "../controls/checkbox";
import { Dropdown } from "../controls/dropdown";
import { PillSelect } from "../controls/pill-select";
import { ProseMirrorEditor } from "../prosemirror";
import { ColorField } from "./color-field";
import { ColorInput } from "./color-input";
import { DateField } from "./date-field";
import { DateInput } from "./date-input";
import { DateTimeField } from "./datetime-field";
import { DateTimeInput } from "./datetime-input";
import { InputLayout } from "./input-layout";
import { SliderInput } from "./slider-input";
import { TextInput } from "./text-input";
import { TimeField } from "./time-field";
import { TimeInput } from "./time-input";

@component({
  name: "std-form",
})
export class Form extends LonaWebComponent {
  private inputMap: Map<string, Form.Element> = new Map();
  private configMap: Map<string, Form.Input> = new Map();
  private layoutMap: Map<string, TextInput | InputLayout> = new Map();
  private onChangeCallback: Option<(values: Record<string, any>) => void>;

  /** The form-level message, kept on the instance rather than only in the DOM.
   * `bind` clears every child and rebuilds, and consumers rebind for reasons
   * that have nothing to do with the error — changing the submit label while a
   * request is in flight, say — so a message that lived only in the element
   * would vanish on the next unrelated rebind. */
  private error: Option<string> = null;
  private $error: Option<HTMLElement> = null;
  private $actions: Option<HTMLElement> = null;

  /** Bumped by every `bind`. A queued write carries the generation it was
   *  queued for and drops itself when a newer bind has started, so "the last
   *  bind wins" is a property of this component rather than of the mutation
   *  queue's ordering.
   *
   *  Queueing the clear alone was not enough. That made two binds in one frame
   *  interleave as clear, rows, clear, rows — correct only while every write
   *  this component makes sits in the same queue phase, and it does not:
   *  `renderError` writes through `deferMutate`. Two binds can still land their
   *  phases out of order, and the second form comes out carrying the first
   *  one's error line. The generation check does not care about phase. */
  private bindGeneration = 0;

  onRecycle(): void {
    this.bindGeneration++;
    this.inputMap.clear();
    this.configMap.clear();
    this.layoutMap.clear();
    this.onChangeCallback = null;
    this.error = null;
    this.$error = null;
    this.$actions = null;
    super.onRecycle();
  }

  /** Queue a bind-owned DOM write, discarded if its generation is stale. */
  private queueBindWrite(generation: number, write: () => void): void {
    $$.mutate(() => {
      if (generation !== this.bindGeneration) return;
      write();
    });
  }

  bind(props: Form.Props): this {
    const generation = ++this.bindGeneration;
    // The clear is QUEUED, not immediate, because every append below is queued
    // too. Run it here and now and two binds inside one frame both clear an
    // empty light DOM and then both flush their appends into it — the form
    // comes out with every row, every error line and every action row twice
    // over. Queued, the two binds interleave as clear, rows, clear, rows, and
    // the last one wins, which is what a caller rebinding to change a submit
    // label is asking for.
    this.queueBindWrite(generation, () => this.clearChildren());
    this.inputMap.clear();
    this.configMap.clear();
    this.layoutMap.clear();

    // Store callbacks
    this.onChangeCallback = props.onChange;

    const title = props.title;
    if (title != null) {
      const $t = Typography.h1(title, "h3").assignStyles({
        paddingInline: "var(--form-title-padding-inline, 4px)",
        "--font-size": "var(--form-title-font-size, var(--h3-size))",
        "--margin-top": "var(--form-title-margin-top, 12px)",
        "--margin-bottom": "var(--form-title-margin-bottom, 24px)",
      });
      this.queueBindWrite(generation, () => this.appendChild($t));
    }

    // Use rows if provided, otherwise fall back to inputs for backward compatibility
    const rows: Form.FormRow[] = props.rows ?? props.inputs ?? [];

    for (const row of rows) {
      // Handle custom elements
      if (row.type === "custom") {
        this.queueBindWrite(generation, () => this.appendChild(row.element));
        continue;
      }

      const input = row;
      const type = input.type ?? "text";
      const isCheckbox =
        type === "checkbox" && input.useCustomCheckbox !== false;
      const isTextInput = Form.TEXT_INPUT_TYPES.has(type);
      const isSlider = type === "range";
      const isColorInput = type === "styled-color";
      // *Input variants (styled-date, styled-time, styled-datetime, styled-color) have their own InputLayout
      const isStyledDateTimeInput =
        type === "styled-date" ||
        type === "styled-time" ||
        type === "styled-datetime";

      // Components that handle their own layout (have built-in labels)
      const hasOwnLayout =
        isTextInput || isSlider || isColorInput || isStyledDateTimeInput;

      // Create the input element
      const $input = this.createInputElement(input);
      if (!$input) continue;

      this.inputMap.set(input.name, $input);
      this.configMap.set(input.name, input);

      if (hasOwnLayout) {
        // TextInput and SliderInput already use their own layout
        if ($input instanceof TextInput) {
          this.layoutMap.set(input.name, $input);
        }
        this.queueBindWrite(generation, () => this.appendChild($input));
      } else if (isCheckbox) {
        // Checkbox uses a horizontal row layout with label to the right
        const $row = document.createElement("std-row");
        $row.style.alignItems = "flex-start";
        $row.style.gap = "8px";
        // The row owns the gap to the next field only when nothing follows it
        // inside this one; a caption below takes that job over.
        $row.style.marginBottom = input.helperText ? "4px" : "16px";

        // Both halves of the row read one number. Inline rather than through a
        // "::slotted" rule: this label and this box are light DOM, and for
        // slotted content the OUTER tree's rules win over "::slotted" whatever
        // the specificity — theme-base.css matches every label, so the rule
        // would have been decoration. An inline declaration is the only one
        // here that survives.
        $input.style.setProperty("--size", "var(--form-checkbox-size, 18px)");

        $row.appendChild($input);

        if (input.label) {
          const $label = document.createElement("label");
          $label.classList.add("checkbox-label");
          $label.setAttribute("for", input.name);
          $label.textContent = input.label;
          // The row is flex-start, so a label that wraps keeps its box beside
          // its FIRST line rather than drifting to the middle of the block, and
          // a first line as tall as the box centres on it with nothing added.
          // What was here instead was a 2px top margin — a guess against one
          // font size, which put all twelve rows of this form two pixels low.
          $label.style.lineHeight = "var(--form-checkbox-size, 18px)";
          $label.style.cursor = "pointer";

          if (input.required) {
            const $required = document.createElement("span");
            $required.classList.add("required");
            $required.textContent = " *";
            $label.appendChild($required);
          }

          GESTURE_MANAGER.addPointerEvent($label, {
            onClick: () => {
              if (generation !== this.bindGeneration || this.inputMap.get(input.name) !== $input) return;
              if ($input instanceof Checkbox && !$input.disabled) {
                const newChecked = !$input.checked;
                $input.setChecked(newChecked);
                $input.onChange?.(newChecked);
              }
            },
          });

          $row.appendChild($label);
        }

        this.queueBindWrite(generation, () => this.appendChild($row));

        if (input.helperText) {
          const $helper = Typography.caption(input.helperText);
          $helper.classList.add("helper-text");
          // Left aligned with the checkbox, not indented under the label. A
          // caption describes the whole row; indenting it to the label's text
          // edge made it read as a second label for the box beside it.
          //
          // Said explicitly, because the element is a `<caption>` and the UA
          // stylesheet centres those (`text-align: -webkit-center`) — every
          // checkbox helper in every form rendered centred under its row,
          // while the text inputs' helpers sat inside an InputLayout that
          // already set its own alignment. `ListCellLayout.$caption` makes the
          // same declaration for the same reason.
          $helper.style.textAlign = "start";
          // The row above gives up its own bottom margin when a caption
          // follows, so the caption owns the gap to the next field. What was
          // here was a -12px top margin pulling the caption back under a 16px
          // gap that had already been emitted — two numbers that only cancelled
          // at one font size.
          $helper.style.marginBottom = "16px";
          this.queueBindWrite(generation, () => this.appendChild($helper));
        }
      } else {
        // All other inputs use InputLayout wrapper
        const $layout = InputLayout.make();
        $layout.bind({
          label: input.label,
          caption: input.helperText,
          required: input.required,
          for: input.name,
        });
        $layout.appendChild($input);
        this.layoutMap.set(input.name, $layout);
        this.queueBindWrite(generation, () => this.appendChild($layout));
      }
    }

    // The form-level error, between the last row and the actions. Errors that
    // blame one field belong on that field — `validate` marks those in place.
    // This line is for the ones that blame none: a server rejection, a
    // cross-field rule the form cannot know. It goes ABOVE the action row
    // because it is the answer to the button the operator just pressed, and a
    // diagnosis printed after the control that failed is one the eye reaches
    // last.
    //
    // The message is text in this row, not a callout. A form-level rejection is
    // a sentence about the button just pressed; it does not need a second piece
    // of chrome to say so, and the red it is set in is the same one a field's
    // error uses, so the two agree by construction.
    //
    // The row is a `div` deliberately, and that is load-bearing. It is light
    // DOM, so the CONSUMER's stylesheet reaches it and beats a `::slotted()`
    // rule whatever the specificity — and Typography's rule matches every `p`
    // and replaces its box geometry outright, which is how an earlier
    // hand-rolled version measured 4px INSIDE the action row. Typography has no
    // such rule for a `div`, so the text sits where this component puts it.
    const $error = document.createElement("div");
    $error.classList.add("form-error");
    this.$error = $error;
    this.renderError(false);
    this.queueBindWrite(generation, () => this.appendChild($error));

    // Add action buttons
    this.$actions = null;
    if (props.submit || props.cancel || props.actionAccessory) {
      const $actions = document.createElement("div");
      this.$actions = $actions;
      $actions.classList.add(
        props.fullBleedDivider ? "form-actions-full-bleed" : "form-actions",
      );

      if (props.actionAccessory) {
        const $accessory = document.createElement("div");
        $accessory.style.display = "flex";
        $accessory.style.alignItems = "center";
        $accessory.style.marginRight = "auto";
        $accessory.appendChild(props.actionAccessory);
        $actions.appendChild($accessory);
      }

      // Real std-buttons, not raw <button>s. This form renders into its own
      // LIGHT dom — every row here is slotted — so a plain `button[primary]`
      // rule in this component's shadow sheet can never match the action
      // buttons, and a raw button fell through to the UA's grey default in
      // any consumer that had not adopted the button styles itself. A
      // std-button carries the house styles in its own shadow root, so it
      // reads as a button wherever the action row lands.
      if (props.cancel) {
        // The click guard is behavioural, not just cosmetic: `disabled` on a
        // std-button tones it down and disables its INNER button, but the
        // gesture handler sits on the host element and still fires.
        const $cancelButton = Button.makeWith(props.cancel.label ?? "Cancel", {
          type: "secondary",
          onClick: () => {
            if (generation !== this.bindGeneration || props.cancel?.disabled) return;
            props.cancel?.onClick?.();
          },
        });
        $cancelButton.id = "cancel";
        $cancelButton.toggleAttribute("disabled", props.cancel.disabled === true);
        $actions.appendChild($cancelButton);
      }

      if (props.submit) {
        const $submitButton = Button.makeWith(props.submit.label ?? "Submit", {
          type: "primary",
          onClick: () => {
            if (generation !== this.bindGeneration || props.submit?.disabled) return;
            this.handleSubmit(props.submit?.onClick);
          },
        });
        $submitButton.id = "submit";
        $submitButton.toggleAttribute("disabled", props.submit.disabled === true);
        $actions.appendChild($submitButton);
      }

      this.queueBindWrite(generation, () => this.appendChild($actions));
    }

    return this;
  }

  private static TEXT_INPUT_TYPES: Set<string> = new Set([
    "text",
    "email",
    "password",
    "url",
    "tel",
    "search",
  ]);

  private createInputElement(
    input: Form.Input,
  ):
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | ProseMirrorEditor
    | Checkbox
    | TextInput
    | SliderInput
    | ColorField
    | ColorInput
    | DateField
    | DateInput
    | TimeField
    | TimeInput
    | DateTimeField
    | DateTimeInput
    | PillSelect<string>
    | Dropdown<string>
    | undefined {
    const generation = this.bindGeneration;
    const onInputChange = () => {
      if (generation === this.bindGeneration) this.handleInputChange();
    };
    const type = input.type ?? "text";

    // Handle Lona-js styled date/time components
    // *Input variants include InputLayout (label, helperText)
    // *Field variants are bare controls (no InputLayout)
    if (type === "styled-date") {
      const $dateInput = DateInput.makeWith({
        label: input.label,
        helperText: input.helperText,
        required: input.required,
        value: input.value ? NaiveDate.parseFlexibleOpt(input.value) : null,
        placeholder: input.placeholder ?? "Select date",
        onChange: onInputChange,
      });
      return $dateInput;
    }

    if (type === "styled-date-field") {
      const $dateField = DateField.makeWith({
        value: input.value ? NaiveDate.parseFlexibleOpt(input.value) : null,
        placeholder: input.placeholder ?? "Select date",
        onChange: onInputChange,
      });
      return $dateField;
    }

    if (type === "styled-time") {
      const $timeInput = TimeInput.makeWith({
        label: input.label,
        helperText: input.helperText,
        required: input.required,
        placeholder: input.placeholder ?? "Select time",
        onChange: onInputChange,
      });
      return $timeInput;
    }

    if (type === "styled-time-field") {
      const $timeField = TimeField.makeWith({
        placeholder: input.placeholder ?? "Select time",
        onChange: onInputChange,
      });
      return $timeField;
    }

    if (type === "styled-datetime") {
      const $dateTimeInput = DateTimeInput.makeWith({
        label: input.label,
        helperText: input.helperText,
        required: input.required,
        datePlaceholder: input.placeholder ?? "Date",
        timePlaceholder: "Time",
        onChange: onInputChange,
      });
      return $dateTimeInput;
    }

    if (type === "styled-datetime-field") {
      const $dateTimeField = DateTimeField.makeWith({
        datePlaceholder: input.placeholder ?? "Date",
        timePlaceholder: "Time",
        onChange: onInputChange,
      });
      return $dateTimeField;
    }

    if (type === "styled-color") {
      const $colorInput = ColorInput.makeWith({
        label: input.label,
        helperText: input.helperText,
        required: input.required,
        value: input.value,
        onChange: onInputChange,
      });
      return $colorInput;
    }

    if (type === "styled-color-field") {
      const $colorField = ColorField.makeWith({
        value: input.value,
        onChange: onInputChange,
      });
      return $colorField;
    }

    if (type === "pill-select") {
      const $pillSelect = PillSelect.make() as PillSelect<string>;
      const options = (input.options ?? []).map((opt) => ({
        label: opt.label ?? opt.value,
        identifier: opt.value,
      }));
      $pillSelect.bind(input.value ?? options[0]?.identifier ?? "", options);
      $pillSelect.onSelected = onInputChange;
      return $pillSelect;
    }

    if (type === "dropdown") {
      const $dropdown = Dropdown.make() as Dropdown<string>;
      const rows = (input.options ?? []).map((option) => ({
        content: option.label ?? option.value,
        data: option.value,
        selected: option.value === input.value,
      }));
      const selectedValue = input.value ?? rows[0]?.data;
      if (selectedValue != null) {
        $dropdown.dataset.selectedValue = selectedValue;
      }

      $dropdown.bind({
        rows,
        placeholder: input.placeholder,
        onSelectedRow: (row) => {
          $dropdown.dataset.selectedValue = row.data;
          onInputChange();
        },
      });
      return $dropdown;
    }

    // Handle special components
    if (type === "rich-text") {
      const $editor = ProseMirrorEditor.make();
      $editor.bind({
        markdown: input.value,
        placeholder: input.placeholder,
      });
      $editor.assignStyles({
        width: "100%",
        borderRadius: "8px",
        background: "var(--bg-surface-light)",
        marginBottom: "8px",
      });
      return $editor;
    }

    if (type === "textarea") {
      const $textarea = document.createElement("textarea");
      $textarea.name = input.name;
      $textarea.id = input.name;
      if (input.placeholder) $textarea.placeholder = input.placeholder;
      if (input.value) $textarea.value = input.value;
      if (input.required) $textarea.required = true;
      if (input.rows) $textarea.rows = input.rows;
      $textarea.addEventListener("input", onInputChange);
      return $textarea;
    }

    if (type === "select") {
      const $select = document.createElement("select");
      $select.name = input.name;
      $select.id = input.name;
      if (input.required) $select.required = true;

      // Add placeholder option if provided
      if (input.placeholder) {
        const $placeholder = document.createElement("option");
        $placeholder.value = "";
        $placeholder.textContent = input.placeholder;
        $placeholder.disabled = true;
        $placeholder.selected = !input.value;
        $select.appendChild($placeholder);
      }

      // Add options
      for (const option of input.options ?? []) {
        const $option = document.createElement("option");
        $option.value = option.value;
        $option.textContent = option.label ?? option.value;
        if (input.value === option.value) {
          $option.selected = true;
        }
        $select.appendChild($option);
      }

      $select.addEventListener("change", onInputChange);
      return $select;
    }

    // Handle checkbox with custom component
    if (type === "checkbox" && input.useCustomCheckbox !== false) {
      const $checkbox = Checkbox.makeWith({
        checked: input.checked ?? false,
        disabled: input.disabled ?? false,
        onChange: onInputChange,
      });
      return $checkbox;
    }

    // Handle text-type inputs with TextInput component
    if (Form.TEXT_INPUT_TYPES.has(type)) {
      const $textInput = TextInput.makeWith({
        label: input.label,
        name: input.name,
        type: type as TextInput.Props["type"],
        value: input.value,
        placeholder: input.placeholder,
        required: input.required,
        helperText: input.helperText,
        disabled: input.disabled,
        onChange: () => {
          if (generation !== this.bindGeneration) return;
      this.clearFieldValidation(input.name);
          onInputChange();
        },
      });
      return $textInput;
    }

    // Handle range with SliderInput component
    if (type === "range") {
      const $slider = SliderInput.make();
      $slider.bind({
        label: input.label,
        description: input.description,
        caption: input.helperText,
        required: input.required,
        value: input.value != null ? Number(input.value) : undefined,
        min: input.min,
        max: input.max,
        step: input.step,
      });
      $slider.onChange = onInputChange;
      return $slider;
    }

    // Handle other standard HTML input types (number, date, time, etc.)
    const $input = document.createElement("input");
    $input.type = type;
    $input.name = input.name;
    $input.id = input.name;

    if (input.placeholder) $input.placeholder = input.placeholder;
    if (input.value != null) $input.value = input.value;
    if (input.required) $input.required = true;
    if (input.min != null) $input.min = String(input.min);
    if (input.max != null) $input.max = String(input.max);
    if (input.step != null) $input.step = String(input.step);
    if (input.pattern) $input.pattern = input.pattern;
    if (input.autocomplete)
      $input.autocomplete = input.autocomplete as AutoFill;

    // Handle standard checkbox and radio
    if (type === "checkbox" || type === "radio") {
      if (input.checked) $input.checked = true;
    }

    $input.addEventListener("input", () => {
      if (generation !== this.bindGeneration) return;
      this.clearFieldValidation(input.name);
      onInputChange();
    });
    return $input;
  }

  private handleInputChange = (): void => {
    if (this.onChangeCallback) {
      const values = this.getFormValues();
      this.onChangeCallback(values);
    }
  };

  /** Show or clear the form-level message. Takes effect without a rebind, so a
   * caller can report a rejection without rebuilding the rows and losing what
   * the operator typed. */
  setError(message: Option<string>): void {
    this.error = message;
    this.renderError(true);
  }

  /** `reveal` is the difference between putting the message in the DOM and
   * putting it in front of the operator. A form taller than its container —
   * five rows in a modal is enough — keeps its actions below the fold, so a
   * rejection rendered in the right place is still a rejection nobody sees:
   * the button is pressed, nothing appears to change. Measured on the add-host
   * modal, where the callout landed 7px past the bottom edge. `nearest` scrolls
   * the least that makes it visible, and only on an explicit `setError`, so a
   * rebind for some unrelated reason does not yank the view around. */
  private renderError(reveal: boolean): void {
    const $error = this.$error;
    if ($error == null) return;
    const message = this.error;
    const shown = message != null && message.length > 0;
    // The block is CREATED when it is shown and dropped when it is not, rather
    // than kept in the DOM behind `display: none`.
    //
    // A form that clears an error should not keep a stale sentence behind
    // `display: none`, waiting to be revealed under some different failure.
    $error.toggleAttribute("data-shown", shown);
    $error.textContent = shown ? (message ?? "") : "";
    if (!shown || !reveal) return;
    const $actions = this.$actions;
    const generation = this.bindGeneration;
    $$.deferMutate(() => {
      if (generation !== this.bindGeneration || this.$error !== $error) return;
      // The message first, then the buttons it is about. Revealing only the
      // message leaves the control the operator would press again below the
      // fold; revealing only the buttons can scroll a tall message off the
      // top. Two `nearest` scrolls in reading order settle both, and cost
      // nothing when they were already visible.
      $error.scrollIntoView({ block: "nearest" });
      $actions?.scrollIntoView({ block: "nearest" });
    });
  }

  private validate(): boolean {
    let valid = true;
    for (const [name, config] of this.configMap) {
      if (!config.required) continue;
      const type = config.type ?? "text";

      // Only validate text-type and number inputs
      const isTextType = Form.TEXT_INPUT_TYPES.has(type);
      const isNumber = type === "number";
      if (!isTextType && !isNumber) continue;

      const $el = this.inputMap.get(name);
      if (!$el) continue;

      let isEmpty = false;
      if ($el instanceof TextInput) {
        isEmpty = $el.getValue().trim() === "";
      } else if ($el instanceof HTMLInputElement) {
        isEmpty = $el.value.trim() === "";
      }

      if (isEmpty) {
        const $layout = this.layoutMap.get(name);
        if ($layout) $layout.setInvalid(true, "This field is required");
        valid = false;
      }
    }
    return valid;
  }

  private clearFieldValidation(name: string): void {
    const $layout = this.layoutMap.get(name);
    if ($layout) $layout.setInvalid(false);
  }

  /**
   * Mark one row invalid with its own message, or clear it.
   *
   * The counterpart to [`value`], and the other half of the same problem. A
   * consumer that validates a field itself has to say so ON that field, and was
   * reaching into the element map to do it — which worked only where the row
   * happened to be a `TextInput`, because that is the class the consumer
   * happened to test for. A mark aimed at a select, a pill-select or a
   * date row went nowhere and reported nothing, so a refusal that named a field
   * could silently show no refusal at all.
   *
   * This resolves through `layoutMap`, the same map the form's own
   * required-field check marks through, so every row type that can carry a mark
   * carries one. A name with no row is a no-op rather than a throw: the caller
   * is asking about its own form definition, and a missing row there is a bug
   * in the definition, not a reason to take the page down.
   */
  setFieldInvalid(name: string, message: Option<string>): void {
    const $layout = this.layoutMap.get(name);
    if ($layout) $layout.setInvalid(message != null, message);
  }

  private handleSubmit(callback?: (values: Map<string, any>) => void): void {
    if (!this.validate()) return;
    if (callback) {
      callback(this.inputMap);
    }
  }

  /** What one row holds, as a string, by name.
   *
   * The submit callback hands back the MAP OF ELEMENTS this form built, and a
   * consumer that wants a string out of it has to know which element type each
   * row's `type` produced — a `TextInput` for text, a native `select` for
   * select, a `PillSelect` for a segmented row. Every consumer that needed one
   * wrote that chain of `instanceof` tests again, over a mapping only this
   * component decides and can change. The form built the rows, so the form is
   * where the question is answered.
   *
   * A name with no row, and a row the operator left blank, both read `""`:
   * they are the same answer to "what is in this field", and a caller that
   * wants to tell them apart is asking about its own form definition, not
   * about what was typed. Non-string rows (a checkbox, a number) come back
   * stringified; `onChange` still delivers those in their own types. */
  value(name: string): string {
    const element = this.inputMap.get(name);
    if (element == null) return "";
    const v = Form.valueOfElement(element);
    return v == null ? "" : String(v);
  }

  private getFormValues(): Record<string, any> {
    const values: Record<string, any> = {};

    for (const [name, element] of this.inputMap) {
      values[name] = Form.valueOfElement(element);
    }

    return values;
  }

  /** The one mapping from "an element this form built" to "the value in it".
   * Kept static and total so `value` and `getFormValues` cannot drift: a row
   * type added to `buildInput` without a case here reads as `undefined` in
   * both, rather than in whichever of the two was updated. */
  private static valueOfElement(element: Form.Element): any {
    if (element instanceof ProseMirrorEditor) return element.value;
    if (element instanceof Checkbox) return element.checked;
    if (element instanceof SliderInput) return element.value;
    if (element instanceof ColorField) return element.value;
    if (element instanceof ColorInput) return element.value;
    if (element instanceof TextInput) return element.getValue();
    if (element instanceof DateField) return element.value;
    if (element instanceof DateInput) return element.value;
    if (element instanceof TimeField) return element.value;
    if (element instanceof TimeInput) return element.value;
    if (element instanceof DateTimeField) return element.value;
    if (element instanceof DateTimeInput) return element.value;
    if (element instanceof PillSelect) return element.selectedIdentifier;
    if (element instanceof Dropdown) return element.dataset.selectedValue ?? "";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return element.checked;
      if (element.type === "number") return element.valueAsNumber;
      return element.value;
    }
    if (
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    return undefined;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        padding: 12px;
        border-radius: 8px;
        background: var(--bg-color);
        width: 100%;
        /* Inherited by child input components for consistent form spacing */
        --form-input-margin-bottom: 24px;
        /* The checkbox's edge length, and the only number in the pair. The box
           takes it as its size and the label beside it takes it as the height
           of its first line, which is what puts the two on one centre line;
           retune it and they move together. */
        --form-checkbox-size: 18px;
      }

      form {
        display: flex;
        flex-direction: column;
        margin: 0;
      }

      slot::slotted(.helper-text) {
        margin-left: 4px !important;
        margin-top: 4px !important;
        margin-bottom: 16px !important;
        display: block;
        color: var(--text-ter);
        --font-size: var(--text-8px);
      }

      slot::slotted(std-input-layout) {
        margin-bottom: 16px;
      }

      slot::slotted(input),
      slot::slotted(textarea),
      slot::slotted(select) {
        background: var(--bg-surface-light);
        padding: 8px 12px;
        border: 2px solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
        --font-size: var(--p-size);
        width: 100%;
        box-sizing: border-box;
        transition: border-color 0.3s ease;
      }

      slot::slotted(input:focus),
      slot::slotted(textarea:focus),
      slot::slotted(select:focus) {
        outline: none;
        border-color: var(--blue);
      }

      slot::slotted(input::placeholder),
      slot::slotted(textarea::placeholder) {
        color: var(--text-ter);
      }

      slot::slotted(textarea) {
        min-height: 80px;
        resize: vertical;
      }

      slot::slotted(input[type="checkbox"]),
      slot::slotted(input[type="radio"]) {
        width: auto;
        margin-right: 8px;
      }

      slot::slotted(std-checkbox) {
        width: auto;
      }

      slot::slotted(.checkbox-label) {
        color: var(--text-pri);
        flex: 1;
        user-select: none;
      }

      slot::slotted(std-row) {
        width: 100%;
      }

      slot::slotted(input[type="color"]) {
        height: 40px;
        cursor: pointer;
      }

      slot::slotted(input[type="range"]) {
        padding: 4px 0;
      }

      slot::slotted(select) {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
        background-repeat: no-repeat;
        background-position: right 8px center;
        background-size: 20px;
        padding-right: 36px;
      }

      /* Placement, and the one red a field's error already uses — no fill, no
         border, nothing that would read as a second opinion about what an
         error looks like. Hidden by default so the row costs no space until
         there is something to say. */
      slot::slotted(.form-error) {
        display: none;
        margin: 4px 0 12px;
        color: var(--red);
      }

      slot::slotted(.form-error[data-shown]) {
        display: block;
      }

      slot::slotted(.form-actions) {
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--divider);
      }

      slot::slotted(.form-actions-full-bleed) {
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
        margin: 0 -12px -12px;
        padding: 12px 20px;
        border-top: 1px solid var(--divider);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <form>
      <slot></slot>
    </form>
  `;
}

export namespace Form {
  /** Every element type a row can produce, named once. `inputMap` is keyed by
   * name and valued by this, and `valueOfElement` narrows over it — the union
   * used to be spelled out inline on the map alone, so a new row type reached
   * the map and the reader without reaching either. */
  export type Element =
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | ProseMirrorEditor
    | Checkbox
    | TextInput
    | SliderInput
    | ColorField
    | ColorInput
    | DateField
    | DateInput
    | TimeField
    | TimeInput
    | DateTimeField
    | DateTimeInput
    | PillSelect<string>
    | Dropdown<string>;

  export type InputType =
    | "text"
    | "email"
    | "password"
    | "number"
    | "tel"
    | "url"
    | "search"
    | "date"
    | "time"
    | "datetime-local"
    | "month"
    | "week"
    | "color"
    | "range"
    | "checkbox"
    | "radio"
    | "textarea"
    | "select"
    | "rich-text"
    | "styled-date"
    | "styled-date-field"
    | "styled-time"
    | "styled-time-field"
    | "styled-datetime"
    | "styled-datetime-field"
    | "styled-color"
    | "styled-color-field"
    | "pill-select"
    | "dropdown";

  export type SelectOption = {
    value: string;
    label?: Option<string>;
  };

  export type Input = {
    name: string;
    label?: Option<string>;
    type?: Option<InputType>;
    placeholder?: Option<string>;
    value?: Option<string>;
    required?: Option<boolean>;
    helperText?: Option<string>;
    description?: Option<string>;
    disabled?: Option<boolean>;
    // For number, range inputs
    min?: Option<number>;
    max?: Option<number>;
    step?: Option<number>;
    // For text inputs
    pattern?: Option<string>;
    autocomplete?: Option<string>;
    // For textarea
    rows?: Option<number>;
    // For checkbox/radio
    checked?: Option<boolean>;
    useCustomCheckbox?: Option<boolean>; // Use custom Checkbox component instead of native
    // For select
    options?: Option<SelectOption[]>;
  };

  export type Submit = {
    label?: Option<string>;
    /** Renders the button in the disabled tone and ignores its clicks. The
     * form re-binds to change it, exactly as it does for the label. */
    disabled?: Option<boolean>;
    onClick: (
      $inputs: Map<
        string,
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement
        | ProseMirrorEditor
        | Checkbox
        | SliderInput
        | ColorField
        | ColorInput
        | DateField
        | DateInput
        | TimeField
        | TimeInput
        | DateTimeField
        | DateTimeInput
        | PillSelect<string>
        | Dropdown<string>
      >,
    ) => void;
  };

  export type Cancel = {
    label?: Option<string>;
    /** Renders the button in the disabled tone and ignores its clicks. */
    disabled?: Option<boolean>;
    onClick?: () => void;
  };

  export type CustomElement = {
    type: "custom";
    element: HTMLElement;
  };

  export type FormRow = Input | CustomElement;

  export type Props = Optional<{
    title: string;
    inputs: Input[];
    rows: FormRow[];
    submit: Submit;
    cancel: Cancel;
    onChange: (values: Record<string, any>) => void;
    fullBleedDivider: boolean;
    /** Content at the leading edge of the action row. Bind owns the element;
     * create a fresh pooled component for each bind, as with custom rows. */
    actionAccessory: HTMLElement;
  }>;

  export function builder(): Builder {
    return new Builder();
  }

  export class Builder {
    private _title: Option<string>;
    private readonly rows: FormRow[] = [];
    private _submit: Option<Submit>;
    private _cancel: Option<Cancel>;
    private _onChange: Option<(values: Record<string, any>) => void>;
    private _fullBleedDivider: Option<boolean>;

    title(title: string): Builder {
      this._title = title;
      return this;
    }

    input(input: Input): Builder {
      this.rows.push(input);
      return this;
    }

    customElement(element: HTMLElement): Builder {
      this.rows.push({ type: "custom", element });
      return this;
    }

    textInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "text", ...options });
      return this;
    }

    emailInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "email", ...options });
      return this;
    }

    passwordInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "password", ...options });
      return this;
    }

    numberInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "number", ...options });
      return this;
    }

    telInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "tel", ...options });
      return this;
    }

    // Lona-js styled date/time inputs with InputLayout (label, helperText, required)
    dateInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "styled-date", ...options });
      return this;
    }

    timeInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "styled-time", ...options });
      return this;
    }

    datetimeInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "styled-datetime", ...options });
      return this;
    }

    // Lona-js styled date/time fields (bare controls, no InputLayout)
    dateField(name: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, type: "styled-date-field", ...options });
      return this;
    }

    timeField(name: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, type: "styled-time-field", ...options });
      return this;
    }

    datetimeField(name: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, type: "styled-datetime-field", ...options });
      return this;
    }

    // Lona-js styled color inputs
    colorInput(name: string, label: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, label, type: "styled-color", ...options });
      return this;
    }

    colorField(name: string, options?: Partial<Input>): Builder {
      this.rows.push({ name, type: "styled-color-field", ...options });
      return this;
    }

    // Native HTML date/time inputs
    nativeDateInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "date", ...options });
      return this;
    }

    nativeTimeInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "time", ...options });
      return this;
    }

    nativeDatetimeInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "datetime-local", ...options });
      return this;
    }

    selectInput(
      name: string,
      label: string,
      options: SelectOption[],
      config?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "select", options, ...config });
      return this;
    }

    pillSelectInput(
      name: string,
      label: string,
      options: SelectOption[],
      config?: Partial<Input>,
    ): Builder {
      this.rows.push({
        name,
        label,
        type: "pill-select",
        options,
        ...config,
      });
      return this;
    }

    textareaInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "textarea", ...options });
      return this;
    }

    checkboxInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "checkbox", ...options });
      return this;
    }

    richTextInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "rich-text", ...options });
      return this;
    }

    sliderInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "range", ...options });
      return this;
    }

    dropdownInput(
      name: string,
      label: string,
      options?: Partial<Input>,
    ): Builder {
      this.rows.push({ name, label, type: "dropdown", ...options });
      return this;
    }

    submit(submit: Submit | string): Builder {
      if (typeof submit === "string") {
        this._submit = { label: submit, onClick: () => {} };
      } else {
        this._submit = submit;
      }
      return this;
    }

    cancel(cancel: Cancel | string): Builder {
      if (typeof cancel === "string") {
        this._cancel = { label: cancel };
      } else {
        this._cancel = cancel;
      }
      return this;
    }

    onChange(callback: (values: Record<string, any>) => void): Builder {
      this._onChange = callback;
      return this;
    }

    fullBleedDivider(): Builder {
      this._fullBleedDivider = true;
      return this;
    }

    buildProps(): Props {
      return {
        title: this._title,
        rows: this.rows,
        submit: this._submit,
        cancel: this._cancel,
        onChange: this._onChange,
        fullBleedDivider: this._fullBleedDivider,
      };
    }

    build(): Form {
      const $f = Form.make();
      $f.bind(this.buildProps());
      return $f;
    }
  }
}
