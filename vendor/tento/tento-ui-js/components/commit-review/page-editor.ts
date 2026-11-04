import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";

// The plan-page editor's two PURE controls (plan frame 5): the header's
// edit ⇄ cancel verb and the action bar under an editing page. Presentation
// only — templates and stylesheets; what save DOES, what the chevron
// reveals, when cancel confirms is all wired by the owner (ProjectPane's
// `pageEditor`). Each control is a component so it carries its own shadow
// root: adopted into the accordion's shadow tree, its stylesheet travels
// with it — which is why these are components rather than bare elements
// (a bare element there is out of every stylesheet's reach and degenerates
// into inline styles and JS hover handlers).

/** The edit ⇄ cancel toggle that rides a doc item's header. A control, not
 * prose: small register, pill hover, pointer-scoped — the gesture stops
 * propagation, so toggling the editor never toggles the accordion item
 * under it. The label and title flip together through `setEditing`; which
 * state the session is in belongs to the owner. */
@component({ name: "std-edit-verb" })
export class EditVerb extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private model: Option<EditVerb.Model> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => this.model?.onToggle(),
    });
  }

  bind(model: EditVerb.Model): void {
    this.model = model;
    this.setEditing(false);
  }

  setEditing(editing: boolean): void {
    this.$root.textContent = editing ? "cancel" : "edit";
    this.title = editing
      ? "stop editing — asks first if there are unsaved changes"
      : "edit this page — save absorbs into the plan's own draft";
  }

  onRecycle(): void {
    super.onRecycle();
    this.model = null;
  }

  static $styles = [
    css`
      :host {
        display: inline-flex;
        margin-right: 6px;
        cursor: pointer;
      }

      #root {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        padding: 2px 8px;
        border-radius: 6px;
        color: var(--text-ter);
        transition:
          background-color 0.15s ease,
          color 0.15s ease;
        user-select: none;
      }

      #root:hover {
        background: var(--bg-hover);
        color: var(--text-sec);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p class="small" id="root">edit</p>
  `;
}

export namespace EditVerb {
  export type Model = {
    /** One callback for both faces: the owner knows whether this click
     * means "open the editor" or "ask it to cancel". */
    onToggle: EmptyFunction;
  };
}

/** The action row under an editing page: an error lane and the split
 * [save][⌄] button — two std-buttons sharing a 2px seam, the outer corners
 * keeping the family's radius and the inner ones cut to 2px. Hidden until
 * the owner shows it; saving flips the primary's label and disables it. */
@component({ name: "std-page-editor-bar" })
export class PageEditorBar extends LonaWebComponent {
  private $error: HTMLElement = this.$("error");
  private $save: Button = this.hydrate("save");
  private $more: Button = this.hydrate("more");
  private model: Option<PageEditorBar.Model> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$save, {
      onClick: () => this.model?.onSave(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$more, {
      onClick: (_$el, _offset, e) =>
        this.model?.onMore({ x: e.clientX, y: e.clientY }),
    });
  }

  bind(model: PageEditorBar.Model): void {
    this.model = model;
    this.$save.title = model.saveTitle;
  }

  setShown(shown: boolean): void {
    this.toggleAttribute("shown", shown);
  }

  setSaving(saving: boolean): void {
    this.$save.textContent = saving ? "saving…" : "save";
    this.$save.toggleAttribute("disabled", saving);
  }

  setError(message: string): void {
    this.$error.textContent = message;
  }

  onRecycle(): void {
    super.onRecycle();
    this.model = null;
  }

  static $styles = [
    css`
      :host {
        display: none;
      }

      :host([shown]) {
        display: block;
      }

      #root {
        align-items: center;
        gap: 14px;
        margin-top: 8px;
      }

      #error {
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: 1;
        min-width: 0;
        color: var(--red);
      }

      #split {
        flex: none;
        align-items: stretch;
        gap: 2px;
      }

      #save {
        flex: none;
        --button-radius: 8px 2px 2px 8px;
        --button-padding: 6px 16px;
      }

      #more {
        flex: none;
        --button-radius: 2px 8px 8px 2px;
        --button-padding: 6px 6px;
      }

      #more svg {
        display: block;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <p class="small" id="error"></p>
      <std-row id="split">
        <std-button id="save" primary>save</std-button>
        <std-button id="more" primary title="more — discard changes">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"
              fill="currentColor"
            ></path>
          </svg>
        </std-button>
      </std-row>
    </std-row>
  `;
}

export namespace PageEditorBar {
  export type Model = {
    /** The primary's tooltip — the owner composes it, because naming the
     * absorb target is the owner's vocabulary, not this bar's. */
    saveTitle: string;
    onSave: EmptyFunction;
    /** The chevron's click, with the pointer's viewport point: the owner's
     * menu mounts at document level, and the pointer is the one frame both
     * sides of the shadow boundary agree on. */
    onMore: (point: { x: number; y: number }) => void;
  };
}
