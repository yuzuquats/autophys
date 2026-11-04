import { nonnull } from "@tento-core/assert";

export class LazySync<T> {
  init: () => T;
  private resolved: Option<T> = null;
  hasResolved: boolean = false;

  constructor(init: () => T) {
    this.init = init;
  }

  maybeGet(): Option<T> {
    return this.resolved;
  }

  get(): T {
    if (!this.hasResolved) {
      if (this.idleCallback) cancelIdleCallback(this.idleCallback);
      this.resolved = this.init();
      this.hasResolved = true;
    }
    return nonnull(this.resolved);
  }

  private idleCallback: Option<number>;
  loadOnIdle() {
    if (this.hasResolved) return;
    this.idleCallback = requestIdleCallback(() => {
      this.idleCallback = null;
      this.get();
    });
  }
}
