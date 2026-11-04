/**
 * The floating control bar every mini-app canvas puts at the bottom of its
 * viewport: flat toggle buttons in sections, separated by hairlines.
 *
 * It lived as a private file inside `tento-task-graph.node` until a second
 * canvas app needed the same bar. A control owns its own interaction mechanics
 * wherever it is used, so it moved here rather than being copied — the second
 * copy is the bug, not the import.
 */
import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Button } from "@tento-ui/components/button/button";
import { Round } from "@tento-ui/components/round";
import { DomUtils } from "@tento-ui/dom";
import { Hr } from "@tento-ui/component-builtin";

@component({ name: "std-miniapp-action-bar" })
export class MiniappActionBar extends LonaWebComponent {
  private $bg = this.hydrate<Round>("bg").bind({ ...Round.Props.MODAL, bg: "var(--bg-elevated)" });
  private buttons = new Map<string, HTMLButtonElement>();

  bind(sections: MiniappActionBar.Item[][]): this {
    const children: HTMLElement[] = [];
    this.buttons.clear();
    sections.forEach((items, sectionIndex) => {
      if (sectionIndex) children.push(this.divider());
      for (const item of items) children.push(this.button(item));
    });
    DomUtils.reconcileChildren(this.$("items"), children);
    return this;
  }

  setActive(id: string, active: boolean): void {
    const button = this.buttons.get(id);
    if (!button) return;
    button.toggleAttribute("selected", active);
    button.setAttribute("aria-pressed", String(active));
  }

  buttonElement(id: string): HTMLButtonElement | null {
    return this.buttons.get(id) ?? null;
  }

  private button(item: MiniappActionBar.Item): HTMLButtonElement {
    const button = Button.makeWithLight(item.label, {
      type: "flat",
      size: "thin",
      onClick: item.onClick,
    });
    button.setAttribute("aria-label", item.ariaLabel ?? item.label);
    if (item.toggle) button.setAttribute("aria-pressed", String(item.active ?? false));
    button.toggleAttribute("selected", item.active ?? false);
    this.buttons.set(item.id, button);
    return button;
  }

  private divider(): HTMLElement {
    return Hr.make().assignStyles({
      width: "1px", height: "22px", marginInline: "5px",
      backgroundColor: "var(--divider)", border: "none",
    });
  }

  static $styles = [Button.$style, css`
    :host { position: fixed; left: 50%; bottom: var(--miniapp-action-bar-bottom, 14px); z-index: 2100; transform: translateX(-50%); }
    #root { position: relative; height: 38px; padding: 4px 8px; align-items: center; }
    #items { position: relative; height: 100%; display: flex; align-items: center; }
    button { height: 30px; min-width: 32px; padding-inline: 9px; }
    button[selected] { color: var(--text-pri); background: var(--bg-selected); }
    button[context-menu-open]:focus-visible { outline: none; }
  `];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root"><std-round id="bg" floating></std-round><div id="items"></div></std-row>
  `;
}

export namespace MiniappActionBar {
  export type Item = {
    id: string; label: string; ariaLabel?: string;
    toggle?: boolean; active?: boolean; onClick: () => void;
  };
}
