import { LonaWebComponent, html } from "../../component";
import { Div } from "../../component-builtin";
import { component } from "../../component-decorators";
import { Style } from "../../component-styles";
import { LoadingIcon, LonaIcons } from "../../ui/icons";
import { Button } from "./button";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Tracing } from "@tento-core/tracing";

@component({
  name: "std-loading-button",
})
export class LoadingButton extends LonaWebComponent {
  static get observedAttributes() {
    return [
      "primary",
      "secondary",
      "destructive",
      "flat",
      "disabled",
      "thin",
      "selected",
    ];
  }

  private $slot = this.$<HTMLSlotElement>("slot");
  private $loading: HTMLElement;
  private $root: HTMLButtonElement = this.$("root");
  private binding = 0;
  private operation = 0;

  constructor() {
    super();
    const $svg = LonaIcons.make(LoadingIcon, {
      sizePx: 16,
    });
    this.$loading = Div.make();
    this.$loading.appendChild($svg);
  }

  attributeChangedCallback(
    name: string,
    _old: string | null,
    value: string | null,
  ) {
    this.$root.toggleAttribute(name, value !== null);
  }

  onRecycle(): void {
    this.binding++;
    this.operation++;
    GESTURE_MANAGER.unregister(this);
    const $root = this.$root;
    while ($root.attributes.length > 0) {
      $root.removeAttribute($root.attributes[0].name);
    }
    $root.id = "root";
    $root.style.width = "100%";
    $root.replaceChildren(this.$slot);
    super.onRecycle();
  }

  disconnectedCallback(): void {
    this.operation++;
    this.toggleLoading(false);
    super.disconnectedCallback();
  }

  /** Replaces the click binding. Rejections settle loading and reach onError,
   * or a UI diagnostic when omitted; event dispatch never owns the returned promise.
   * Retired operations do not notify or change a replacement binding. */
  addLoadingClickEvent(onClick: () => Promise<void>, onError: Option<(error: Error) => void> = null) {
    const binding = ++this.binding;
    this.operation++;
    this.toggleLoading(false);
    this.addPointerEvent({
      onClick: async () => {
        if (binding !== this.binding || !this.isConnected) return;
        const operation = ++this.operation;
        const current = () => binding === this.binding && operation === this.operation;
        this.toggleLoading(true);
        try {
          await onClick();
        } catch (cause) {
          if (!current()) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (onError != null) onError(error);
          else Tracing.err("ui")("LoadingButton operation failed", { error: String(error) });
        } finally {
          if (current()) this.toggleLoading(false);
        }
      },
    });
  }

  toggleLoading(force: boolean) {
    if (force) {
      this.$root.replaceChildren(this.$loading);
    } else {
      this.$root.replaceChildren(this.$slot);
    }
  }

  static $styles: Style.Compat[] = [Button.$style];
  static $html: Option<HTMLTemplateElement> = html`
    <button id="root" style=width:100%>
      <slot id="slot"></slot>
    </button>
  `;
}
