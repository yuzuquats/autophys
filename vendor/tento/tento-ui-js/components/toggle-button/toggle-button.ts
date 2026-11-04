import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";

// Pressed state as a first-class control. `aria-pressed` appeared only inside
// `std-split-buttons`, whose three buttons are fixed. This is one native
// `<button aria-pressed>` with a label, an optional glyph and an `onChange`;
// the group below lays several out.
@component({ name: "std-toggle-button" })
export class ToggleButton extends LonaWebComponent {
  private $button: HTMLButtonElement = this.$("button");
  private $glyph: HTMLElement = this.$("glyph");
  private $label: HTMLElement = this.$("label");
  private props: Option<ToggleButton.Props>;

  constructor() {
    super();
    this.$button.addEventListener("click", () => {
      const props = this.props;
      if (props == null) return;
      const next = !props.pressed;
      this.setPressed(next);
      props.onChange(next);
    });
  }

  bind(props: ToggleButton.Props): this {
    this.props = props;
    this.$label.textContent = props.label;
    DomUtils.clearChildren(this.$glyph);
    if (props.icon != null) {
      const $svg = LonaIcons.$svg(props.icon);
      $svg.setAttribute("aria-hidden", "true");
      this.$glyph.appendChild($svg);
    }
    this.$glyph.toggleAttribute("hidden", props.icon == null);
    this.setPressed(props.pressed);
    return this;
  }

  private setPressed(pressed: boolean): void {
    if (this.props != null) this.props = { ...this.props, pressed };
    this.$button.setAttribute("aria-pressed", pressed ? "true" : "false");
    this.toggleAttribute("pressed", pressed);
  }

  /** The group moves focus between its buttons. */
  focusButton(): void {
    this.$button.focus();
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$label.textContent = "";
    DomUtils.clearChildren(this.$glyph);
    this.removeAttribute("pressed");
    this.$button.removeAttribute("aria-pressed");
  }

  static makeWith(props: ToggleButton.Props): ToggleButton {
    return ToggleButton.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --toggle-bg: var(--toggle-bg-preset, transparent);
        --toggle-bg-pressed: var(--toggle-bg-pressed-preset, var(--text-pri));
        --toggle-color: var(--text-sec);
        --toggle-color-pressed: var(--bg);
        --toggle-border: var(--divider);
        --toggle-radius: 8px;

        display: inline-block;
        max-width: max-content;
      }

      button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        margin: 0;
        border: 1px solid var(--toggle-border);
        border-radius: var(--toggle-radius);
        background: var(--toggle-bg);
        color: var(--toggle-color);
        font-family: inherit;
        cursor: pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }

      button:hover {
        background: var(--bg-surface-light);
      }

      :host([pressed]) button {
        background: var(--toggle-bg-pressed);
        border-color: var(--toggle-bg-pressed);
        color: var(--toggle-color-pressed);
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #glyph {
        display: inline-flex;
        width: 14px;
        height: 14px;
      }

      #glyph[hidden] {
        display: none;
      }

      #glyph > svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      #label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
      }

      @media (prefers-reduced-motion: reduce) {
        button {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`<button id="button" type="button"><span id="glyph" hidden></span><p id="label" class="small"></p></button>`;
}

export namespace ToggleButton {
  export type Props = {
    label: string;
    icon: Option<LonaIcons.RawSvg>;
    pressed: boolean;
    onChange: (pressed: boolean) => void;
  };
}

// Several toggles as one control. `multiple` is `role=group` where any number
// may be pressed; single is the radio pattern where exactly one is, arrows
// move focus AND selection, and there is one tab stop.
@component({ name: "std-toggle-button-group" })
export class ToggleButtonGroup extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private props: Option<ToggleButtonGroup.Props>;
  private $buttons: ToggleButton[] = [];

  constructor() {
    super();
    this.$root.addEventListener("keydown", this.onKeydown);
  }

  bind(props: ToggleButtonGroup.Props): this {
    this.props = props;
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$root);
    this.$buttons = props.items.map((item) =>
      ToggleButton.makeWith({
        label: item.label,
        icon: item.icon,
        pressed: props.values.includes(item.id),
        onChange: (pressed) => this.onToggle(item.id, pressed),
      }),
    );
    for (const $b of this.$buttons) this.$root.appendChild($b);
    this.rove();
    return this;
  }

  private onToggle(id: string, pressed: boolean): void {
    const props = this.props;
    if (props == null) return;
    let values: string[];
    if (props.multiple) {
      values = pressed ? [...props.values, id] : props.values.filter((v) => v !== id);
    } else {
      // Single: exactly one stays pressed; un-pressing the only one is refused.
      values = [id];
    }
    this.props = { ...props, values };
    this.$buttons.forEach(($b, i) => {
      const item = props.items[i];
      $b.bind({ label: item.label, icon: item.icon, pressed: values.includes(item.id), onChange: (p) => this.onToggle(item.id, p) });
    });
    this.rove();
    props.onChange(values);
  }

  /** Single-select: the pressed button is the one tab stop. */
  private rove(): void {
    const props = this.props;
    if (props == null || props.multiple) {
      for (const $b of this.$buttons) $b.shadowRoot?.querySelector("button")?.setAttribute("tabindex", "0");
      return;
    }
    let seen = false;
    this.$buttons.forEach(($b, i) => {
      const pressed = props.values.includes(props.items[i].id);
      const stop = pressed && !seen;
      if (stop) seen = true;
      $b.shadowRoot?.querySelector("button")?.setAttribute("tabindex", stop ? "0" : "-1");
    });
    if (!seen && this.$buttons.length > 0) this.$buttons[0].shadowRoot?.querySelector("button")?.setAttribute("tabindex", "0");
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    if (props == null) return;
    // The key lands on the native button inside a toggle's shadow; the host
    // is found on the composed path, since `closest()` stops at the boundary.
    const $host = e.composedPath().find((n) => this.$buttons.includes(n as ToggleButton)) as Option<ToggleButton>;
    const i = $host == null ? -1 : this.$buttons.indexOf($host);
    if (i < 0) return;
    const n = this.$buttons.length;
    let next: Option<number> = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    this.$buttons[next].focusButton();
    if (!props.multiple) this.onToggle(props.items[next].id, true);
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$buttons = [];
    DomUtils.clearChildren(this.$root);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: ToggleButtonGroup.Props): ToggleButtonGroup {
    return ToggleButtonGroup.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --toggle-group-gap: 6px;
        display: inline-block;
        max-width: max-content;
      }

      #root {
        display: inline-flex;
        gap: var(--toggle-group-gap);
        flex-wrap: wrap;
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace ToggleButtonGroup {
  export type Item = { id: string; label: string; icon: Option<LonaIcons.RawSvg> };
  export type Props = {
    items: Item[];
    values: string[];
    multiple: boolean;
    onChange: (values: string[]) => void;
    label: string;
  };
}
