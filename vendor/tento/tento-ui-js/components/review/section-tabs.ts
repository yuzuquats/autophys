import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";

// Horizontal pill-tab bar for the dev "review surface" pages — the shared
// extraction of market-research's `#page-tabs` and campaigns' `.review-tabs`
// (previously hand-rolled per page). It owns ONLY the tab bar: it renders the
// pills, tracks the selected one, and reports clicks via `onSelect`. The page
// still owns its panels (show/hide) and any per-tab side effects.
@component({ name: "std-section-tabs" })
export class SectionTabs extends LonaWebComponent {
  private $nav: HTMLElement = this.$("nav");

  private vm: Option<SectionTabs.ViewModel>;
  private activeId: Option<string>;

  static makeWith(vm: SectionTabs.ViewModel): SectionTabs {
    return SectionTabs.make().bind(vm);
  }

  bind(vm: SectionTabs.ViewModel): this {
    this.vm = vm;
    this.activeId = vm.activeId;
    this.renderTabs();
    return this;
  }

  // Reflect a selection the page drove elsewhere (e.g. a tab closed
  // programmatically) without rebuilding the bar.
  setActive(id: string): void {
    this.activeId = id;
    for (const $btn of this.$tabButtons()) {
      this.markSelected($btn, $btn.dataset.tabId === id);
    }
  }

  private $tabButtons(): HTMLButtonElement[] {
    return [
      ...this.$nav.querySelectorAll<HTMLButtonElement>("button.section-tab"),
    ];
  }

  private markSelected($btn: HTMLButtonElement, selected: boolean): void {
    $btn.toggleAttribute("selected", selected);
    $btn.setAttribute("aria-selected", selected ? "true" : "false");
  }

  private renderTabs(): void {
    const vm = this.vm;
    if (vm == null) return;
    DomUtils.clearChildren(this.$nav);
    for (const tab of vm.tabs) {
      this.$nav.appendChild(this.$tabButton(tab, vm.onSelect));
    }
  }

  private $tabButton(
    tab: SectionTabs.Tab,
    onSelect: (id: string) => void,
  ): HTMLButtonElement {
    const $btn = document.createElement("button");
    $btn.type = "button";
    $btn.className = "section-tab";
    $btn.dataset.tabId = tab.id;
    $btn.setAttribute("role", "tab");

    // Label is a typography element (`.small`) so the lona consumption rule
    // (Typography base style) applies `--font-size`; the pill is flex-centred,
    // so its own baseline margins are zeroed via `margin: 0`.
    const $label = Typography.small(tab.label);
    $label.classList.add("section-tab-label");
    $btn.appendChild($label);

    this.markSelected($btn, tab.id === this.activeId);
    GESTURE_MANAGER.addPointerEvent($btn, {
      onClick: () => {
        this.setActive(tab.id);
        onSelect(tab.id);
      },
    });
    return $btn;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
      }

      #nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .section-tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 28px;
        padding: 0 10px;
        min-height: unset;
        margin: 0;
        /* The UA stylesheet gives form controls their own family, which beats
           anything inherited — so without this a tab keeps Arial on a page set
           to any other face, and the label inside it inherits the Arial too. */
        font-family: inherit;
        border: 1px solid var(--divider);
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }

      .section-tab:hover {
        background: var(--bg-surface-light);
      }

      .section-tab[selected] {
        border-color: var(--text-pri);
        background: var(--text-pri);
      }

      .section-tab:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      .section-tab-label {
        --font-size: var(--text-10px);
        margin: 0;
        letter-spacing: 0;
        color: var(--text-sec);
      }

      .section-tab[selected] .section-tab-label {
        color: var(--bg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <nav id="nav" role="tablist"></nav>
  `;
}

export namespace SectionTabs {
  export interface Tab {
    id: string;
    label: string;
  }

  export interface ViewModel {
    tabs: Tab[];
    activeId: string;
    onSelect: (id: string) => void;
  }
}
