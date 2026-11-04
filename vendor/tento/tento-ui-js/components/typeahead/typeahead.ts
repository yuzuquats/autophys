import "../popover/popover";
import "../list/list-cell-layout";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Anchor, type AnchorInstance } from "../anchor";
import { Typography } from "../../ui/typography";
import { InputStyles } from "../input/input-styles";
import { ListCellLayout } from "../list/list-cell-layout";
import { Popover } from "../popover/popover";
import { Tracing } from "@tento-core/tracing";

type RelatedInput = HTMLInputElement & {
  ariaControlsElements: Option<Element[]>;
  ariaActiveDescendantElement: Option<Element>;
};

// A combobox whose late responses never win. `std-dropdown` takes its rows up
// front and `std-inline-select` searches a static list; nothing suggested
// asynchronously or accepted free text. This is an input with
// `role=combobox aria-expanded aria-controls aria-activedescendant
// aria-autocomplete=list`, a listbox of `ListCellLayout` rows revealed in a
// `std-popover` surface through `Anchor.reveal` (never `Popover.show()` — the
// input keeps focus; the active row is announced through
// `aria-activedescendant`), Arrow/Enter/Escape, a debounce, and a request
// generation counter: a response that arrives after a newer query was sent is
// dropped, so typing fast never shows stale suggestions.
@component({ name: "std-typeahead" })
export class Typeahead extends LonaWebComponent {
  private $label: HTMLLabelElement = this.$("label");
  private $input: HTMLInputElement = this.$("input");
  private props: Option<Typeahead.Props>;
  private items: Typeahead.Item[] = [];
  private active = -1;
  private generation = 0;
  private timer: Option<number>;
  private pending = false;
  private instance: Option<AnchorInstance>;
  private $list: Option<HTMLElement>;
  private rowListeners: { $row: HTMLElement; handler: (e: PointerEvent) => void }[] = [];
  private static seq = 0;
  private listId = "";

  constructor() {
    super();
    this.$input.addEventListener("input", () => {
      const props = this.props;
      if (props == null) return;
      this.close();
      props.onInput(this.$input.value);
      this.schedule();
    });
    this.$input.addEventListener("keydown", this.onKeydown);
    // Rows select on pointerdown and prevent blur before this fires.
    this.$input.addEventListener("blur", () => this.close());
  }

  bind(props: Typeahead.Props): this {
    this.close();
    this.props = props;
    const id = `std-typeahead-${++Typeahead.seq}`;
    this.listId = `${id}-list`;
    this.$input.id = id;
    this.$label.htmlFor = id;
    this.$label.textContent = props.label;
    this.$input.placeholder = props.placeholder ?? "";
    if (this.$input.value !== props.value) this.$input.value = props.value;
    this.$input.setAttribute("role", "combobox");
    this.$input.setAttribute("aria-autocomplete", "list");
    this.$input.setAttribute("aria-expanded", "false");
    this.$input.setAttribute("aria-controls", this.listId);
    this.$input.setAttribute("aria-haspopup", "listbox");
    return this;
  }

