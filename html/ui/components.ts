import { ColumnsIcon, LinkIcon, GearIcon, ComponentIcon, DatabaseIcon, FormulaIcon, BarChartIcon,
  PlayIcon, CheckmarkIcon, EyeIcon, GridIcon, SearchIcon, PlusIcon, ChevronRightIcon } from "@tento-ui/ui/icons";
export const chevronIcon = ChevronRightIcon;
const icons: Record<string, string> = { workspace: ColumnsIcon, device: LinkIcon, config: GearIcon, investigation: ComponentIcon,
  measurement: DatabaseIcon, fit: FormulaIcon, sensitivity: BarChartIcon, proposal: PlayIcon,
  validate: CheckmarkIcon, view: EyeIcon, landscape: GridIcon, zoom: SearchIcon, plus: PlusIcon, chevron: ChevronRightIcon };

/// <reference lib="dom" />
/** Browser-only component binding. The data attributes contain already-derived view text. */
import { EmptyState } from "@tento-ui/components/empty-state/empty-state";
import { Skeleton } from "@tento-ui/components/skeleton/skeleton";
import { SelectInput } from "@tento-ui/components/input/select-input";
import { Button } from "@tento-ui/components/button/button";
import { GridLayout } from "@tento-ui/components/grid/grid-layout";
import { ListCellLayout } from "@tento-ui/components/list/list-cell-layout";
import "@tento-ui/components/round";
import { Stepper } from "@tento-ui/components/stepper";
import type { TraceRow } from "./view-model.ts";
import { LabelTimeline } from "./timeline.ts";
import type { IntentHandler } from "./intent.ts";

export function hydrateComponents(host: HTMLElement, onIntent: IntentHandler): void {
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-icon]")) {
    marker.style.cssText = "display:inline-flex;width:14px;height:14px;flex:none";
    marker.innerHTML = (icons[marker.dataset.apIcon!] ?? "").replace("<svg", '<svg width="14" height="14" aria-hidden="true"');
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-empty]")) {
    const empty = EmptyState.makeWith({ title: marker.dataset.title!, description: marker.dataset.description!, icon: null,
      $illustration: null, primary: null, secondary: null, announce: false });
    // The shared component centres full-pane empties; section empties follow the section grid.
    if (marker.closest(".ap-gap")) {
      empty.style.justifyContent = "flex-start";
      const content = empty.shadowRoot!.querySelector<HTMLElement>("#root")!;
      content.style.cssText = "align-items:flex-start;text-align:left;padding:0;max-width:100%";
    }
    marker.replaceChildren(empty);
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-cell]")) {
    // The rendered title and caption become the cell's content slot (makeText needs tento's global DOM extensions).
    const content = document.createElement("div");
    content.className = "ap-cell-text";
    content.append(...marker.children);
    const cell = ListCellLayout.makeWith({ $content: content });
    cell.style.cssText = "--list-cell-padding:0;--list-cell-layout-hover-color:transparent";
    marker.replaceChildren(cell);
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-steps]")) {
    // A reasoning trace: earlier steps are history (muted, one line of text); the current one is the
    // reader's step and carries its evidence and expectation as an element body.
    const rows = JSON.parse(marker.dataset.apSteps!) as TraceRow[];
    const steps = rows.map((r): Stepper.Step => {
      // Every body is an element so text, evidence and expectation share one size and colour.
      let body: Stepper.Content | null = null;
      if (r.text || r.evidence?.length || r.expected) {
        // Inline: the stepper may adopt an element body into its shadow root, out of reach of the app's scoped sheet.
        const $body = document.createElement("div");
        $body.className = "ap-step-body";
        $body.style.cssText = "font:12px/17px var(--ap-font);color:var(--ap-sec)";
        const para = (text = "") => Object.assign(document.createElement("p"), { textContent: text, style: "margin:0" });
        if (r.text) $body.append(para(r.text));
        if (r.tone === "danger") $body.style.color = "var(--ap-danger)";
        if (r.evidence?.length) {
          const $ul = document.createElement("ul");
          $ul.style.cssText = "margin:2px 0 4px;padding-left:16px";
          for (const e of r.evidence) $ul.append(Object.assign(document.createElement("li"), { textContent: e }));
          $body.append($ul);
        }
        if (r.expected) {
          const $p = para(), $b = document.createElement("b");
          $b.style.cssText = "font-weight:600;color:var(--ap-ink)";
          $b.textContent = r.expected;
          $p.append("Expected: ", $b);
          $body.append($p);
        }
        body = $body;
      }
      return { ...Stepper.plain(r.title, body), marker: r.marker ?? "", meta: r.meta ?? null, current: Boolean(r.current), muted: !r.current,
        tone: r.tone === "danger" ? "var(--ap-danger)" : null };
    });
    marker.replaceChildren(Stepper.makeWith({ steps }));
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-grid]")) {
    const grid = GridLayout.make();
    grid.style.cssText = "display:block;width:100%";
    grid.append(...marker.children);
    marker.replaceChildren(grid);
    grid.bind({ blockSpacingPx: 10, inlineSpacingPx: 10, minWidthPx: Number(marker.dataset.apGrid) || 260 });
    // Every render replaces the grid; place the cards now instead of showing them stacked for a frame.
    grid.layoutGridSync();
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-timeline]")) {
    marker.replaceChildren(LabelTimeline.makeWith(JSON.parse(marker.dataset.apTimeline!)));
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-copy]")) {
    const button = Button.makeWith("Copy provenance", { type: "secondary" });
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(marker.dataset.apCopy!); button.textContent = "Copied"; }
      catch {
        const text = marker.parentElement?.querySelector("p");
        if (text) {
          const range = document.createRange(); range.selectNodeContents(text);
          const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        }
        button.textContent = document.execCommand("copy") ? "Copied" : "Selected · copy";
      }
    });
    marker.replaceChildren(button);
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-action]")) {
    const fallback = marker.querySelector<HTMLButtonElement>("button")!;
    const button = Button.makeWith(fallback.textContent!, { type: marker.dataset.apAction === "primary" ? "primary" : "secondary" });
    for (const a of fallback.attributes) if (a.name !== "class") button.setAttribute(a.name, a.value);
    marker.replaceChildren(button);
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-skeleton]")) {
    marker.replaceChildren(Skeleton.makeWith({ shape: "text", lines: 3, widthPx: null, heightPx: 12, animated: true }));
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-switcher]")) {
    marker.replaceChildren(SelectInput.makeWith({ name: "project", label: "Project", value: marker.dataset.value,
      options: JSON.parse(marker.dataset.options!), onChange: (value: string) => onIntent({ kind: "switch", value }) }));
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-button]")) {
    const name = marker.dataset.apButton!, label = marker.textContent!;
    const button = Button.makeWith(label, { type: "secondary" });
    // Native composed click supports pointer and keyboard activation alike.
    button.addEventListener("click", () => onIntent({ kind: "action", name }));
    marker.replaceChildren(button);
  }
}
