import { DateTime, Duration, Utc } from "@tento-chrono";

export class Timer {
  private id: Option<string>;
  private duration: Duration.Time;
  private countdownDuration: Option<Duration.Time>;
  private startTime: Option<DateTime<Utc>>;
  private simpleState: Timer.SimpleState = "not-started";
  private intervalId: Option<number>;
  private listeners: Set<Timer.Listener> = new Set();

  constructor(duration: Duration.Time, id?: string) {
    this.duration = duration;
    this.id = id;
  }

  static make(duration: Duration.Time, id?: string): Timer {
    return new Timer(duration, id);
  }

  static fromState(state: Timer.State.Running | Timer.State.Paused): Timer {
    const timer = new Timer(state.initialDuration);
    timer.id = state.id;
    timer.startTime = state.startTime;

    if (state.state === "running") {
      const now = DateTime.utc.now();
      const remainingMs = state.endTime.mse - now.mse;
      if (remainingMs > 0) {
        timer.countdownDuration = Duration.Time.rounded(remainingMs);
        timer.simpleState = "running";
        timer.startInterval();
      } else {
        timer.countdownDuration = Duration.Time.rounded(0);
        timer.simpleState = "finished";
      }
    } else {
      timer.countdownDuration = state.remainingTime;
      timer.simpleState = "paused";
    }

    return timer;
  }

  subscribe(listener: Timer.Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.simpleState === "running" || this.simpleState === "finished") return;

    if (!this.countdownDuration) {
      this.countdownDuration = this.duration;
    }
    if (!this.startTime) {
      this.startTime = DateTime.utc.now();
    }
    if (!this.id) {
      this.id = crypto.randomUUID();
    }

    this.simpleState = "running";
    this.emitState();
    this.startInterval();
  }

  pause(): void {
    if (this.simpleState !== "running") return;

    this.clearInterval();
    this.simpleState = "paused";
    this.emitState();
  }

  reset(): void {
    this.clearInterval();
    this.id = undefined;
    this.countdownDuration = undefined;
    this.startTime = undefined;
    this.simpleState = "not-started";
    this.emitState();
  }

  setDuration(duration: Duration.Time): void {
    this.duration = duration;
    if (this.simpleState === "not-started") {
      this.countdownDuration = undefined;
    }
  }

  setRemainingTime(remaining: Duration.Time): void {
    this.countdownDuration = remaining;
    this.notifyTick(remaining);
  }

  getState(): Timer.State {
    return this.buildState();
  }

  getSimpleState(): Timer.SimpleState {
    return this.simpleState;
  }

  getRemainingTime(): Option<Duration.Time> {
    return this.countdownDuration ?? this.duration;
  }

  getDuration(): Duration.Time {
    return this.duration;
  }

  getId(): Option<string> {
    return this.id;
  }

  private buildState(): Timer.State {
    const base = {
      id: this.id,
      initialDuration: this.duration,
      startTime: this.startTime,
    };

    switch (this.simpleState) {
      case "not-started":
        return { ...base, state: "not-started" };
      case "running": {
        const remaining = this.countdownDuration ?? this.duration;
        return {
          ...base,
          state: "running",
          endTime: DateTime.utc.now().add({ ms: remaining.toMs }),
        };
      }
      case "paused":
        return {
          ...base,
          state: "paused",
          remainingTime: this.countdownDuration ?? this.duration,
        };
      case "finished":
        return {
          ...base,
          state: "finished",
          endTime: DateTime.utc.now(),
        };
    }
  }

  private emitState(): void {
    const state = this.buildState();
    for (const listener of this.listeners) {
      listener.onStateChange?.(state);
    }
  }

  private notifyTick(remaining: Duration.Time): void {
    for (const listener of this.listeners) {
      listener.onTick?.(remaining);
    }
  }

  private startInterval(): void {
    this.clearInterval();
    this.intervalId = window.setInterval(() => {
      if (!this.countdownDuration) return;

      const newMs = this.countdownDuration.toMs - 1000;
      if (newMs <= 0) {
        this.countdownDuration = Duration.Time.rounded(0);
        this.notifyTick(this.countdownDuration);
        this.clearInterval();
        this.simpleState = "finished";
        this.emitState();
      } else {
        this.countdownDuration = Duration.Time.rounded(newMs);
        this.notifyTick(this.countdownDuration);
      }
    }, 1000);
  }

  private clearInterval(): void {
    if (this.intervalId != null) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

export namespace Timer {
  export type SimpleState = "not-started" | "running" | "paused" | "finished";

  export type State = State.NotStarted | State.Running | State.Paused | State.Finished;

  export namespace State {
    type Base = {
      id: Option<string>;
      initialDuration: Duration.Time;
      startTime: Option<DateTime<Utc>>;
    };

    export type NotStarted = Base & {
      state: "not-started";
    };

    export type Running = Base & {
      state: "running";
      endTime: DateTime<Utc>;
    };

    export type Paused = Base & {
      state: "paused";
      remainingTime: Duration.Time;
    };

    export type Finished = Base & {
      state: "finished";
      endTime: DateTime<Utc>;
    };
  }

  export interface Listener {
    onTick?(remaining: Duration.Time): void;
    onStateChange?(state: State): void;
  }
}
