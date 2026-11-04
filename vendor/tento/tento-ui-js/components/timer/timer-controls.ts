import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Button } from "../button/button";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Timer } from "./timer";

@component({
  name: "std-timer-controls",
})
export class TimerControls extends LonaWebComponent {
  private $startBtn: HTMLButtonElement = this.hydrate("start-btn");
  private $resetBtn: HTMLButtonElement = this.hydrate("reset-btn");
  private $container: HTMLElement = this.hydrate("container");

  private timer: Option<Timer>;
  private unsubscribe: Option<() => void>;

  constructor() {
    super();

    GESTURE_MANAGER.addPointerEvent(this.$startBtn, {
      onClick: () => this.handleStartPauseClick(),
    });

    GESTURE_MANAGER.addPointerEvent(this.$resetBtn, {
      onClick: () => this.handleResetClick(),
    });
  }

  bindTimer(timer: Timer): TimerControls {
    this.unsubscribe?.();

    this.timer = timer;

    this.unsubscribe = timer.subscribe({
      onStateChange: (state) => {
        this.updateButtonState(state.state);
      },
    });

    this.updateButtonState(timer.getSimpleState());
    return this;
  }

  private handleStartPauseClick(): void {
    if (!this.timer) return;

    const state = this.timer.getSimpleState();
    if (state === "running") {
      this.timer.pause();
    } else {
      this.timer.start();
    }
  }

  private handleResetClick(): void {
    if (!this.timer) return;
    this.timer.reset();
  }

  private updateButtonState(state: Timer.SimpleState): void {
    const showReset = state !== "not-started";

    if (state === "running") {
      this.$startBtn.textContent = "Pause";
    } else {
      this.$startBtn.textContent = "Start";
    }

    if (showReset) {
      this.$resetBtn.style.display = "flex";
      this.$container.classList.add("split-buttons");
    } else {
      this.$resetBtn.style.display = "none";
      this.$container.classList.remove("split-buttons");
    }
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
      }

      #container {
        display: flex;
        gap: 4px;
      }

      #container.split-buttons #start-btn {
        flex: 1;
      }

      #start-btn {
        padding: 12px 24px;
        width: 100%;
      }

      #reset-btn {
        padding: 10px;
        width: 44px;
        min-width: 44px;
        display: none;
        align-items: center;
        justify-content: center;
        position: relative;
      }

      #reset-btn svg {
        width: 18px;
        height: 18px;
      }

      #start-btn:focus-visible,
      #reset-btn:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #reset-btn:hover::after,
      #reset-btn:focus-visible::after {
        content: attr(tooltip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        background: #222;
        color: white;
        padding: 4px 12px;
        border-radius: 5px;
        font-size: 0.775rem;
        white-space: nowrap;
        pointer-events: none;
        z-index: 100;
      }
    `,
  ];

  static $html = html`
    <div id="container">
      <button id="reset-btn" primary tooltip="Reset" aria-label="Reset timer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
      </button>
      <button id="start-btn" primary>Start</button>
    </div>
  `;
}
