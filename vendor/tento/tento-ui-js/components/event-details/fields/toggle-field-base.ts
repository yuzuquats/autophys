import "@tento-ui/components/controls/switch";

import { html, LonaWebComponent } from "../../../component";
import { GESTURE_MANAGER } from "../../../gesture-manager";
import { Switch } from "../../controls/switch";
import { css, Style } from "../../../component-styles";

/**
 * Shared structure for the event-details "toggle row" fields (all-day, video
 * conferencing, flight). The whole row is the tap target: the switch carries
 * `pointer-events: none`, so every click on the row — label, empty space, or
 * the switch itself — routes through one host handler.
 *
 * Subclasses set `label` (written to `#label` on connect) and may override
 * `onToggle` to add side-effects. A subclass that needs extra markup (the
 * flight field's info button) overrides `static $html`/`$styles`, but MUST keep
 * the `id="label"` and `id="switch"` hooks the base hydrates, and MUST
 * re-include `ToggleFieldBase.$rowStyle` in its `$styles`.
 *
 * Undecorated on purpose — never `make()`d directly, mirroring
 * `LonaModalWebComponent`.
 */
export class ToggleFieldBase extends LonaWebComponent {
  $switch: Switch = this.hydrate("switch");
  $label = this.$("label");

  protected onChangeCb: Option<(enabled: boolean) => void> = undefined;

  /** Whether a tap on the row (or the switch's keys) toggles it; `setInteractive`. */
  #interactive = true;

  /** Row label text; supplied by each subclass. */
  protected label: string = "";

  /**
   * Runs when the row is toggled. Default forwards to the change callback set in
   * a subclass `bind()`; the flight field overrides this to open its modal.
   */
  protected onToggle(enabled: boolean): void {
    this.onChangeCb?.(enabled);
  }

  /**
   * Whether the row can be toggled. A read-only panel binds it off: the switch
   * still shows the value, but neither a tap nor its keys change it.
   */
  setInteractive(interactive: boolean): void {
    this.#interactive = interactive;
    this.$switch.bind({ disabled: !interactive });
    this.toggleAttribute("readonly", !interactive);
    if (interactive) this.removeAttribute("aria-disabled");
    else this.setAttribute("aria-disabled", "true");
  }

  connectedCallback() {
    super.connectedCallback();
    this.$label.textContent = this.label;
    // The switch has pointer-events: none, so the whole row is one tap target.
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => {
        if (!this.#interactive) return;
        const newValue = !this.$switch.checked;
        this.$switch.setChecked(newValue);
        this.onToggle(newValue);
      },
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    GESTURE_MANAGER.unregister(this);
  }

  static $rowStyle: Style.Compat = css`
    :host {
      display: flex;
      width: 100%;
      cursor: pointer;
      min-height: 36px;
      padding: 8px 12px;
    }

    #root {
      width: 100%;
      align-items: center;
      justify-content: space-between;
    }

    #label {
      color: var(--text-ter);
    }

    std-switch {
      pointer-events: none;
    }

    :host([readonly]) {
      cursor: default;
    }
  `;

  static $styles: Style.Compat[] = [ToggleFieldBase.$rowStyle];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <p id="label" class="small"></p>
      <std-switch id="switch"></std-switch>
    </std-row>
  `;
}
