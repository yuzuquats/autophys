import type { Option } from "./option.ts";

export class Result<T, E = Error> {
  get isErr(): boolean {
    return !this.isOk;
  }

  private constructor(
    private readonly ok: Option<T>,
    private readonly err: Option<E>,
    public readonly isOk: boolean,
  ) {}

  static ok<T, E = Error>(t: T): Result<T, E> {
    return new Result<T, E>(t, null, true);
  }

  static err<T, E = Error>(e: E): Result<T, E> {
    return new Result<T, E>(null, e, false);
  }

  static erm<T>(e: string): Result<T, Error> {
    return Result.err(new Error(e));
  }

  exp(msg?: string): T {
    if (this.isErr) {
      if (msg) throw new Error(`expected an ok value, ${msg}`);
      throw new Error(`expected an ok value, got '${this.err?.toString()}'`);
    }
    return this.ok!;
  }

  expe(msg?: string): E {
    if (this.isOk) {
      if (msg) throw new Error(`expected an err value, ${msg}`);
      throw new Error("expected an err value");
    }
    return this.err!;
  }

  expeCast<T>(): Result<T, E> {
    if (this.isOk) throw new Error("expected an err value");
    return this as unknown as Result<T, E>;
  }

  asErr(): Option<E> {
    if (!this.isOk) return this.err;
    return null;
  }

  asOk(): Option<T> {
    if (this.isOk) return this.ok;
    return null;
  }

  map<TT>(fn: (t: T) => TT): Result<TT, E> {
    if (this.isOk) return Result.ok(fn(this.ok!));
    return this as unknown as Result<TT, E>;
  }

  async asyncMap<TT>(fn: (t: T) => Promise<TT>): Promise<Result<TT, E>> {
    if (this.isOk) return Result.ok(await fn(this.ok!));
    return this as unknown as Result<TT, E>;
  }
}

// export namespace Result {
//   export type Like<T, E = Error> = T | E;

//   export function isErr<T>(r: Result.Like<T>): boolean {
//     return r instanceof Error;
//   }

//   export function isOk<T>(r: Result.Like<T>): boolean {
//     return !(r instanceof Error);
//   }

//   export function unwrap<T>(r: Result.Like<T>): T {
//     if (r instanceof Error) throw r;
//     return r as T;
//   }

//   export function opt<T>(r: Result.Like<T>): Option<T> {
//     if (isOk(r)) return r as T;
//     return null;
//   }
// }

export const erm = Result.erm;
export const ok = Result.ok;
export const err = Result.err;
