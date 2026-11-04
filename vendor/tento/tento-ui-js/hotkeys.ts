import { DomUtils } from "./dom";

type KnownKeys = "ArrowLeft" | "ArrowRight";
export type HotkeyIdentifier = KnownKeys | string;

/**
 * Maps
 *
 *    shift-[KeyboardEvent.key]
 *    ctrl-[KeyboardEvent.key]
 *    cmd-[KeyboardEvent.key]
 *    [KeyboardEvent.key]
 *
 * to Functions
 */
export namespace Hotkeys {
  let hotkeys: Option<Map<HotkeyIdentifier, EmptyFunction>>;
  let escapeHandler: {
    id: any;
    callback: EmptyFunction;
  }[] = [];
  let _allowedHotkeysInEditor: Option<Set<HotkeyIdentifier>>;

  export function init(
    initialHotkeys: [HotkeyIdentifier, EmptyFunction][],
    allowedHotkeysInEditor: HotkeyIdentifier[] = [],
  ) {
    hotkeys = new Map([["Escape", onEscape], ...initialHotkeys]);
    _allowedHotkeysInEditor = new Set(allowedHotkeysInEditor);
    document.onkeydown = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.dispatchHotkey(hotkey)) {
        e.preventDefault();
      }
    };
  }

  export function dispatchHotkey(hotkey: string): boolean {
    const cb = hotkeys!.get(hotkey);
    if (cb) {
      cb();
      return true;
    }
    return false;
  }

  export function getHotkey(hotkey: string): Option<EmptyFunction> {
    return hotkeys!.get(hotkey);
  }

  function onEscape() {
    const handler = escapeHandler.pop();
    if (!handler) return;
    handler.callback();
  }

  export function pushEscapeHandler(id: any, callback: EmptyFunction) {
    escapeHandler.push({
      id,
      callback,
    });
  }

  export function clearEscapeHandler(id: any) {
    escapeHandler = escapeHandler.filter(
      ({ id: currentId }) => currentId !== id,
    );
  }

  export function allowedHotkeyInEditor(hotkey: HotkeyIdentifier): boolean {
    return _allowedHotkeysInEditor?.has(hotkey) ?? false;
  }

  const preventDefaultBlacklist = new Set(["Tab", "cmd-s"]);
  export function shouldPreventDefault(hotkey: string): boolean {
    return preventDefaultBlacklist.has(hotkey);
  }
}
