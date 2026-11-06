/// <reference lib="dom" />
import { Stepper } from "@tento-ui/components/stepper";

const configurations = new WeakMap<HTMLElement, string>();
/** Keep authored step sections in light DOM, so field updates can be patched
 * without replacing the stepper or its editable controls. */
export function hydrateProjectSetup(host: HTMLElement): void {
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-stepper]")) {
    const sections = [...marker.querySelectorAll<HTMLElement>("[data-ap-step]")];
    const key = JSON.stringify(sections.map(step => [step.querySelector("h3")!.textContent, step.dataset.done, step.dataset.current]));
    if (configurations.get(marker) === key) continue;
    configurations.set(marker, key);
    const steps = sections.map((step, i) => {
      const slot = document.createElement("slot");
      step.slot = slot.name = `ap-setup-body-${i}`;
      step.querySelector<HTMLElement>("[data-ap-step-body]")!.dataset.step = String(i + 1);
      const heading = step.querySelector<HTMLHeadingElement>("h3")!;
      heading.hidden = true;
      return { ...Stepper.plain(heading.textContent!, slot), current: step.dataset.current === "true", marker: step.dataset.done === "true" ? "✓" : "" };
    });
    const existing = marker.querySelector<Stepper>(":scope > std-stepper");
    if (existing) existing.bind({ steps });
    else {
      const stepper = Stepper.makeWith({ steps });
      stepper.append(...sections);
      marker.replaceChildren(stepper);
    }
  }
}
