import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { DomEventUtils } from "../dom-event-utils";
import { $$ } from "../fastdom";
import { Placeholder } from "./placeholder";

/**
 * There's no simple way to create an editable web text component unfortunately.
 *
 * Couple of options considered:
 *   1) The element itself can be toggled contenteditable
 *
 *      ie. <std-editable-text contenteditable>Hello</...>
 *
 *          const template = `<slot></slot>`
 *
 *      This would seem like the most canonical way of wiring up such a
 *      component. Unfortunately, text selection and deletion act on text
 *      "nodes". In other words, a single backspace character will delete the
 *      entire string of characters
 *
 *   2) The element wraps a contenteditable component
 *
 *      This is what's used below.
 *
 *      Unfortunately, we need to consider that when the node is cloned, the
 *      state of the internal shadowRoot is not replicated. This means that we
 *      will have to also encode the text content of the element as either an
 *      attribute or the ~innerHTML~. Note: it's not possible to set the
 *      innerHTML here since it will cause the component to blur.
 *
 *      During rehydration (onConnectedCallback), we will have to rebind as per
 *      what's in the serialized DOM element.
 *
 *      This is suboptimal for the design pattern we're using since it means
 *      that there are technically multiple sources of truth for the data of a
 *      given component. (EdtiableText::bind vs setAttribute("text", "hello")).
 *
 *      The latter seems more "correct" but requires a lot more plumbing.
 *
 *      Will need to experiment with the 2 to see how they fare.
 *
 *   3) We use a virtual DOM to manage the contenteditable state
 *
 *      This unfortunately breaks encapsulation pretty hard - we need a
 *      mutation observer to handle cases such as Apple's emoji picker,
 *      copy-paste, etc. Maybe it's possible to create some sort of a manager
 *      to decorate certain divs, but overall I'm not sure if it's worth the
 *      hassle.
 */
