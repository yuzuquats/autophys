import { ChangesetKey } from "./changeset-key";

export class LiveData<T>
  implements LiveData.Readable<T>, LiveData.Writeable<T>
{
  private listeners: Map<
    any,
    (t: T, prev: Option<T>, key?: Option<ChangesetKey>) => void
  > = new Map();

  constructor(
    private inner: T,
    private readonly options?: LiveData.Options,
  ) {}

  static new<T>(t: T): LiveData<T> {
    return new LiveData(t);
  }

  updateSilently(t: T) {
    this.inner = t;
  }

  update(t: T, key: Option<ChangesetKey> = null) {
    if (this.options?.ignoreIfEqual && t === this.inner) return;
    const prev = this.inner;
    this.inner = t;
    for (const cb of this.listeners.values()) {
      cb(this.inner, prev, key);
    }
  }

  get(): T {
    return this.inner;
  }

  addListener(
    target: any,
    cb: (t: T, prev?: Option<T>) => void,
    t: Option<LiveData.TriggerImmediately> = null,
  ) {
    this.listeners.set(target, cb);
    t && cb(this.inner);
  }

  removeListener(target: any) {
    this.listeners.delete(target);
  }
}

export namespace LiveData {
  export const TriggerImmediately = Symbol();
  export type TriggerImmediately = typeof TriggerImmediately;

  export type Options = Optional<{
    ignoreIfEqual: boolean;
  }>;

  export interface Readable<T> {
    get(): T;
    addListener(
      target: any,
      cb: (t: T, prev: Option<T>, key?: Option<ChangesetKey>) => void,
      t?: Option<LiveData.TriggerImmediately>,
    ): void;
    removeListener(target: any): void;
  }

  export interface Writeable<T> {
    update(t: T): void;
  }

  export type Flag = LiveData<boolean>;
  export namespace Flag {
    export type Readable = LiveData.Readable<boolean>;
    export const NEVER: Flag.Readable = new LiveData(false);
  }
}
