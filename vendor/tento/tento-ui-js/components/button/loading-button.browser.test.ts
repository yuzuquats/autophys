import { LoadingButton } from "./loading-button";

export async function verifyLoadingOwnership(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const press = (b: LoadingButton) => {
    b.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    b.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
  };
  const b = LoadingButton.make(); document.body.append(b);
  let errors = 0;
  b.addLoadingClickEvent(async () => { throw new Error("expected loading failure"); }, () => errors++);
  press(b); await Promise.resolve(); await Promise.resolve();
  if (errors !== 1 || b.shadowRoot!.querySelector("#root")!.firstElementChild?.tagName !== "SLOT") throw new Error("Loading failure did not reach caller and settle indicator");
  let oldResolve: EmptyFunction = () => {}, newResolve: EmptyFunction = () => {};
  b.addLoadingClickEvent(() => new Promise<void>(r => oldResolve = r)); press(b);
  LoadingButton.recycle(b); await frame();
  const reused = LoadingButton.make();
  if (reused !== b) throw new Error("LoadingButton actual pool reuse not exercised");
  reused.addLoadingClickEvent(() => new Promise<void>(r => newResolve = r)); document.body.append(reused); press(reused);
  oldResolve(); await Promise.resolve(); await Promise.resolve();
  if (reused.shadowRoot!.querySelector("#root")!.firstElementChild?.tagName === "SLOT") throw new Error("Old completion hid successor indicator");
  newResolve(); await Promise.resolve(); await Promise.resolve();
  if (reused.shadowRoot!.querySelector("#root")!.firstElementChild?.tagName !== "SLOT") throw new Error("Current completion did not settle indicator");
  let calls = 0, staleErrors = 0, rejectOld: (error: Error) => void = () => {};
  reused.addLoadingClickEvent(() => new Promise<void>((resolve, reject) => {
    if (++calls === 1) rejectOld = reject; else newResolve = resolve;
  }), () => staleErrors++);
  press(reused); press(reused); rejectOld(new Error("expected obsolete failure"));
  await Promise.resolve(); await Promise.resolve();
  if (calls !== 2 || staleErrors !== 0 || reused.shadowRoot!.querySelector("#root")!.firstElementChild?.tagName === "SLOT") throw new Error("Superseded same-binding operation notified or hid a new indicator");
  newResolve(); await Promise.resolve(); await Promise.resolve();
  if (reused.shadowRoot!.querySelector("#root")!.firstElementChild?.tagName !== "SLOT") throw new Error("Current same-binding operation did not settle");
  LoadingButton.recycle(reused); await frame();
  return ["Loading rejection caller delivery and stale completion through actual pooled reuse", "Loading same-binding newer operation suppresses old rejection and indicator updates"];
}
