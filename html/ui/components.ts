import { ColumnsIcon, GearIcon, ComponentIcon, DatabaseIcon, FormulaIcon, BarChartIcon,
  PlayIcon, CheckmarkIcon, EyeIcon, GridIcon, SearchIcon, PlusIcon, ChevronRightIcon } from "@tento-ui/ui/icons";
export const chevronIcon = ChevronRightIcon;
const icons: Record<string, string> = { workspace: ColumnsIcon, config: GearIcon, investigation: ComponentIcon,
  measurement: DatabaseIcon, fit: FormulaIcon, sensitivity: BarChartIcon, proposal: PlayIcon,
  validate: CheckmarkIcon, view: EyeIcon, landscape: GridIcon, zoom: SearchIcon, plus: PlusIcon, chevron: ChevronRightIcon };

/// <reference lib="dom" />
/** Browser-only component binding. The data attributes contain already-derived view text. */
import { EmptyState } from "@tento-ui/components/empty-state/empty-state";
import { Skeleton } from "@tento-ui/components/skeleton/skeleton";
import { SelectInput } from "@tento-ui/components/input/select-input";
import { Button } from "@tento-ui/components/button/button";
import type { IntentHandler } from "./intent.ts";

export function hydrateComponents(host: HTMLElement, onIntent: IntentHandler): void {
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-icon]")) {
    marker.style.cssText = "display:inline-flex;width:14px;height:14px;flex:none";
    marker.innerHTML = (icons[marker.dataset.apIcon!] ?? "").replace("<svg", '<svg width="14" height="14" aria-hidden="true"');
  }
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-empty]")) {
    marker.replaceChildren(EmptyState.makeWith({ title: marker.dataset.title!, description: marker.dataset.description!, icon: null,
      $illustration: null, primary: null, secondary: null, announce: false }));
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
