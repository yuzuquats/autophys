import "../button/button";
import "../modal-close-button/modal-close-button";

import { html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Focus } from "../../ui/focus";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ModalCloseButton } from "../modal-close-button/modal-close-button";
import { Overlay } from "../overlay";

// A modal with a role, a trap, and an idempotent bind.
//
// `std-prompt` and `std-prompt-alert` are the modals we had: no `role=dialog`,
// no `aria-modal`, no focus trap or restore, and a `bind()` that installs a new
// gesture handler on every call. This does the four things. `role` is
// `dialog` or `alertdialog` with `aria-modal`, named by the title and
// described by the description. `show()` records the invoker, reveals, and
// focuses the first action (an alert) or the panel; Tab is trapped inside
// the shadow; `onModalDismiss()`, which the overlay fires on EVERY dismissal
// path — Escape, backdrop, the close button, a caller's `dismiss()` —
// restores focus to the invoker. `bind()` rebuilds the actions row each time,
// so a pooled dialog carries no previous callbacks.
//
// `dismissible: false` is honoured by the overlay's own `canDismiss` gate, so
// Escape and the backdrop do nothing; only an action can close it.
@component({ name: "std-dialog" })
export class Dialog extends LonaModalWebComponent {
  private $panel: HTMLElement = this.$("panel");
  private $title: HTMLElement = this.$("title");
  private $description: HTMLElement = this.$("description");
  private $body: HTMLElement = this.$("body");
  private $actions: HTMLElement = this.$("actions");
  private $close: ModalCloseButton = this.hydrate("close");
  private props: Option<Dialog.Props>;
  private focusEpoch = 0;

  constructor() {
    super();
    // Own shadow node, installed once: the trap reads the live focusables.
    this.$panel.addEventListener("keydown", this.onKeydown, true);
  }

  bind(props: Dialog.Props): this {
    this.props = props;
    this.$title.textContent = props.title;
    const description = props.description;
    this.$description.textContent = description ?? "";
    this.$description.toggleAttribute("hidden", description == null);

    DomUtils.clearChildren(this.$body);
    if (props.$body != null) this.$body.appendChild(props.$body());
    this.$body.toggleAttribute("hidden", props.$body == null);

    DomUtils.clearChildren(this.$actions);
    for (const action of props.actions) {
      this.$actions.appendChild(
        Button.makeWith(action.label, { type: action.type, onClick: action.onClick }),
      );
    }
    this.$actions.toggleAttribute("hidden", props.actions.length === 0);

    this.$close.toggleAttribute("hidden", !props.dismissible);
    this.$close.bind({ onDismiss: () => this.dismiss() });

    this.setAttribute("role", props.alert ? "alertdialog" : "dialog");
    this.setAttribute("aria-modal", "true");
    this.setAttribute("aria-label", props.title);
    if (description == null) this.removeAttribute("aria-description");
    else this.setAttribute("aria-description", description);
    this.$panel.tabIndex = -1;
    return this;
  }

  onRecycle(): void {
    this.focusEpoch++;
    super.onRecycle();
    this.props = null;
    this.$title.textContent = "";
    this.$description.textContent = "";
    DomUtils.clearChildren(this.$body);
    DomUtils.clearChildren(this.$actions);
    for (const a of ["role", "aria-modal", "aria-label", "aria-description"]) this.removeAttribute(a);
  }

  static makeWith(props: Dialog.Props): Dialog {
    return Dialog.make().bind(props);
  }

  /** Bind, reveal, and move focus in. Returns the dialog so a caller can
   * `dismiss()` it from an action. */
  static show(props: Dialog.Props): Dialog {
    const $dialog = Dialog.makeWith(props);
    $dialog.open();
    return $dialog;
  }

  open(): void {
    const props = this.props;
    if (props == null) return;
    // Captured in the closure, not a field: the overlay returns the element
    // to the pool BEFORE it fires `onDismiss`, and `onRecycle` clears fields.
    const $invoker = Focus.activeDeep();
    Overlay.instance.get().reveal(this, {
      onDismiss: () => {
        // Dismissed content remains connected during the overlay animation.
        this.focusEpoch++;
        Dialog.restore($invoker, this, props);
      },
      canDismiss: () => props.dismissible,
      position: null,
    });
    // Entry: an alert lands on its first action so Enter answers it; a
    // dialog lands on the panel so the reader hears the title first.
    const epoch = ++this.focusEpoch;
    requestAnimationFrame(() => {
      if (epoch !== this.focusEpoch || !this.isConnected || this.props !== props ||
          !Overlay.isRevealed(this)) return;
      // Reveal appends through a queued mutation; measure after it is mounted.
      const $first = this.focusables()[0];
      const $target = props.alert && $first != null ? $first : this.$panel;
      $target.focus();
    });
  }

