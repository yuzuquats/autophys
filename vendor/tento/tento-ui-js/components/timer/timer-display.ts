import { Duration } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { component } from "../../component-decorators";
import { Typography } from "../../ui/typography";
import { css } from "../../component-styles";
import { Timer } from "./timer";

@component({
  name: "std-timer-display",
})
export class TimerDisplay extends LonaWebComponent {
  $cursor = this.$("cursor");

  // @callbacks
  private onPendingDurationChange?: (duration: Option<Duration.Time>) => void;
  private onDurationChange?: (duration: Duration.Time) => void;

  // @state
  private timer: Option<Timer>;
  private unsubscribe: Option<() => void>;
  private pendingDuration: Option<Duration.Time>;
  private editing = false;

  constructor() {
    super();

    GESTURE_MANAGER.addPointerEvent(this.$("label"), {
      onClick: this.callbacks.onClick,
    });
    // Host-bound: the host survives recycling, so these are installed once and
    // never removed. See the note in text-input.ts.
    this.addEventListener("keydown", this.callbacks.keydown);
    this.addEventListener("keyup", this.callbacks.keyup);
    this.addEventListener("blur", this.callbacks.blur);
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  static makeWith(props: TimerDisplay.Props): TimerDisplay {
    return TimerDisplay.make().bind(props);
  }

  bind(props: TimerDisplay.Props): TimerDisplay {
    this.onDurationChange = props.onDurationChange;
    this.onPendingDurationChange = props.onPendingDurationChange;
    return this;
  }

  bindTimer(timer: Timer): TimerDisplay {
    // Unsubscribe from previous timer
    this.unsubscribe?.();

    this.timer = timer;
    this.unsubscribe = timer.subscribe({
      onTick: () => this.updateDisplay(),
      onStateChange: (state) => {
        this.setAttribute("timer-state", state.state);
        this.updateDisplay();
      },
    });

    // Initial render
    this.setAttribute("timer-state", timer.getState().state);
    this.updateDisplay();

    return this;
  }

  enterEditing(): void {
    if (this.editing) return;
    if (!this.timer) return;

    this.editing = true;
    this.pendingDuration = this.timer.getDuration();
    this.tabIndex = 0;
    this.focus();
    this.setAttribute("timer-state", "editing");
    this.updateDisplay();
  }

  exitEditing(commit: boolean): void {
    if (!this.editing) return;

    if (commit && this.pendingDuration && this.pendingDuration.toMs > 0) {
      this.timer?.setDuration(this.pendingDuration);
      this.onDurationChange?.(this.pendingDuration);
    }

    this.editing = false;
    this.pendingDuration = undefined;
    this.tabIndex = -1;
    this.blur();

    if (this.timer) {
      this.setAttribute("timer-state", this.timer.getState().state);
    }
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const isEditing = this.editing;
    this.bindLabel(isEditing);
    this.bindCursor(isEditing);
  }

  private bindLabel(editing: boolean): void {
    if (!this.timer) return;

    if (editing && this.pendingDuration) {
      this.$("label").textContent = TimerDisplay.formatEditValue(
        this.pendingDuration,
      );
    } else {
      const remaining = this.timer.getRemainingTime();
      if (remaining) {
        this.$("label").textContent = TimerDisplay.formatDisplayTime(remaining);
      }
    }
  }

  private bindCursor(revealed: boolean) {
    const $cursor = this.$("cursor");
    if (!revealed) {
      $cursor.style.display = "none";
      return;
    }
    $cursor.style.display = "";

    const $label = this.$("label");

    // Create a temporary span to measure text width
    const $tempSpan = document.createElement("span");
    $tempSpan.style.visibility = "hidden";
    $tempSpan.style.position = "absolute";
    $tempSpan.style.whiteSpace = "nowrap";
    $tempSpan.style.font = window.getComputedStyle($label).font;
    $tempSpan.textContent = $label.textContent || "";

    this.shadowRoot?.appendChild($tempSpan);
    const textWidth = $tempSpan.getBoundingClientRect().width;
    $tempSpan.remove();

    // Get label position and dimensions
    const labelStyle = window.getComputedStyle($label);
    const paddingLeft = Number.parseFloat(labelStyle.paddingLeft);

    // Position cursor at the end of the text
    $cursor.style.left = paddingLeft + textWidth + 2 + "px";
  }

  private callbacks = ((self) => ({
    keydown: (e: KeyboardEvent) => {
      if (!self.editing) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Enter") {
        self.exitEditing(true);
        return;
      }

      if (e.key === "Escape") {
        self.exitEditing(false);
        return;
      }

      if (e.key === "Backspace") {
        if (self.pendingDuration) {
          const digits = TimerDisplay.durationToDigits(self.pendingDuration);
          if (digits.length > 0) {
            const newDigits = digits.slice(0, -1);
            self.pendingDuration = TimerDisplay.parseEditDigits(newDigits);
            self.onPendingDurationChange?.(self.pendingDuration);
            self.updateDisplay();
          }
        }
        return;
      }

      if (/^\d$/.test(e.key)) {
        const digits = self.pendingDuration
          ? TimerDisplay.durationToDigits(self.pendingDuration)
          : "";
        if (digits.length < 6) {
          const newDigits = digits + e.key;
          self.pendingDuration = TimerDisplay.parseEditDigits(newDigits);
          self.onPendingDurationChange?.(self.pendingDuration);
          self.updateDisplay();
        }
        return;
      }
    },
    keyup: (e: KeyboardEvent) => {
      e.stopPropagation();
    },
    blur: () => {
      if (self.editing) {
        self.exitEditing(true);
      }
    },
    onClick: () => {
      if (!self.timer) return;
      const state = self.timer.getState().state;
      if (state === "not-started" || state === "finished") {
        self.enterEditing();
      } else if (self.editing) {
        self.exitEditing(true);
      }
    },
  }))(this);

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: inline-block;
        position: relative;
      }

      #label {
        --font-size: var(--timer-font-size, 2rem);
        color: var(--timer-color, var(--text-pri));
        font-weight: 600;
        cursor: pointer;
        padding: 8px;
        border-radius: 8px;
        transition: background-color 0.2s ease;
        user-select: none;
        position: relative;
        z-index: 10;
      }

      :host([timer-state="running"]) #label,
      :host([timer-state="paused"]) #label {
        cursor: default;
      }

      :host([timer-state="editing"]) #label {
        outline: 3px solid var(--timer-color, var(--text-pri));
        outline-offset: 2px;
      }

      :host(:focus) {
        outline: none;
      }

      #cursor {
        position: absolute;
        width: 3px;
        background-color: var(--timer-color, var(--text-pri));
        animation: blink 1s infinite;
        pointer-events: none;
        top: 0px;
        height: 100%;
      }

      @keyframes blink {
        0%, 50% {
          opacity: 1;
        }
        51%, 100% {
          opacity: 0;
        }
      }
    `,
  ];

  static $html = html`
    <p id="label">25:00</p>
    <div id=cursor></div>
  `;
}

export namespace TimerDisplay {
  export type Props = {
    onPendingDurationChange?: (duration: Option<Duration.Time>) => void;
    onDurationChange?: (duration: Duration.Time) => void;
  };

  export function durationToDigits(d: Duration.Time): string {
    const totalSecs = Math.floor(d.toMs / 1000);
    const minutes = Math.floor(totalSecs / 60);
    const seconds = totalSecs % 60;
    return `${minutes.toString().padStart(2, "0")}${seconds.toString().padStart(2, "0")}`;
  }

  export function parseEditDigits(digits: string): Option<Duration.Time> {
    if (digits.length === 0) return undefined;

    const padded = digits.padStart(4, "0");
    const lastFour = padded.slice(-4);
    const minutes = Number.parseInt(lastFour.slice(0, 2), 10);
    const seconds = Number.parseInt(lastFour.slice(2, 4), 10);

    const totalSeconds = minutes * 60 + seconds;
    return Duration.Time.secs(totalSeconds);
  }

  export function formatEditValue(d: Duration.Time): string {
    const totalSecs = Math.floor(d.toMs / 1000);
    const minutes = Math.floor(totalSecs / 60);
    const seconds = totalSecs % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  export function formatDisplayTime(d: Duration.Time): string {
    const totalSeconds = Math.ceil(d.toMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
}
