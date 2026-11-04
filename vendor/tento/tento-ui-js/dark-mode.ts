import { LiveData } from "@tento-core/livedata";
import { Tracing } from "@tento-core/tracing";

export namespace DarkMode {
  const _darkMode = new LiveData<boolean>(false);
  _darkMode.addListener(globalThis, (dm) => {
    if (typeof document !== "undefined" && document.documentElement?.style) {
      document.documentElement.style.colorScheme = dm ? "dark" : "light";
    }
  });
  _darkMode.update(calculateDarkMode());
  export const darkMode: LiveData.Readable<boolean> = _darkMode;

  function calculateDarkMode(): boolean {
    const theme = localStorage.getItem("theme");
    if (theme) {
      return theme === "dark";
    } else if (!globalThis.matchMedia) {
      return false;
    } else if (globalThis.matchMedia("(prefers-color-scheme: dark)").matches) {
      return true;
    }
    return false;
  }

  export function isDarkMode(): boolean {
    return _darkMode.get();
  }

  export function toggle(force: Option<boolean> = !isDarkMode(), save = true) {
    Tracing.info("ui")("darkmode/toggle/", force);

    if (typeof document !== "undefined" && document.documentElement?.toggleAttribute) {
      document.documentElement.toggleAttribute("transitioning-theme", true);
    }
    if (save) {
      Tracing.dbg(localStorage.getItem("theme"));
      if (force == null) {
        localStorage.removeItem("theme");
      } else if (force) {
        localStorage.setItem("theme", "dark");
      } else {
        localStorage.setItem("theme", "light");
      }
      Tracing.dbg(localStorage.getItem("theme"));
    }
    _darkMode.update(force ?? false);
    setTimeout(() => {
      if (typeof document !== "undefined" && document.documentElement?.toggleAttribute) {
        document.documentElement.toggleAttribute("transitioning-theme", false);
      }
    }, 100);
  }
}
