/** The cookbook guides the existing account Controller; it never owns data. */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import type { Controller } from "../client/controller.ts";
import { tourSteps, type TourPart } from "./guided-tour-steps.ts";

type Host = { controller: Controller; signedIn(): boolean; redraw(): void };
export function mountGuidedTour(host: Host) {
  const ctl = host.controller;
  const style = document.createElement("style");
  style.textContent = `
    .ck-target-ring { transition:none; box-shadow:0 0 0 1px rgb(91 142 196 / 60%),0 0 0 4px rgb(91 142 196 / 14%) !important; }
    @media(max-width:600px) {
      .ck-tour { padding-block:14px 10px; }
      .ck-tour-bars { margin-bottom:8px; }
      .ck-tour-title { font-size:18px;line-height:22px; }
      .ck-tour-body { font-size:13px;line-height:18px; }
      .ck-tour-actions { padding-top:8px; }
    }
  `;
  document.head.append(style);
  let disposed = false, generation = 0, restore: (() => void) | undefined;
  const panels = () => document.querySelector<HTMLElement>(".ck-panels");
  const toggle = (which: string, open: boolean) => {
    const button = document.querySelector<HTMLButtonElement>(".ck-" + which + "-toggle");
    if (button && (button.getAttribute("aria-pressed") === "true") !== open) button.click();
  };
  const layout = (surface: TourPart["surface"], details: boolean) => {
    if (matchMedia("(max-width:760px)").matches) {
      const current = panels()?.dataset.mobile;
      if (current && current !== "main") toggle(current, false);
      if (surface !== "main") toggle(surface, true);
    } else { toggle("sidebar", true); toggle("details", details); }
    host.redraw();
  };
  const source: Cookbook.Tutorial.Source = {
    async start() {
      const own = ++generation;
      if (disposed || !host.signedIn() || ctl.view().main.body.kind === "project-setup") return [];
      let restoreNavigation = () => {};
      const sidebar = document.querySelector(".ck-sidebar-toggle")?.getAttribute("aria-pressed") === "true";
      const details = document.querySelector(".ck-details-toggle")?.getAttribute("aria-pressed") === "true";
      const mobile = panels()?.dataset.mobile ?? "main";
      const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const scroll = [".ck-queue", ".ck-main .ck-panel-body", ".ck-details .ck-panel-body", ".ap-viewer"].map(selector => {
        const element = document.querySelector(selector);
        return { selector, top: element?.scrollTop ?? 0, left: element?.scrollLeft ?? 0 };
      });
      restore = () => {
        restoreNavigation();
        if (matchMedia("(max-width:760px)").matches) {
          const current = panels()?.dataset.mobile;
          if (current && current !== "main") toggle(current, false);
          if (mobile !== "main") toggle(mobile, true);
        } else { toggle("sidebar", sidebar); toggle("details", details); }
        host.redraw();
        for (const saved of scroll) {
          const element = document.querySelector(saved.selector);
          if (element) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
        }
        if (focus?.isConnected) focus.focus({ preventScroll: true });
      };
      // Set the first lesson's panels before yielding, so initial load cannot
      // briefly show Details and then close it when the workspace arrives.
      layout("sidebar", false);
      try { await ctl.store.start(); } catch { return []; }
      if (disposed || own !== generation || !host.signedIn()) return [];
      const snap = ctl.store.snapshot();
      if (!snap) return [];
      restoreNavigation = ctl.preserveNavigation();
      return tourSteps(snap.workspace, ctl.selection).map(part => ({
        title: part.title, body: part.body, group: part.group, target: part.target,
        enter() {
          if (disposed || own !== generation) return;
          if (part.select) ctl.handle({ kind: "select", id: part.select });
          layout(part.surface, part.details);
        },
      }));
    },
    finish() {
      generation++;
      const finish = restore; restore = undefined;
      finish?.();
    },
  };
  return { source, dispose() { source.finish?.({ completed: false }); disposed = true; style.remove(); } };
}
