import { ModalCloseButton } from "./modal-close-button";

export async function verifyModalCloseButtonLifecycle(): Promise<string[]> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const results: string[] = [];
  const source = () => {
    const element = document.createElement("div");
    element.style.cssText = "height:20px;width:100px;overflow:auto";
    const child = document.createElement("div");
    child.style.height = "200px";
    element.append(child);
    document.body.append(element);
    return element;
  };
  const oldSource = source(), currentSource = source();
  let close = ModalCloseButton.make();
  let oldCalls = 0, currentCalls = 0;
  const press = () => {
    const button = close.shadowRoot!.querySelector<HTMLElement>("#button")!;
    button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
  };
  const scroll = (element: HTMLElement, top: number) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
  };
  try {
    close.bind({ onDismiss: () => oldCalls++, scrollSource: oldSource });
    document.body.append(close);
    press();
    scroll(oldSource, 10);
    if (oldCalls !== 1 || !close.hasAttribute("scrolled") || !close.hasAttribute("active")) {
      throw new Error("ModalCloseButton initial callback or scroll binding failed");
    }
    close.bind({});
    press();
    scroll(oldSource, 15);
    if (oldCalls !== 1 || close.hasAttribute("scrolled") || close.hasAttribute("active")) {
      throw new Error("ModalCloseButton omitted props retained previous callback, source or attributes");
    }
    results.push("ModalCloseButton omitted props clear callback, scroll source and attributes");

    close.bind({ onDismiss: () => currentCalls++, scrollSource: currentSource });
    scroll(oldSource, 0);
    press();
    scroll(currentSource, 10);
    if (oldCalls !== 1 || currentCalls !== 1 || !close.hasAttribute("scrolled")) {
      throw new Error("ModalCloseButton replacement callback or scroll binding failed");
    }
    scroll(oldSource, 0);
    if (!close.hasAttribute("scrolled")) throw new Error("ModalCloseButton old source altered new binding");
    results.push("ModalCloseButton replacement uses current callback and source only");

    close.remove();
    scroll(currentSource, 0);
    press();
    if (!close.hasAttribute("scrolled") || currentCalls !== 1) {
      throw new Error("ModalCloseButton disconnected instance retained active listener or callback");
    }
    document.body.append(close);
    if (close.hasAttribute("scrolled") || !close.hasAttribute("active")) {
      throw new Error("ModalCloseButton reconnect did not refresh scroll state");
    }
    scroll(currentSource, 10);
    press();
    if (!close.hasAttribute("scrolled") || Number(currentCalls) !== 2 || oldCalls !== 1) {
      throw new Error("ModalCloseButton reconnect did not restore current listener and callback exactly once");
    }
    results.push("ModalCloseButton disconnect suspends listeners and reconnect restores current binding");

    const previous = close;
    ModalCloseButton.recycle(close);
    await frame();
    close = ModalCloseButton.make();
    if (close !== previous) throw new Error("ModalCloseButton actual pool reuse not exercised");
    document.body.append(close);
    press();
    scroll(currentSource, 15);
    scroll(oldSource, 15);
    if (oldCalls !== 1 || Number(currentCalls) !== 2 || close.hasAttribute("scrolled") || close.hasAttribute("active")) {
      throw new Error("ModalCloseButton pooled instance retained predecessor binding");
    }
    let successorCalls = 0;
    scroll(oldSource, 0);
    close.bind({ onDismiss: () => successorCalls++, scrollSource: oldSource });
    press();
    scroll(oldSource, 10);
    if (successorCalls !== 1 || oldCalls !== 1 || Number(currentCalls) !== 2 || !close.hasAttribute("scrolled")) {
      throw new Error("ModalCloseButton pooled successor did not own callback and scroll state");
    }
    close.bindScrollSource(null);
    scroll(oldSource, 15);
    if (close.hasAttribute("scrolled") || close.hasAttribute("active")) throw new Error("ModalCloseButton explicit null did not clear scroll source");
    results.push("ModalCloseButton actual pooled reuse retires old binding and supports a fresh successor");
  } finally {
    ModalCloseButton.recycle(close);
    oldSource.remove();
    currentSource.remove();
    await frame();
  }
  return results;
}
