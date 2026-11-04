import type { CookbookShell } from "./types.ts";

/** Something that draws a model into an element it owns. */
export type View<M> = { render(model: M): void; destroy(): void };

/** What View.mount returns: redraw from the current model, or tear down. */
export type ViewHandle = {
  /** Read the model again and render it inside shell.reflow, so the main
   * column moves with FLIP. A no-op after dispose. */
  redraw(): void;
  /** Destroy the view once; later redraws do nothing. */
  dispose(): void;
};

/**
 * Draw `view` once from `model()`, then on each `redraw()` draw again inside
 * `shell.reflow` (plain render when the shell has no reflow). Optional for
 * apps: slots stay opaque, and an app may fill them however it likes.
 * Call `dispose()` from the app's unmount.
 */
export function mountView<M>(shell: Pick<CookbookShell, "reflow">, view: View<M>, model: () => M): ViewHandle {
  let live = true;
  view.render(model());
  return {
    redraw() {
      if (!live) return;
      const draw = () => view.render(model());
      if (shell.reflow) shell.reflow(draw);
      else draw();
    },
    dispose() {
      if (!live) return;
      live = false;
      view.destroy();
    },
  };
}