  private schedule(): void {
    if (this.timer != null) window.clearTimeout(this.timer);
    const props = this.props;
    if (props == null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.suggest();
    }, props.debounceMs);
  }

  private async suggest(): Promise<void> {
    const props = this.props;
    if (props == null || !this.isConnected) return;
    this.cancelPending();
    const q = this.$input.value;
    const gen = this.generation;
    this.pending = true;
    let items: Typeahead.Item[];
    try {
      items = await props.suggest(q);
    } catch (error) {
      if (gen !== this.generation || this.props !== props || !this.isConnected) return;
      this.close();
      Tracing.err("ui")("Typeahead suggestion failed", { error: String(error) });
      return;
    }
    if (gen !== this.generation || this.props !== props || !this.isConnected) return;
    this.pending = false;
    this.items = items;
    this.active = -1;
    if (items.length === 0) {
      this.close();
      return;
    }
    this.open();
  }

  private open(): void {
    this.clearRowListeners();
    const $list = document.createElement("div");
    $list.id = this.listId;
    $list.setAttribute("role", "listbox");
    const rect = this.$input.getBoundingClientRect();
    const available = Math.max(rect.top - 8, window.innerHeight - rect.bottom - 8);
    // Suggestions own their scrolling surface. A long caller-supplied list
    // must still expose visible choices beside the input.
    $list.style.maxHeight = `${Math.max(0, Math.min(360, available - 16))}px`;
    $list.style.overflowY = "auto";
    this.items.forEach((item, i) => {
      const $row = item.$row != null
        ? item.$row()
        : ListCellLayout.makeText(item.label);
      $row.id = `${this.listId}-${i}`;
      $row.setAttribute("role", "option");
      $row.setAttribute("aria-selected", "false");
      $row.classList.add("option");
      $row.style.cursor = "pointer";
      // pointerdown, not click: the input's blur closes the list before a
      // click could arrive.
      const handler = (e: PointerEvent) => {
        if (!this.isConnected || this.$list !== $list || $row.parentElement !== $list) return;
        e.preventDefault();
        this.choose(i);
      };
      $row.addEventListener("pointerdown", handler);
      this.rowListeners.push({ $row, handler });
      $list.appendChild($row);
    });
    if (this.instance != null) {
      // Replace the rows in place; the surface stays where it is.
      const $old = this.$list;
      if ($old?.parentElement != null) $old.parentElement.replaceChild($list, $old);
      this.$list = $list;
      this.instance.updatePosition();
    } else {
      const $popover = Popover.makeWith({
        // Slotted options stay in the document tree, which is an allowed
        // ancestor scope for the shadow input's explicit ARIA element references.
        $content: () => document.createElement("slot"),
        role: "none",
        label: null,
        placement: null,
        arrow: false,
        onDismiss: null,
      });
      $popover.appendChild($list);
      $popover.style.minWidth = `${this.$input.offsetWidth}px`;
      this.$list = $list;
      this.instance = Anchor.reveal({
        $anchor: this.$input,
        $content: $popover,
        position: ({ parentRect, contentRect, marginBlockPx, marginInlinePx }) => {
          const below = window.innerHeight - parentRect.bottom - marginBlockPx;
          const above = parentRect.top - marginBlockPx;
          const openBelow = contentRect.height <= below || below >= above;
          return {
            top: `${openBelow ? parentRect.height + marginBlockPx : -contentRect.height - marginBlockPx}px`,
            left: `${marginInlinePx}px`,
          };
        },
        escapeContainer: true,
        dismissOnClickOutside: true,
        onDismiss: () => {
          this.cancelPending();
          this.resetList();
        },
      });
    }
    if ("ariaControlsElements" in this.$input) {
      (this.$input as RelatedInput).ariaControlsElements = [$list];
    }
    this.$input.setAttribute("aria-expanded", "true");
    this.setActive(-1);
  }

  private cancelPending(): void {
    this.generation++;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }

  private resetList(): void {
    this.clearRowListeners();
    this.instance = null;
    this.$list = null;
    this.items = [];
    this.active = -1;
    this.$input.setAttribute("aria-expanded", "false");
    if ("ariaControlsElements" in this.$input) (this.$input as RelatedInput).ariaControlsElements = [];
    if ("ariaActiveDescendantElement" in this.$input) (this.$input as RelatedInput).ariaActiveDescendantElement = null;
    this.$input.removeAttribute("aria-activedescendant");
  }

  private clearRowListeners(): void {
    for (const { $row, handler } of this.rowListeners) $row.removeEventListener("pointerdown", handler);
    this.rowListeners = [];
  }

  private close(): void {
    this.cancelPending();
    const instance = this.instance;
    this.instance = null;
    instance?.dismiss();
    this.resetList();
  }

  private setActive(i: number): void {
    this.active = i;
    const $list = this.$list;
    if ($list == null) return;
    [...$list.children].forEach(($row, k) => {
      const on = k === i;
      $row.setAttribute("aria-selected", on ? "true" : "false");
      $row.toggleAttribute("active", on);
      if (on) $row.scrollIntoView({ block: "nearest" });
    });
    if (i >= 0) {
      this.$input.setAttribute("aria-activedescendant", `${this.listId}-${i}`);
      if ("ariaActiveDescendantElement" in this.$input) {
        (this.$input as RelatedInput).ariaActiveDescendantElement = $list.children[i];
      }
    } else {
      if ("ariaActiveDescendantElement" in this.$input) (this.$input as RelatedInput).ariaActiveDescendantElement = null;
      this.$input.removeAttribute("aria-activedescendant");
    }
  }

  private choose(i: number): void {
    const props = this.props;
    const item = this.items[i];
    if (props == null || item == null) return;
    this.$input.value = item.label;
    this.close();
    props.onSelect(item.id);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    if (props == null) return;
    const open = this.instance != null;
    const n = this.items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        void this.suggest();
        return;
      }
      this.setActive((this.active + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return;
      this.setActive((this.active - 1 + n) % n);
    } else if (e.key === "Enter") {
      if (open && this.active >= 0) {
        e.preventDefault();
        this.choose(this.active);
      } else if (props.allowFreeText) {
        this.close();
        props.onSelect(this.$input.value);
      }
    } else if (e.key === "Escape") {
      if (open || this.pending || this.timer != null) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    }
  };

  onRecycle(): void {
    super.onRecycle();
    this.close();
    this.props = null;
    this.$input.value = "";
    this.$label.textContent = "";
    for (const a of ["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-haspopup", "aria-activedescendant"]) {
      this.$input.removeAttribute(a);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.close();
  }

  static makeWith(props: Typeahead.Props): Typeahead {
    return Typeahead.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    InputStyles.variables,
    InputStyles.fieldStyle,
    InputStyles.labelStyle,
    css`
      :host {
        display: block;
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label"></label>
    <input id="input" type="text" autocomplete="off" spellcheck="false" />
  `;
}

export namespace Typeahead {
  export type Item = { id: string; label: string; $row: Option<() => HTMLElement> };
  export type Props = {
    value: string;
    placeholder: Option<string>;
    /** Called after the debounce with the current text; may resolve late.
     * Rejection closes this query and logs a diagnostic; the next query may retry. */
    suggest: (q: string) => Promise<Item[]>;
    onSelect: (id: string) => void;
    onInput: (q: string) => void;
    debounceMs: number;
    /** Enter with no active row reports the typed text as the selection. */
    allowFreeText: boolean;
    label: string;
  };
}
