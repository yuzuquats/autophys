import { Button } from "../button/button";
import { Switch } from "../controls/switch";
import { Dropdown } from "../controls/dropdown";
import { SegmentedControl } from "../segmented-control/segmented-control";
import { SettingsCode } from "./settings-code";
import { SettingsNavigate } from "./settings-navigate";
import type { SettingsRow } from "./settings-row";
import { SettingsSchema } from "./settings-schema";

// The consumer's entry point for settings content. A settings surface is
// data — sections of rows — and these builders return rows, so its sections
// read as one literal:
//
//   const $body = Settings.render({ sections: [
//     { title: "Calendar", rows: [
//       Settings.toggle({ label: "Week starts on Monday", checked, onChange: save }),
//       Settings.choice({ label: "Time format", value, options, onChange: save }),
//       isAdmin && Settings.link({ label: "API keys", page: { title: "API keys", content: keys } }),
//     ] },
//     $productSection,
//   ] });
//
// The page around them — header, scrolling, a stack of sub-pages, a modal or
// a document — is the consumer's to compose; the library ships none.
// Builders own their control's behaviour: an `onChange` that returns a
// promise disables the control until it settles and puts the old value back
// if it rejects, so a server-backed setting needs no extra wiring. Anything
// they do not cover is still a row with an element `value`, or an element in
// `rows`/`sections`.
export namespace Settings {
  export type Schema = SettingsSchema.Schema;
  export type Section = SettingsSchema.Section;
  export type Row = SettingsSchema.Row;
  export type Content = SettingsSchema.Content;
  export type Destination = SettingsSchema.Destination;

  /** What every builder takes besides its control: the row's own fields.
   * `disabled` belongs to the row, which makes its value inert and dims it,
   * so `row.update({disabled})` works either way; a builder's control only
   * locks itself while a save is pending. */
  export type RowFields = Pick<SettingsRow.Props, "id" | "label" | "description" | "disabled">;

  /** A change handler; a returned promise is a save the control waits on. */
  export type OnChange<T> = (value: T) => void | Promise<unknown>;

  export type Option_<T extends string> = { value: T; label: string };

  export const render = SettingsSchema.render;
  export const section = SettingsSchema.section;

  /** Ask the page that contains `$from` to open `destination` — for a custom
   * section or control that is not a row. False if no page frame handled it. */
  export function navigate($from: Element, destination: Destination): boolean {
    return SettingsNavigate.dispatch($from, destination);
  }

  /** A row that asks the consumer's page to open a sub-page. */
  export function link(props: RowFields & { page: Destination }): Row {
    return { ...props, page: props.page };
  }

  /** An on/off setting. */
  export function toggle(
    props: RowFields & { checked: boolean; onChange: OnChange<boolean> },
  ): Row {
    const $switch = Switch.make();
    let current = props.checked;
    const bind = (pending: boolean) =>
      $switch.bind({
        checked: current,
        disabled: pending,
        onChange: (next) => {
          const previous = current;
          current = next;
          commit(props.onChange(next), bind, () => {
            current = previous;
            bind(false);
          });
        },
      });
    bind(false);
    return { ...props, value: $switch };
  }

  /** One of a few short options, all visible: a segmented control. */
  export function choice<T extends string>(
    props: RowFields & { value: T; options: Option_<T>[]; onChange: OnChange<T> },
  ): Row {
    const $control = SegmentedControl.make();
    let current = props.value;
    const bind = (pending: boolean) => {
      $control.bind({
        label: props.label,
        value: current,
        options: props.options.map((o) => ({ id: o.value, label: o.label, icon: null })),
        onChange: (id) => {
          if (id === current) return;
          const previous = current;
          current = id as T;
          bind(false);
          commit(props.onChange(current), bind, () => {
            current = previous;
            bind(false);
          });
        },
      });
      $control.toggleAttribute("inert", pending);
    };
    bind(false);
    return { ...props, value: $control };
  }

  /** One of many options: a searchable dropdown under the label. */
  export function select<T extends string>(
    props: RowFields & {
      value: Option<T>;
      options: Option_<T>[];
      placeholder?: Option<string>;
      onChange: OnChange<T>;
    },
  ): Row {
    const rows: Dropdown.Row<T>[] = props.options.map((o) => ({
      content: o.label,
      data: o.value,
      selected: o.value === props.value,
    }));
    const $dropdown = Dropdown.make() as Dropdown<T>;
    let current = props.value;
    // Bound once: Dropdown.bind adds its key listeners on every call.
    const setPending = (pending: boolean) =>
      $dropdown.toggleAttribute("disabled", pending);
    $dropdown.bind({
      placeholder: props.placeholder ?? props.label,
      disabled: false,
      rows,
      onSelectedRow: (row) => {
        if (row.data === current) return;
        const previous = current;
        current = row.data;
        commit(props.onChange(row.data), setPending, () => {
          current = previous;
          setPending(false);
          $dropdown.bindSelectedRow(rows.find((r) => r.data === previous) ?? null, false);
        });
      },
    });
    $dropdown.style.maxWidth = "400px";
    return { ...props, layout: "stacked", value: $dropdown };
  }

  /** A structured value — an object or a list — as a code block under the label. */
  export function json(props: RowFields & { json: unknown }): Row {
    const { json, ...fields } = props;
    return { ...fields, layout: "stacked", value: SettingsCode.makeWith(json) };
  }

  /** A command, not a value: a button at the row's end. */
  export function action(
    props: RowFields & {
      action: { label: string; onClick: () => void | Promise<unknown>; tone?: "primary" | "secondary" | "destructive" };
    },
  ): Row {
    // std-button, not a light <button>: a row's value sits in whatever tree
    // the caller renders it in, which may carry no button styles.
    let pending = false;
    const $button = Button.makeWith(props.action.label, {
      type: props.action.tone ?? "secondary",
      onClick: () => {
        if (pending) return;
        const result = props.action.onClick();
        if (!(result instanceof Promise)) return;
        pending = true;
        $button.toggleAttribute("disabled", true);
        // Settle on either outcome; a refused action is the caller's to
        // report, and handling the rejection here keeps it from surfacing
        // as an unhandled rejection.
        const settle = () => {
          pending = false;
          $button.toggleAttribute("disabled", false);
        };
        result.then(settle, settle);
      },
    });
    $button.toggleAttribute("thin", true);
    return { ...props, value: $button };
  }

  // Drives a control through a change: pending while a returned promise is
  // out, settled after, reverted when it rejects. A plain return settles at
  // once without a pending frame.
  function commit(
    result: void | Promise<unknown>,
    setPending: (pending: boolean) => void,
    revert: () => void,
  ): void {
    if (!(result instanceof Promise)) return;
    setPending(true);
    result.then(() => setPending(false), revert);
  }
}
