import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Chip } from "../chip/chip";
import { ListCellLayout } from "../list/list-cell-layout";
import { SettingsNavigate } from "./settings-navigate";
import type { SettingsSchema } from "./settings-schema";

// One setting: what it is, an optional sentence on what it does, and its
// value or control. Every settings surface had grown its own version — lona.so
// spells it as a label paragraph, a caption paragraph and a control with
// inline margins; Spaces' status page as a `<dl>` row — and no two agreed on
// insets, so this fixes one shape and lets the trailing cell vary.
//
// The trailing cell is exactly one of:
//   a TEXT value — a fact (a version, a count), muted, right-aligned;
//   a STATUS — a `std-chip` with a tone, for a state that can be good or bad;
//   a PATH — monospace, allowed to wrap anywhere, stacked under the label so a
//            long location never squeezes the label column;
//   a CONTROL — any element (a switch, a dropdown, a button), adopted into the
//            `value` slot so it stays under the caller's own stylesheet.
//
// `layout: "stacked"` puts the trailing cell under the text instead of beside
// it, for a control wider than the space beside a label (a dropdown, a list).
//
// An `onClick` row is a navigation row: the whole row is the target, it shows
// a chevron, and hover paints the row. Nothing here routes — the caller pushes
// its own page.
@component({ name: "std-settings-row" })
export class SettingsRow extends LonaWebComponent {
  private $cell: ListCellLayout = this.hydrate("cell");
  private $label: HTMLElement = this.$("label");
  private $description: HTMLElement = this.$("description");
  private $text: HTMLElement = this.$("text");
  private $chip: Option<Chip> = null;
  private props: Option<SettingsRow.Props> = null;

  static makeWith(props: SettingsRow.Props): SettingsRow {
    return SettingsRow.make().bind(props);
  }

  bind(props: SettingsRow.Props): this {
    this.props = props;
    // Detach, never recycle: the value element is the caller's (a builder's
    // control, kept across `update`), not this row's to return to a pool.
    // A value element already in place stays attached, so an update that
    // leaves it alone does not cost it focus.
    const kept = props.value instanceof HTMLElement && props.value.parentNode === this ? props.value : null;
    for (const $child of [...this.childNodes]) if ($child !== kept) $child.remove();
    if (props.id) this.id = props.id;
    this.$label.textContent = props.label;
    this.$description.textContent = props.description ?? "";
    this.$description.hidden = !props.description;

    const value = props.value;
    let kind: SettingsRow.ValueKind = "none";
    this.$text.textContent = "";
    if (value == null) {
      kind = "none";
    } else if (typeof value === "string") {
      kind = "text";
      this.$text.textContent = value;
    } else if (value instanceof HTMLElement) {
      kind = "control";
      value.slot = "value";
      if (value !== kept) this.appendChild(value);
    } else if ("status" in value) {
      kind = "status";
      // Made here rather than declared in the template: a template child is
      // not upgraded until the row is connected, and rows are bound before.
      if (!this.$chip) {
        this.$chip = Chip.make();
        this.$chip.id = "chip";
        this.$("text").after(this.$chip);
      }
      this.$chip.bind({ label: value.status, tone: value.tone });
    } else {
      kind = "path";
      this.$text.textContent = value.path;
    }
    this.setAttribute("value-kind", kind);

    const layout = props.layout ?? (kind === "path" ? "stacked" : "inline");
    this.setAttribute("layout", layout);

    this.toggleAttribute("disabled", props.disabled ?? false);
    // Inert, not just unclickable: a disabled row's control — a builder's or
    // the caller's — must not take focus or keys either. Inertness reaches
    // the slotted value through the flat tree, and stays separate from a
    // builder's own pending state on its control.
    (this.$("value") as HTMLElement).inert = props.disabled ?? false;
    const page = props.page;
    const onClick = props.disabled
      ? null
      : page
        ? () => SettingsNavigate.dispatch(this, page)
        : (props.onClick ?? null);
    this.bindClick(onClick);
    return this;
  }

  /** Rebind with some props changed and the rest as last bound — a new
   * value, description or disabled state without rebuilding the row. */
  update(changes: Partial<SettingsRow.Props>): this {
    return this.bind({ ...this.props!, ...changes });
  }