@component({
  name: "std-editable-text",
})
export class EditableText extends LonaWebComponent {
  #controller: Option<EditableText.Controller>;
  get controller(): EditableText.Controller {
    if (this.#controller) return this.#controller;
    return (this.#controller = new EditableText.Controller(this.$("root")));
  }

  static get observedAttributes() {
    return ["text", "selectable"];
  }

  get text(): Option<string> {
    return this.controller.text;
  }

  static makeWith(
    text: Option<string>,
    onTextChange: (t: Option<string>) => void,
    options?: Optional<{
      placeholder: string;
      withOutline: boolean;
    }>,
  ): EditableText {
    const $e = EditableText.make();
    $e.bind(text, options?.placeholder, options?.withOutline ?? false);
    $e.controller.onTextChange = onTextChange;
    return $e;
  }

  onRecycle(): void {
    this.#controller?.dispose();
    this.#controller = null;
    super.onRecycle();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#controller?.resume();
  }

  disconnectedCallback(): void {
    this.#controller?.suspend();
    super.disconnectedCallback();
  }

  toggleEditable(editable: boolean, focus: boolean = false) {
    if (editable) {
      this.controller.enableEditing(focus);
    } else {
      this.controller.disableEditing();
    }
    this.toggleAttribute("disabled", !editable);
  }

  toggleEditing(focus: boolean = false) {
    this.controller.toggleEditing(focus);
  }

  enableEditing(focus: boolean = false, cursorEnd = true) {
    this.controller.enableEditing(focus, cursorEnd);
  }

  disableEditing() {
    this.controller.disableEditing();
  }

  editable(): boolean {
    return this.controller.editable();
  }

  bind(
    text: Option<string>,
    placeholder: Option<string> = null,
    withOutline: boolean = false,
  ) {
    const normalizedText = text === "\n" ? "" : text;
    this.$("root").setAttribute("placeholder", placeholder ?? "");
    this.setAttribute("text", normalizedText ?? "");
    this.controller.text = normalizedText ?? "";
    this.toggleAttribute("with-outline", withOutline);
  }

  bindText(text: Option<string>) {
    const normalizedText = text === "\n" ? "" : text;
    this.setAttribute("text", normalizedText ?? "");
    this.controller.text = normalizedText ?? "";
  }

  attributeChangedCallback(
    name: string,
    _oldValue: Option<string>,
    newValue: Option<string>,
  ) {
    if (this.isConnected) return;
    // Framework recycling removes serialized attributes after onRecycle.
    // Clearing them must not recreate the controller we just disposed.
    if (newValue == null && this.#controller == null) return;

    switch (name) {
      case "text": {
        this.controller.text = newValue;
        break;
      }
      case "selectable": {
        this.controller.toggleSelectable(this.hasAttribute("selectable"));
      }
    }
  }

  static $styles = [
    Placeholder.$style,
    css`
      :host {
        position: relative;
        --font-size: var(--p-size);
        --line-height-ratio: 1.3;
        min-height: var(--font-size);
        display: block;
      }

      [placeholder]:empty {
        min-width: var(--placeholder-min-width);
      }

      :host([disabled]) {
        cursor: var(--disabled-cursor, default);
      }

      #root {
        width: 100%;
        padding-inline: var(--padding-inline);
        padding-block: var(--padding-block);
        --placeholder-left: var(--padding-inline);
        --placeholder-top: var(--padding-block);
        cursor: var(--cursor, "text");
        text-align: var(--text-align, start);
      }

      #root:focus,
      :host,
      :host:focus {
        outline: none;
      }

      :host([disabled]) #root {
        cursor: var(--disabled-cursor, default);
      }

      slot {
        user-select: all;
      }

      :host([with-outline]:hover)::after {
        content: "";
        position: absolute;
        inset: var(--outline-inset, -8px);
        border: 1px solid var(--divider);
        pointer-events: none;
        border-radius: 4px;
      }

      :host([one-line]) {
        overflow: hidden;
        min-width: 0;
      }

      :host([one-line]) #root {
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      #root::before {
        text-align: var(--text-align);
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
        height: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-flex style=min-height:var(--font-size);>
      <std-text id="root"></std-text>
    </std-flex>
  `;
}

export namespace EditableText {
  export class Controller {
    private $e: HTMLElement;
    /** Bumped by every enable and disable; a deferred enable applies only if it is still the latest. */
    #editingTurn = 0;
    private disposed = false;

    onTextChange: (t: Option<string>) => void = Constants.EMPTY_FUNCTION;
    onEnterKey: (t: Option<string>) => void = () => {
      this.$e.blur();
    };
    onEditingStarted: EmptyFunction = Constants.EMPTY_FUNCTION;
    onEditingFinished: (t: Option<string>) => void = Constants.EMPTY_FUNCTION;

    observer = new MutationObserver(() => {
      if (!this.disposed) this.onTextChange(this.text);
    });

    get text(): Option<string> {
      return this.$e.textContent !== "" ? this.$e.textContent : null;
    }

    set text(text: Option<string>) {
      if (this.disposed) return;
      this.observer.disconnect();
      const normalizedText = text === "\n" ? "" : text;
      this.$e.textContent = normalizedText ?? "";
      this.observer.observe(this.$e, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }

    constructor($e: HTMLElement) {
      this.$e = $e;
      this.$e.addEventListener("keydown", this.onKeydown);
      this.$e.addEventListener("keyup", this.onKeyup);
      this.$e.addEventListener("blur", this.onBlur);
      this.$e.addEventListener("focus", this.onFocus);
    }

    private onKeydown = (e: KeyboardEvent) => {
        if (this.$e.textContent === "") {
          this.$e.textContent = null;
        }
        if (e.key === "Escape") return;
        if (e.key === "Enter" && !e.shiftKey) {
          this.onEnterKey(this.$e.textContent);
          e.preventDefault();
        }
        e.stopPropagation();
    };
    private onKeyup = (e: KeyboardEvent) => {
        if (this.$e.innerHTML === "<br>") {
          this.$e.textContent = null;
        }
        e.stopPropagation();
    };
    private onBlur = () => this.onEditingFinished(this.$e.textContent);
    private onFocus = () => this.onEditingStarted();

    /** Preserve callbacks across reversible detach, but retire queued editing. */
    suspend(): void {
      this.#editingTurn++;
      this.observer.disconnect();
      this.$e.removeAttribute("contenteditable");
      if (!this.selectable()) {
        this.$e.onpointerdown = null;
        this.$e.onpointerup = null;
        this.$e.ondblclick = null;
      }
    }

    resume(): void {
      if (this.disposed) return;
      this.observer.observe(this.$e, { characterData: true, childList: true, subtree: true });
    }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.suspend();
      this.$e.removeEventListener("keydown", this.onKeydown);
      this.$e.removeEventListener("keyup", this.onKeyup);
      this.$e.removeEventListener("blur", this.onBlur);
      this.$e.removeEventListener("focus", this.onFocus);
      this.onTextChange = Constants.EMPTY_FUNCTION;
      this.onEnterKey = Constants.EMPTY_FUNCTION;
      this.onEditingStarted = Constants.EMPTY_FUNCTION;
      this.onEditingFinished = Constants.EMPTY_FUNCTION;
    }

    focus(cursorEnd: boolean = true) {
      if (this.disposed) return;
      this.$e.focus();
      if (cursorEnd) DomUtils.setEndOfContenteditable(this.$e);
    }

    selectable(): boolean {
      return this.$e.hasAttribute("selectable");
    }

    toggleSelectable(force?: boolean) {
      if (this.disposed) return;
      const selectable = this.$e.toggleAttribute("selectable", force);
      if (selectable || this.$e.hasAttribute("contenteditable")) {
        this.$e.onpointerdown = DomEventUtils.STOP_PROPAGATION;
        this.$e.onpointerup = DomEventUtils.STOP_PROPAGATION;
        this.$e.ondblclick = DomEventUtils.STOP_PROPAGATION;
      } else {
        this.$e.onpointerdown = null;
        this.$e.onpointerup = null;
        this.$e.ondblclick = null;
      }
    }

    toggleEditing(focus: boolean = true) {
      if (this.disposed) return;
      if (this.$e.hasAttribute("contenteditable")) {
        this.disableEditing();
      } else {
        this.enableEditing(focus);
      }
    }

    enableEditing(focus: boolean = true, cursorEnd: boolean = true) {
      if (this.disposed) return;
      const turn = ++this.#editingTurn;
      $$.mutateEnd(() => {
        if (this.disposed || turn !== this.#editingTurn) return;
        this.$e.toggleAttribute("contenteditable", true);
        if (!focus) return
        this.$e.focus();
        if (!cursorEnd) return;
        DomUtils.setEndOfContenteditable(this.$e);
      });
      this.observer.observe(this.$e, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      if (!this.selectable()) {
        this.$e.onpointerdown = DomEventUtils.STOP_PROPAGATION;
        this.$e.onpointerup = DomEventUtils.STOP_PROPAGATION;
        this.$e.ondblclick = DomEventUtils.STOP_PROPAGATION;
      }
    }

    disableEditing() {
      if (this.disposed) return;
      this.#editingTurn++;
      this.$e.blur();
      this.$e.toggleAttribute("contenteditable", false);
      if (!this.selectable()) {
        this.$e.onpointerdown = null;
        this.$e.onpointerup = null;
        this.$e.ondblclick = null;
      }
    }

    editable(): boolean {
      return this.$e.hasAttribute("contenteditable");
    }
  }
}
