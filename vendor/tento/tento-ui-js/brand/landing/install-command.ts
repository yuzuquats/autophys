import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";

/** How long the button reads "Copied" before returning to "Copy". */
const COPIED_FEEDBACK_MS = 1600;

/**
 * The install one-liner, as the product visual.
 *
 * A CLI has no screenshot worth showing; the command *is* the thing being
 * offered, so it gets the weight a hero image would carry — full width, mono
 * face, and a copy affordance rather than an invitation to retype it.
 */
@component({ name: "std-install-command" })
export class InstallCommand extends LonaWebComponent {
  private $command: HTMLElement = this.$("command");
  private $copy: HTMLElement = this.$("copy");
  private $copyLabel: HTMLElement = this.$("copy-label");
  private command: string = "";
  private resetHandle: Option<number> = null;

  static makeWith(props: InstallCommand.Props): InstallCommand {
    return (InstallCommand.make() as InstallCommand).bind(props);
  }

  bind(props: InstallCommand.Props): this {
    this.command = props.command;
    this.$command.textContent = props.command;
    this.rest();
    this.$copy.setAttribute("aria-label", `Copy: ${props.command}`);
    GESTURE_MANAGER.addPointerEvent(this.$copy, { onClick: () => this.copy() });
    return this;
  }

  override onRecycle(): void {
    super.onRecycle();
    this.rest();
    this.command = "";
    this.$command.textContent = "";
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // A pending timer would otherwise fire against a recycled instance and
    // relabel whatever command it is showing by then.
    this.clearReset();
  }

  private clearReset(): void {
    if (this.resetHandle !== null) {
      window.clearTimeout(this.resetHandle);
      this.resetHandle = null;
    }
  }

  private copy(): void {
    const command = this.command;
    if (command.length === 0) return;
    // `navigator.clipboard` is absent on insecure origins, so that path is
    // reachable in local development rather than theoretical — and it needs an
    // explicit guard: `navigator.clipboard?.writeText(...)` would short-circuit
    // the whole chain, neither callback would run, and the button would
    // silently do nothing, which is the exact failure the fallback exists to
    // avoid.
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      this.selectCommand();
      return;
    }
    clipboard.writeText(command).then(
      () => this.settle("Copied", true),
      (error) => {
        Tracing.warn("ui")("install-command: clipboard write failed", {
          error: String(error),
        });
        this.selectCommand();
      },
    );
  }

  /**
   * No clipboard, or a denied write: do the half we still can — select the
   * whole command, so the reader's next keystroke is the copy.
   *
   * The selection is the feedback, and the button keeps saying "Copy". A label
   * that renames itself to describe the fallback asks the reader to absorb a
   * state they never chose and cannot act on differently; the highlighted
   * command already tells them what happened, in the place they are looking.
   */
  private selectCommand(): void {
    // Only reachable where the whole clipboard API is missing or refused, so
    // there is no further fallback to reach for — the log is the record.
    const selection = window.getSelection();
    if (selection === null) {
      Tracing.warn("ui")("install-command: no selection API; copy unavailable");
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(this.$command);
    selection.removeAllRanges();
    selection.addRange(range);
    // A "Copied" still showing from a previous click would now be a lie.
    this.rest();
  }

  private settle(label: string, copied: boolean): void {
    this.clearReset();
    if (copied) this.setAttribute("copied", "");
    this.$copyLabel.textContent = label;
    this.resetHandle = window.setTimeout(() => this.rest(), COPIED_FEEDBACK_MS);
  }

  /** The resting state: the button reads "Copy" and claims nothing. */
  private rest(): void {
    this.clearReset();
    this.removeAttribute("copied");
    this.$copyLabel.textContent = "Copy";
  }

  static $html = html`
    <div id="root">
      <!-- Prompt and command are one flex item so a narrow viewport wraps the
           BUTTON below the line, never the "$" onto a line of its own. -->
      <div id="line">
        <span id="prompt" aria-hidden="true">$</span>
        <code id="command"></code>
      </div>
      <button id="copy" type="button" tabindex="0">
        <span id="copy-label"></span>
      </button>
    </div>
  `;

  // The call form, not the tagged form: `css` as a tag drops interpolations,
  // which would silently swap MONO_STACK for the browser's generic monospace.
  static $styles = [
    css(/* css */ `
      /* Public knobs live on :host. Declared on #root they would sit below the
         host and beat a caller's value, so the knob would stop working. */
      :host {
        --install-command-font: ${Typography.MONO_STACK};
        --install-command-size: var(--text-14px);
        --install-command-radius: 12px;
        display: block;
        width: 100%;
      }

      #root {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        box-sizing: border-box;
        padding: 14px 14px 14px 18px;
        border: 1px solid var(--divider);
        border-radius: var(--install-command-radius);
        background: color-mix(in srgb, var(--bg) 94%, var(--text-pri) 6%);
        transition: border-color 0.3s ease;
      }

      #root:hover {
        border-color: var(--text-ter);
      }

      #line {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      #prompt {
        flex: 0 0 auto;
        font-family: var(--install-command-font);
        --font-size: var(--install-command-size);
        color: var(--text-ter);
        user-select: none;
      }

      #command {
        flex: 1 1 auto;
        min-width: 0;
        font-family: var(--install-command-font);
        --font-size: var(--install-command-size);
        --line-height-ratio: 1.4;
        color: var(--text-pri);
        /* The command is long and must stay readable at phone widths without
           truncating: the reader may well be copying it by hand. */
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      #copy {
        flex: 0 0 auto;
        align-self: flex-start;
        border: 1px solid var(--divider);
        border-radius: 7px;
        padding: 5px 11px;
        background: var(--bg);
        color: var(--text-sec);
        font-family: inherit;
        font-weight: 500;
        --font-size: var(--text-11px);
        cursor: pointer;
        transition: border-color 0.3s ease, color 0.3s ease;
      }

      #copy:hover {
        border-color: var(--text-ter);
        color: var(--text-pri);
      }

      #copy:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      /* Fixed width so the label swap cannot reflow the command beside it. */
      #copy-label {
        display: inline-block;
        min-width: 46px;
      }

      :host([copied]) #copy {
        border-color: color-mix(in srgb, var(--green) 60%, var(--divider) 40%);
        color: color-mix(in srgb, var(--green) 70%, var(--text-pri) 30%);
      }

      @media (max-width: 520px) {
        #root {
          flex-wrap: wrap;
        }
      }
    `),
  ];
}

export namespace InstallCommand {
  export type Props = {
    command: string;
  };
}
