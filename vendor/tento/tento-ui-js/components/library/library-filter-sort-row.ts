import "../../component-builtin";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { CheckmarkIcon } from "../../ui/icons";
import { Button } from "../button/button";
import { ContextMenu } from "../context-menu";

/** Vault #mini-banner: count, trailing label/value controls and a divider.
 * The caller owns available choices, filtering, sorting and result counts. */
@component({ name: "std-library-filter-sort-row" })
export class LibraryFilterSortRow extends LonaWebComponent {
  private $count = this.$("result-count");
  private $controls = this.$("controls");
  private props: Option<LibraryFilterSortRow.Props> = null;
  private $buttons = new Map<string, HTMLButtonElement>();
  private $menu: Option<ContextMenu.Built> = null;

  bind(props: LibraryFilterSortRow.Props): this {
    this.props = props;
    this.$count.textContent = props.resultText;
    const ids = props.controls.map(control => control.id);
    if (ids.join("\n") !== [...this.$buttons.keys()].join("\n")) {
      this.dismissMenu();
      DomUtils.clearChildren(this.$controls);
      this.$buttons.clear();
      for (const control of props.controls) {
        const $button = Button.makeLight();
        $button.type = "button";
        $button.className = "filter-button";
        $button.dataset.control = control.id;
        $button.setAttribute("aria-haspopup", "menu");
        $button.setAttribute("aria-expanded", "false");
        const $label = document.createElement("span");
        $label.className = "control-label";
        const $value = document.createElement("span");
        $value.className = "control-value";
        $button.append($label, $value);
        GESTURE_MANAGER.addPointerEvent($button, {onClick:()=>this.revealMenu(control.id, $button)});
        $button.onblur = () => $button.removeAttribute("pointer-focus");
        $button.onkeydown = event => {
          $button.removeAttribute("pointer-focus");
          if (event.key === "Escape" && this.$menu) {
            event.preventDefault();
            this.dismissMenu();
            return;
          }
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            event.preventDefault();
            this.revealMenu(control.id, $button, true);
          }
        };
        this.$buttons.set(control.id, $button);
        this.$controls.append($button);
      }
    }
    for (const control of props.controls) {
      const $button = this.$buttons.get(control.id);
      if (!$button) continue;
      const selected = control.options.find(option => option.value === control.value);
      $button.querySelector(".control-label")!.textContent = control.label;
      $button.querySelector(".control-value")!.textContent = selected?.label ?? control.value;
      $button.setAttribute("aria-label", `${control.label}: ${selected?.label ?? control.value}`);
      $button.disabled = !control.options.length || control.onChange == null;
    }
    return this;
  }

  private revealMenu(id: string, $button: HTMLButtonElement, keyboard = false): void {
    if (this.$menu) return;
    const control = this.props?.controls.find(item => item.id === id);
    if (!control || $button.disabled) return;
    const builder = ContextMenu.builder(Math.min(200, innerWidth - 16));
    for (const option of control.options) {
      builder.cellRow(option.label, option.value === control.value ? CheckmarkIcon : null, () => {
        this.props?.controls.find(item => item.id === id)?.onChange?.(option.value);
      });
    }
    $button.setAttribute("aria-expanded", "true");
    this.$menu = builder.buildAndReveal($button, {
      // ContextMenu mounts on the document, so use viewport coordinates.
      position: ({parentRect, contentRect}) => ({
        right: `${Math.max(8, Math.min(innerWidth - parentRect.right, innerWidth - contentRect.width - 8))}px`,
        top: `${parentRect.bottom + Math.min(contentRect.height, innerHeight - 16) + 4 <= innerHeight - 8
          ? parentRect.bottom + 4
          : Math.max(8, parentRect.top - Math.min(contentRect.height, innerHeight - 16) - 4)}px`,
      }),
      marginBlockPx: 4,
      cleanup: () => {
        this.$menu = null;
        $button.setAttribute("aria-expanded", "false");
        if ($button.isConnected) {
          // ContextMenu focuses its items. Pointer selection should not leave
          // the trigger looking hovered once the pointer moves away.
          $button.toggleAttribute("pointer-focus", !keyboard);
          $button.focus({preventScroll:true});
        }
      },
    });
    // Keep long facets reachable without scrolling the document or clipping
    // the popover's rounded background and shadow.
    const $choices = this.$menu.querySelector<HTMLElement>("std-col");
    if ($choices) {
      $choices.style.maxHeight = `${Math.max(0, innerHeight - 24)}px`;
      $choices.style.overflowY = "auto";
      $choices.style.overscrollBehavior = "contain";
    }
    this.$menu.setAttribute("aria-label", control.label);
    const $items = [...this.$menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    for (const [index, $item] of $items.entries()) {
      const option = control.options[index];
      $item.setAttribute("role", "menuitemradio");
      $item.setAttribute("aria-checked", String(option.value === control.value));
      $item.dataset.value = option.value;
    }
  }

  private dismissMenu(): void {
    this.$menu?.dismiss();
    this.$menu = null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.dismissMenu();
    // Bound data survives FlowContainer moving this row between pages.
  }

  onRecycle(): void {
    super.onRecycle();
    this.dismissMenu();
    this.props = null;
    this.$buttons.clear();
    DomUtils.clearChildren(this.$controls);
    this.$count.textContent = "";
  }

  static $styles = [css`
    /* The band's placement and its rule are knobs: a host that already has an
       inset, or whose content draws its own top rule, sets them rather than
       wrapping the row to undo them. Defaults are Vault's. */
    :host {
      --library-filter-sort-row-margin: 24px 12px 16px;
      --library-filter-sort-row-padding-bottom: 10px;
      --library-filter-sort-row-rule: 1px solid var(--divider);
      display:block;
      min-width:0;
    }
    #mini-banner {
      align-items:end;
      flex-wrap:wrap;
      row-gap:8px;
      margin:var(--library-filter-sort-row-margin);
      padding-bottom:var(--library-filter-sort-row-padding-bottom);
      border-bottom:var(--library-filter-sort-row-rule);
      color:var(--secondary-text-color, var(--text-sec));
      font-size:0.875rem;
      line-height:normal;
    }
    /* A leading region, ahead of the count: the row is where a collection says
       what is in it, and a switch between two readings of that collection is
       the same question asked one level up. It sits at the band's leading edge
       so the count reads as a caption on the chosen view rather than as a
       label the switch has to be found beside. Empty by default — a slot with
       nothing in it takes no space, and the count keeps the leading edge. */
    ::slotted([slot="leading"]) {
      margin-right:12px;
      margin-bottom:2px;
    }
    #result-count {
      margin-bottom:4px;
      margin-right:8px;
      color:var(--tertiary-text-color, var(--text-ter));
    }
    /* A row with nothing to report is a legitimate row: the count is one of
       three regions here, and an empty one should not spend its margin. */
    #result-count:empty { display:none; }
    #controls { margin-left:auto; gap:8px; flex-wrap:wrap; justify-content:flex-end; max-width:100%; }
    .filter-button {
      display:flex;
      flex-direction:column;
      align-items:stretch;
      min-width:100px;
      max-width:100%;
      border:0;
      border-radius:8px;
      padding:4px 12px;
      text-align:left;
      font:inherit;
      color:inherit;
      background:transparent;
      cursor:pointer;
    }
    .filter-button:enabled:hover { background:var(--hover-color, var(--bg-surface-light)); }
    .filter-button:focus { outline:none; }
    .filter-button:focus-visible:not([pointer-focus]) { background:var(--hover-color, var(--bg-surface-light)); }
    .filter-button:disabled { opacity:0.5; cursor:default; }
    .control-label { font-size:0.7rem; font-weight:700; color:var(--tertiary-text-color, var(--text-ter)); margin-bottom:2px; }
    .control-value { overflow-wrap:anywhere; }
  `];

  static $html = html`<std-row id="mini-banner"><slot name="leading"></slot><span id="result-count" role="status"></span><std-row id="controls"></std-row></std-row>`;
}

export namespace LibraryFilterSortRow {
  export type Choice = { value: string; label: string };
  export type Control = {
    id: string;
    label: string;
    value: string;
    options: Choice[];
    onChange: Option<(value: string) => void>;
  };
  export type Props = { resultText: string; controls: Control[] };
}
