import { MiniWindow } from "./components/mini-window";
import { $$ } from "./fastdom";
import { LLMLogger } from "./llm-logger";

LLMLogger.registerShowMiniWindow((prefix, $content) => {
  const $miniWindow = MiniWindow.make();
  $miniWindow.style.setProperty("--mini-window-width", "320px");
  $miniWindow.style.setProperty("--mini-window-detached-width", "320px");
  $miniWindow.style.setProperty("--mini-window-height", "auto");
  $miniWindow.style.setProperty("--mini-window-detached-height", "auto");
  // Blue chrome marks the window as a live UX-test session (replaces the old
  // full-page outline overlay).
  $miniWindow.style.setProperty("--mini-window-nav-bg", "var(--blue-dimmed)");
  // `--text-pri-on-solid` is the token for text/icons on a solid color fill —
  // dark in both themes, so the title + minimize/close icons read clearly on the
  // `--blue-dimmed` chrome.
  $miniWindow.style.setProperty("--mini-window-nav-fg", "var(--text-pri-on-solid)");
  $miniWindow.bind({
    title: prefix,
    snapToCorners: true,
    dockable: true,
    onClose: () => {
      $miniWindow.hide();
      $miniWindow.remove();
    },
  });
  $miniWindow.appendChild($content);
  document.body.appendChild($miniWindow);
  $miniWindow.setAnimates(false);
  $miniWindow.reveal();
  $miniWindow.snapTo("bottom-left");
  $$.mutate(() => $miniWindow.setAnimates(true));
  return {
    dismiss: () => {
      $miniWindow.hide();
      $miniWindow.remove();
    },
  };
});