  // Handlers are element properties (GESTURE_MANAGER's and onkeydown), so a
  // rebind replaces rather than stacks them.
  private bindClick(onClick: Option<() => void>): void {
    const $root = this.$cell;
    this.toggleAttribute("interactive", onClick != null);
    if (!onClick) {
      GESTURE_MANAGER.unregister($root);
      $root.onkeydown = null;
      $root.removeAttribute("role");
      $root.removeAttribute("tabindex");
      return;
    }
    $root.setAttribute("role", "button");
    $root.tabIndex = 0;
    $root.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // The row consumes its key: an enclosing modal or global hotkey must
      // not act on the same press.
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };
    GESTURE_MANAGER.addPointerEvent($root, { onClick });
  }

  /** The text value alone, for a row whose value changes after binding. */
  setText(text: string): this {
    this.$text.textContent = text;
    // Kept in the props so a later `update` does not put the old text back.
    if (this.props) this.props = { ...this.props, value: text };
    return this;
  }

  /** The description alone — a helper line that tracks the control's value. */
  setDescription(description: Option<string>): this {
    this.$description.textContent = description ?? "";
    this.$description.hidden = !description;
    if (this.props) this.props = { ...this.props, description };
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.bindClick(null);
  }

  static $styles = [
    css`
      :host {
        display: block;
        min-width: 0;
      }

      #cell {
        display: block;
        min-width: 0;
        --list-cell-padding: var(--settings-row-pad, 8px 8px);
        --list-cell-layout-hover-color: transparent;
      }

      :host([interactive]) #cell {
        --list-cell-layout-hover-color: var(--bg-hover);
        cursor: pointer;
      }

      /* Wraps, so a value wider than the space beside its label drops to
         its own line instead of overlapping the label. */
      #root {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        column-gap: var(--settings-row-gap, 12px);
        row-gap: 4px;
        min-height: var(--settings-row-height, 36px);
        padding: 0;
        /* A flex item of the list cell: without this it grows to its widest
           content, so a long value widened the page instead of wrapping or
           scrolling inside its own cell. */
        min-width: 0;
        width: 100%;
      }

      :host([layout="stacked"]) #root {
        flex-direction: column;
        align-items: stretch;
        justify-content: center;
        gap: 8px;
      }

      #copy {
        flex: 1 1 12ch;
        min-width: 0;
        gap: 6px;
      }

      #label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-pri);
      }

      #description {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #value {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        min-width: 0;
        max-width: 100%;
        margin-inline-start: auto;
      }

      :host([layout="stacked"]) #copy {
        flex: none;
      }

      :host([layout="stacked"]) #value {
        justify-content: flex-start;
        margin-inline-start: 0;
      }

      #text {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
        text-align: end;
        overflow-wrap: anywhere;
        font-variant-numeric: tabular-nums;
      }

      :host([layout="stacked"]) #text {
        text-align: start;
      }

      :host([value-kind="path"]) #text {
        --font-size: var(--small-size);
        font-family: var(--mono, ui-monospace, monospace);
        color: var(--text-sec);
      }

      #text:empty,
      :host(:not([value-kind="status"])) #chip,
      :host(:not([interactive])) #chevron {
        display: none;
      }

      :host([disabled]) #root {
        opacity: 0.5;
      }

      :host([disabled]) #value {
        pointer-events: none;
      }

      #chevron {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        color: var(--text-ter);
      }

      ::slotted([slot="value"]) {
        min-width: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-list-cell-layout id="cell">
      <div id="root" slot="content">
        <std-col id="copy">
          <p id="label"></p>
          <p id="description" hidden></p>
        </std-col>
        <div id="value">
          <p id="text"></p>
          <slot name="value"></slot>
        </div>
        <svg id="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true">
          <path d="M9 6l6 6-6 6"></path>
        </svg>
      </div>
    </std-list-cell-layout>
  `;
}

export namespace SettingsRow {
  export type ValueKind = "none" | "text" | "status" | "path" | "control";

  export type Status = { status: string; tone: Chip.Tone };
  export type Path = { path: string };
  export type Value = string | Status | Path | HTMLElement;

  export type Props = {
    /** Element id, for `SettingsBody.row(id)`, tests and deep links. */
    id?: Option<string>;
    label: string;
    description?: Option<string>;
    value?: Option<Value>;
    /** Defaults to `stacked` for a path and `inline` for everything else. */
    layout?: Option<"inline" | "stacked">;
    /** Makes the whole row a navigation target with a chevron. */
    onClick?: Option<() => void>;
    /** Raises SettingsNavigate's event for this page when the row is
     * activated (instead of `onClick`); the consumer's page pushes it and
     * builds its content then. */
    page?: Option<SettingsSchema.Destination>;
    /** Dims the row and ignores activation; a builder's control is disabled
     * with it. */
    disabled?: boolean;
  };
}
