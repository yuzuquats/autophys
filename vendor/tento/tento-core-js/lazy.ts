import { nonnull } from "./assert";

export type LazyInit<T> = () => Promise<T>;
export class Lazy<T> {
  private lazyInit: LazyInit<T>;
  private resolving: Promise<T> | null = null;
  private resolved: T | null = null;
  hasResolved: boolean = false;

  constructor(lazyInit: LazyInit<T>) {
    this.lazyInit = lazyInit;
  }

  async get(): Promise<T> {
    if (!this.hasResolved) {
      if (!this.resolving) {
        this.resolving = this.lazyInit();
      }
      this.resolved = await this.resolving;
      this.hasResolved = true;
    }
    return this.resolved as T;
  }

  maybeGet(): T | null {
    if (!this.hasResolved) {
      return null;
    }
    return this.resolved;
  }

  assertGet(): T {
    return nonnull(this.maybeGet());
  }
}

export const LAZY_NULL = new Lazy(async () => null);
