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
