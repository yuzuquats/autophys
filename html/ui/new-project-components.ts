/// <reference lib="dom" />
import { Stepper } from "@tento-ui/components/stepper";

/** Bind the vertical stepper. Bodies stay in light DOM so application styles,
 * pairing controls, copy buttons and composed intents retain their scope. */
export function hydrateProjectSetup(host: HTMLElement): void {
  for (const marker of host.querySelectorAll<HTMLElement>("[data-ap-stepper]")) {
    const bodies: HTMLElement[] = [];
    const steps = [...marker.querySelectorAll<HTMLElement>("[data-ap-step]")].map((step, i) => {
      const done = step.dataset.done === "true";
      const body = step.querySelector<HTMLElement>("[data-ap-step-body]")!;
      const slot = document.createElement("slot");
      body.slot = slot.name = `ap-setup-body-${i}`;
      body.dataset.step = String(i + 1);
      bodies.push(body);
      return { ...Stepper.plain(step.querySelector("h3")!.textContent!, slot),
        current: step.dataset.current === "true", muted: done, marker: done ? "✓" : "", tone: done ? "var(--ck-ok-wash,#e4f2e9)" : null,
        meta: done ? "Done" : null };
    });
    const stepper = Stepper.makeWith({ steps });
    stepper.append(...bodies);
    marker.replaceChildren(stepper);
  }
}
