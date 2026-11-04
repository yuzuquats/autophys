import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";

// A key combination the reader can hear. The eye gets the glyph — ⌘ ⇧ ↩ — and
// the accessible name gets the word, because "Command" is a key and "⌘" is a
// character a screen reader may read as "place of interest sign" or skip.
//
// The builtin `Kbd.make()` is a bare `<kbd>`; the sidebar's expand button
// hand-rolled one. This is the component: one `<kbd>` per key, joined by a
// separator, the whole thing labelled once.
@component({ name: "std-kbd" })
export class Kbd extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  bind(props: Kbd.Props): this {
    DomUtils.clearChildren(this.$root);
    const platform = Kbd.resolvePlatform(props.platform ?? "auto");
    const names: string[] = [];
    props.keys.forEach((key, i) => {
      const { glyph, name } = Kbd.render(key, platform);
      names.push(name);
      if (i > 0) {
        const $sep = document.createElement("span");
        $sep.className = "sep";
        $sep.setAttribute("aria-hidden", "true");
        $sep.textContent = "+";
        this.$root.appendChild($sep);
      }
      const $k = document.createElement("kbd");
      $k.textContent = glyph;
      $k.setAttribute("aria-hidden", "true");
      this.$root.appendChild($k);
    });
    // One name for the whole combination, on the host, so the reader hears
    // "Command Shift P" rather than three separate one-character nodes.
    this.setAttribute("role", "img");
    this.setAttribute("aria-label", names.join(" "));
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$root);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: Kbd.Props): Kbd {
    return Kbd.make().bind(props);
  }

  static resolvePlatform(p: Kbd.Platform): "mac" | "win" {
    if (p !== "auto") return p;
    return /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "win";
  }

  /** The glyph the eye gets and the word the reader gets, per platform. */
  static render(key: string, platform: "mac" | "win"): { glyph: string; name: string } {
    const k = key.trim().toLowerCase();
    const table: Record<string, [string, string, string, string]> = {
      // key: [mac glyph, mac name, win glyph, win name]
      cmd: ["⌘", "Command", "Ctrl", "Control"],
      meta: ["⌘", "Command", "Win", "Windows"],
      ctrl: ["⌃", "Control", "Ctrl", "Control"],
      alt: ["⌥", "Option", "Alt", "Alt"],
      option: ["⌥", "Option", "Alt", "Alt"],
      shift: ["⇧", "Shift", "Shift", "Shift"],
      enter: ["↩", "Enter", "Enter", "Enter"],
      return: ["↩", "Return", "Enter", "Enter"],
      esc: ["⎋", "Escape", "Esc", "Escape"],
      escape: ["⎋", "Escape", "Esc", "Escape"],
      tab: ["⇥", "Tab", "Tab", "Tab"],
      backspace: ["⌫", "Backspace", "Backspace", "Backspace"],
      delete: ["⌦", "Delete", "Del", "Delete"],
      space: ["␣", "Space", "Space", "Space"],
      up: ["↑", "Up arrow", "↑", "Up arrow"],
      down: ["↓", "Down arrow", "↓", "Down arrow"],
      left: ["←", "Left arrow", "←", "Left arrow"],
      right: ["→", "Right arrow", "→", "Right arrow"],
    };
    const row = table[k];
    if (row) {
      return platform === "mac"
        ? { glyph: row[0], name: row[1] }
        : { glyph: row[2], name: row[3] };
    }
    const single = key.length === 1 ? key.toUpperCase() : key;
    return { glyph: single, name: single };
  }

  static $styles = [
    css(`
      :host {
        --kbd-bg: var(--kbd-bg-preset, var(--bg-surface-light));
        --kbd-border: var(--kbd-border-preset, var(--divider));
        --kbd-color: var(--kbd-color-preset, var(--text-sec));
        --kbd-size: var(--small-size);
        --kbd-radius: 4px;

        display: inline-flex;
        align-items: center;
        gap: 3px;
        max-width: max-content;
        vertical-align: middle;
      }

      kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.6em;
        height: 1.6em;
        padding-inline: 0.4em;
        border: 1px solid var(--kbd-border);
        border-bottom-width: 2px;
        border-radius: var(--kbd-radius);
        background: var(--kbd-bg);
        color: var(--kbd-color);
        font-family: ${Typography.MONO_STACK};
        font-size: var(--kbd-size);
        line-height: 1;
      }

      .sep {
        color: var(--kbd-color);
        font-size: var(--kbd-size);
        opacity: 0.7;
      }
    `),
  ];

  static $html = html`<span id="root"></span>`;
}

export namespace Kbd {
  export type Platform = "mac" | "win" | "auto";
  export type Props = {
    /** Key names, in order: "cmd", "shift", "p". Single characters are shown as typed. */
    keys: string[];
    /** Which glyph set to draw; `auto` sniffs the platform. */
    platform: Option<Platform>;
  };
}
