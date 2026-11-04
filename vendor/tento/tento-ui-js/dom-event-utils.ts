import { Session } from "./session";

export namespace DomEventUtils {
  export const STOP_PROPAGATION = (e: Event) => e.stopPropagation();
  export const STOP_PROPAGATION_NO_ENTER_KEY = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
    e.stopPropagation();
  };
  export const STOP_PROPAGATION_BLUR_ON_ENTER =
    (fn: () => void) => (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        fn();
      }
      e.stopPropagation();
    };

  export function shouldIgnoreKeyEvents(e: KeyboardEvent) {
    return (
      (!Session.isWindows && e.ctrlKey) ||
      (Session.isWindows && e.altKey) ||
      (!Session.isWindows && e.metaKey && (e.key === "k" || e.key === "Space"))
    );
  }
}
