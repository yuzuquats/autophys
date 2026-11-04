import type { CookbookApp, CookbookShell } from "../src/types.ts";
import { h, settleIn } from "../src/dom.ts";
import { mountView, type View, type ViewHandle } from "../src/view.ts";

type Row = { id: string; title: string };
type Model = { row: Row; position: number; count: number; title: string };

/**
 * A vanilla CookbookApp: neutral rows in the queue, a placeholder stage in
 * main, the selected row's facts in details. Main and details are drawn
 * with the View helper (Cookbook.View.mount), so a selection redraws them
 * inside shell.reflow. It shows every slot working and is the starting
 * point an app replaces piece by piece.
 */
export class PlaceholderApp implements CookbookApp {
  private selected: string;
  private abort: AbortController | null = null;
  private removeStyles: (() => void) | null = null;
  private views: ViewHandle[] = [];

  constructor(
    readonly id: string,
    readonly title: string,
    private rows: readonly Row[] = [1, 2, 3].map((n) => ({ id: `item-${n}`, title: `Item ${n}` })),
  ) {
    this.selected = rows[0]?.id ?? "";
  }

  /** The model both views draw: the selected row and where it sits. */
  model(): Model {
    const row = this.rows.find((r) => r.id === this.selected) ?? this.rows[0];
    return { row, position: this.rows.indexOf(row) + 1, count: this.rows.length, title: this.title };
  }

  mount(shell: CookbookShell): void {
    this.abort = new AbortController();
    const { slots, classes, scope } = shell;
    this.removeStyles = shell.addStyles(`
      ${scope} .ph-stage { position: relative; flex: 1; min-height: 120px; display: grid; place-items: center;
        border-radius: 12px; background: oklch(97% 0 0); color: oklch(70.8% 0 0); font: 500 13px/20px ui-monospace, monospace; }
      ${scope} .ph-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
      ${scope} .ph-detail p { margin-top: 12px; }
      ${scope} .ph-facts { margin: 0; }
      ${scope} .ph-facts div { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0;
        border-top: 1px solid #d9d9d9; font-size: 12px; line-height: 16px; }
      ${scope} .ph-facts dt { color: oklch(43.9% 0 0); }
      ${scope} .ph-facts dd { margin: 0; }
    `);
    slots.queue.replaceChildren(
      h(
        "ul",
        classes.list ?? "",
        null,
        ...this.rows.map((row) =>
          h(
            "li",
            "",
            null,
            h("button", classes.listItem ?? "", {
              type: "button",
              "data-row": row.id,
            }, row.title),
          )
        ),
      ),
    );
    const model = () => this.model();
    this.views = [
      mountView(shell, mainView(slots.main, classes.toolbar ?? ""), model),
      mountView(shell, detailsView(slots.details, classes), model),
    ];
    const markQueue = () => {
      for (const button of slots.queue.querySelectorAll<HTMLElement>("[data-row]")) {
        button.setAttribute("aria-current", String(button.dataset.row === this.selected));
      }
      shell.setCrumb?.(this.model().row.title);
    };
    markQueue();
    slots.queue.addEventListener("click", (event) => {
      const id = (event.target as Element).closest<HTMLElement>("[data-row]")?.dataset.row;
      if (!id || id === this.selected) return shell.onSelect();
      this.selected = id;
      markQueue();
      for (const view of this.views) view.redraw();
      for (const el of slots.main.querySelectorAll(".ph-title, .ph-label")) settleIn(el);
      settleIn(slots.details);
      shell.onSelect();
    }, { signal: this.abort.signal });
  }

  unmount(): void {
    for (const view of this.views) view.dispose();
    this.views = [];
    this.abort?.abort();
    this.removeStyles?.();
    this.abort = this.removeStyles = null;
  }

  export(): unknown {
    return { app: this.id, selected: this.selected, rows: this.rows };
  }
}

/** Main: a toolbar with the row's title over a placeholder stage. Elements
 * are built once and updated in place, so FLIP can follow them. */
function mainView(host: HTMLElement, toolbarClass: string): View<Model> {
  host.innerHTML = `<div class="${toolbarClass}"><h1 class="ph-title"></h1></div>
    <div class="ph-stage"><span class="ph-label"></span></div>`;
  const title = host.querySelector(".ph-title")!, label = host.querySelector(".ph-label")!;
  return {
    render(m) {
      title.textContent = m.row.title;
      label.textContent = m.title;
    },
    destroy: () => host.replaceChildren(),
  };
}

/** Details: the row's name, two facts and a placeholder status line. */
function detailsView(host: HTMLElement, classes: CookbookShell["classes"]): View<Model> {
  host.innerHTML = `<div class="ph-detail"><h3 class="${classes.name ?? ""}"></h3><dl class="ph-facts"></dl>
    <p class="${classes.status ?? ""}">Placeholder status</p></div>`;
  const name = host.querySelector("h3")!, facts = host.querySelector(".ph-facts")!;
  return {
    render(m) {
      name.textContent = m.row.title;
      facts.replaceChildren(
        h(
          "div",
          "",
          null,
          h("dt", "", null, "ID"),
          h("dd", "", null, m.row.id),
        ),
        h(
          "div",
          "",
          null,
          h("dt", "", null, "Position"),
          h("dd", "", null, `${m.position} of ${m.count}`),
        ),
      );
    },
    destroy: () => host.replaceChildren(),
  };
}
