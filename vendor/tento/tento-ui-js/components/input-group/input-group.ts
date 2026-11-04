import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { InputStyles } from "../input/input-styles";

// A prefix and suffix around any input. Nothing composed an addon with a
// field. This takes a leading and trailing text or glyph plus label, helper
// and error, and slots any `std-*-input` or native input between them; the
// `--input-*` variables flow to the slotted control through inheritance, and
// the addons share its frame so the three read as one field.
@component({ name: "std-input-group" })
export class InputGroup extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $leading: HTMLElement = this.$("leading");
  private $trailing: HTMLElement = this.$("trailing");
  private $helper: HTMLElement = this.$("helper");
  private $error: HTMLElement = this.$("error");
  private $slot: HTMLSlotElement = this.$("slot");

  constructor() {
    super();
    // The slotted control's own `:host` declares the `--input-*` variables, so
    // a `::slotted` rule from here does not reliably beat it; an inline
    // declaration on the child does, on every slotchange.
    this.$slot.addEventListener("slotchange", () => {
      for (const $el of this.$slot.assignedElements()) {
        if (!($el instanceof HTMLElement)) continue;
        $el.style.setProperty("--input-bg", "transparent");
        $el.style.setProperty("--input-border-width", "0px");
        $el.style.setProperty("--input-label-margin", "0");
      }
    });
  }

  bind(props: InputGroup.Props): this {
    this.$label.textContent = props.label ?? "";
    this.$label.toggleAttribute("hidden", props.label == null);
    this.addon(this.$leading, props.leading);
    this.addon(this.$trailing, props.trailing);
    this.$helper.textContent = props.helper ?? "";
    this.$helper.toggleAttribute("hidden", props.helper == null);
    this.$error.textContent = props.error ?? "";
    this.$error.toggleAttribute("hidden", props.error == null);
    this.toggleAttribute("invalid", props.error != null);
    return this;
  }

  private addon($slot: HTMLElement, addon: Option<InputGroup.Addon>): void {
    DomUtils.clearChildren($slot);
    $slot.toggleAttribute("hidden", addon == null);
    if (addon == null) return;
    if (typeof addon === "string") {
      $slot.appendChild(Typography.small(addon));
    } else {
      const $svg = LonaIcons.$svg(addon.svg);
      $svg.setAttribute("aria-hidden", "true");
      $slot.appendChild($svg);
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.$label.textContent = "";
    DomUtils.clearChildren(this.$leading);
    DomUtils.clearChildren(this.$trailing);
    this.$helper.textContent = "";
    this.$error.textContent = "";
    this.removeAttribute("invalid");
  }

  static makeWith(props: InputGroup.Props): InputGroup {
    return InputGroup.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    InputStyles.variables,
    InputStyles.labelStyle,
    InputStyles.helperStyle,
    css`
      :host {
        --input-group-addon-color: var(--text-ter);

        display: block;
        width: 100%;
      }

      #frame {
        display: flex;
        align-items: stretch;
        border-radius: var(--input-border-radius, 8px);
        background: var(--input-bg, var(--bg-surface-light));
        border: var(--input-border-width, 2px) solid transparent;
        transition: border-color 0.3s ease;
      }

      #frame:focus-within {
        border-color: var(--input-focus-border-color, var(--blue));
      }

      :host([invalid]) #frame {
        border-color: var(--input-invalid-border-color, var(--red));
      }

      .addon {
        display: flex;
        align-items: center;
        padding-inline: var(--input-padding-inline, 10px);
        color: var(--input-group-addon-color);
        white-space: nowrap;
      }

      .addon[hidden] {
        display: none;
      }

      .addon > svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }

      .addon > p {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
      }

      /* The slotted control gives up its own frame: the group is the frame.
         The variables are written inline on slotchange (see the constructor). */
      ::slotted(*) {
        flex: 1;
        min-width: 0;
      }

      .label[hidden],
      .helper-text[hidden],
      .error-text[hidden] {
        display: none;
      }

      .error-text {
        display: block;
        margin-top: 4px;
        margin-left: 10px;
        color: var(--red);
      }

      @media (prefers-reduced-motion: reduce) {
        #frame {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`
    <p id="label" class="label small" hidden></p>
    <div id="frame">
      <div id="leading" class="addon" hidden></div>
      <slot id="slot"></slot>
      <div id="trailing" class="addon" hidden></div>
    </div>
    <p id="helper" class="small helper-text" hidden></p>
    <p id="error" class="small error-text" hidden></p>
  `;
}

export namespace InputGroup {
  export type Addon = string | { svg: LonaIcons.RawSvg };
  export type Props = {
    leading: Option<Addon>;
    trailing: Option<Addon>;
    label: Option<string>;
    helper: Option<string>;
    error: Option<string>;
  };
}