  /** Focus goes back to the invoker unless the caller already moved it
   * somewhere deliberate; then the caller's own `onDismiss`. */
  private static restore($invoker: Option<HTMLElement>, $dialog: Dialog, props: Dialog.Props): void {
    if ($invoker != null && Focus.isLostOrWithin($dialog)) $invoker.focus();
    props.onDismiss?.();
  }

  private focusables(): HTMLElement[] {
    const found: HTMLElement[] = [];
    const visited = new Set<Element>();
    const visit = ($node: Element): void => {
      if (visited.has($node)) return;
      visited.add($node);
      if ($node.hasAttribute("hidden") || $node.hasAttribute("inert") ||
          $node.hasAttribute("disabled") || $node.getAttribute("aria-disabled") === "true" ||
          $node.matches(":disabled")) return;
      const style = getComputedStyle($node);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse") return;
      // Follow assigned slots and open shadow roots, including weather search.
      const before = found.length;
      if ($node instanceof HTMLSlotElement) {
        const assigned = $node.assignedElements({ flatten: true });
        for (const $child of assigned.length > 0 ? assigned : $node.children) visit($child);
      } else if ($node.shadowRoot != null) {
        for (const $child of $node.shadowRoot.children) visit($child);
      } else {
        for (const $child of $node.children) visit($child);
      }
      if (!($node instanceof HTMLElement)) return;
      if ($node.hasAttribute("tabindex") && $node.tabIndex < 0) return;
      const native = $node.matches("button, input:not([type=hidden]), select, textarea, a[href], area[href]");
      const editable = $node.hasAttribute("contenteditable") && $node.isContentEditable;
      const explicit = $node.hasAttribute("tabindex") && $node.tabIndex >= 0;
      if (!(native || editable || explicit) || $node.getClientRects().length === 0) return;
      // A custom host and its native shadow control represent one tab stop.
      if ($node.shadowRoot != null && found.length > before) return;
      found.splice(before, 0, $node);
    };
    for (const $child of this.$panel.children) visit($child);
    return found;
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    // The modal owns Tab before a nested input can stop its bubbling event.
    e.preventDefault();
    e.stopPropagation();
    const list = this.focusables();
    if (list.length === 0) return;
    const active = Focus.activeDeep();
    const i = active == null ? -1 : list.indexOf(active);
    let next: number;
    if (e.shiftKey) next = i <= 0 ? list.length - 1 : i - 1;
    else next = i < 0 || i === list.length - 1 ? 0 : i + 1;
    list[next].focus();
  };


  static $styles = [
    LonaModalWebComponent.$style,
    Typography.$style,
    Button.$style,
    css`
      :host {
        --dialog-max-width: var(--dialog-max-width-preset, 440px);
        --dialog-padding: var(--dialog-padding-preset, 20px);
        --dialog-radius: 16px;

        display: block;
        max-width: var(--dialog-max-width);
      }

      #panel {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: var(--dialog-padding);
        border-radius: var(--dialog-radius);
        background: var(--bg);
        box-shadow: 0 24px 64px color-mix(in srgb, var(--text-pri) 22%, transparent);
        outline: none;
      }

      #title {
        --font-size: var(--h6-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 600;
        color: var(--text-pri);
        padding-right: 32px;
      }

      #description {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }

      #actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      #close {
        top: 12px;
        right: 12px;
      }

      #description[hidden],
      #body[hidden],
      #actions[hidden],
      #close[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`
    <div id="panel">
      <p id="title"></p>
      <p id="description" hidden></p>
      <div id="body" hidden></div>
      <div id="actions" hidden></div>
      <std-modal-close-button id="close"></std-modal-close-button>
    </div>
  `;
}

export namespace Dialog {
  export type Action = {
    label: string;
    type: "flat" | "primary" | "secondary" | "destructive";
    onClick: EmptyFunction;
  };
  export type Props = {
    title: string;
    description: Option<string>;
    $body: Option<() => HTMLElement>;
    actions: Action[];
    /** `alertdialog`: focus lands on the first action. */
    alert: boolean;
    /** Escape, the backdrop and the close button; `false` leaves only the actions. */
    dismissible: boolean;
    onDismiss: Option<EmptyFunction>;
  };
}
