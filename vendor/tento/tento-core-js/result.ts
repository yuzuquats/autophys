import { Constants } from "./constants";
import { TaggedEnum } from "./tagged-enum";

export namespace Result {
  export type Enum<T = any, E = any> = {
    ok: T;
    err: E;
  };
  export type Serialized<T = any, E = any> = TaggedEnum<Enum<T, E>>;
}

export class Result<T = any, E = any> extends TaggedEnum.Base<
  Result.Enum<T, E>
> {
  static from(ser: Result.Serialized): Result {
    return new Result(ser);
  }

  static ok<T, E = any>(o: T): Result<T, E> {
    return new Result({
      type: "ok",
      ok: o,
    });
  }

  static err<E, T = any>(e: E): Result<T, E> {
    return new Result({
      type: "err",
      err: e,
    });
  }

  // Extracting contained values
  //
  // https://doc.rust-lang.org/std/result/#extracting-contained-values
  expect(message?: string): T {
    return this.match({
      ok: Constants.IDENTITY_FUNC,
      err: () => {
        throw new Error(message);
      },
    });
  }
  unwrapOrDefault(defaul: T) {
    return this.match({
      ok: Constants.IDENTITY_FUNC,
      err: () => defaul,
    });
  }
  unwrapOrElse(fn: (e: E) => T): T {
    return this.match({
      ok: Constants.IDENTITY_FUNC,
      err: fn,
    });
  }

  // Transforming contained values
  //
  // Result <-> Option
  err(): Option<E> {
    return this.match({
      ok: () => null,
      err: Constants.IDENTITY_FUNC,
    });
  }
  ok(): Option<T> {
    return this.match({
      ok: Constants.IDENTITY_FUNC,
      err: () => null,
    });
  }

  isOk(): boolean {
    return this.internal.type === "ok";
  }

  // Map
  map<N>(fn: (o: T) => N): Result<N, E> {
    return this.match({
      ok: (o) => Result.ok(fn(o)),
      err: (e) => Result.err(e),
    });
  }
  mapErr<N>(fn: (o: E) => N): Result<T, N> {
    return this.match({
      ok: (o) => Result.ok(o),
      err: (e) => Result.err(fn(e)),
    });
  }
  // map_or() {}
  // map_or_else() {}
}
