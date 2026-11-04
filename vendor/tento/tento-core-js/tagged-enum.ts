export type TaggedEnum<Enums> =
  & {
    type: keyof Enums;
  }
  & {
    [T in keyof Enums]?: Option<Enums[T]>;
  };

/*
Kindof similar to an [externally tagged enum](https://serde.rs/enum-representations.html)
in other languages. Type system might be a bit jank.

Usage:

  Type representation:
  ```
  type AnimalEnum = {
    dog: {
      name: string
    };
    fish: {
      numberOfFins: number
    };
  }
  type AnimalItem = TaggedEnum<AnimalEnum>;
  ```

  Serialized representation:
  ```
  const myDog: AnimalItem = {
    type: "dog",
    dog: {
      name: "spot"
    },
  }
  ```

  Matching:
  ```
  const sayHello = TaggedEnum.match<AnimalEnum, string>(myDog, {
    dog: (d: { name: string }) => {
      return `hello ${name}`;
    },
    fish: () => {
      return "i'm food";
    }
  });

  assert(sayHello, "hello spot");
  ```
 */
export namespace TaggedEnum {
  export type MatcherFn<E, R> = {
    [T in keyof E]: (e: Exclude<E[T], null | undefined>) => R;
  };
  export type MatcherFnOpt<E, R> = {
    [T in keyof E]?: (e: Exclude<E[T], null | undefined>) => R;
  };
  export type Matcher<E, R> = (e: TaggedEnum<E>, matcher: MatcherFn<E, R>) => R;
  export function match<E, R>(e: TaggedEnum<E>, matcher: MatcherFn<E, R>): R {
    /**
     * not smart enough to follow the compiler logic - pretty sure typescript
     * can't infer this?
     */
    // @ts-ignore
    const inner: Exclude<E[keyof E], null | undefined> = e[e["type"]];
    /**
     * runtime nullable check since there's no way for the compiler to
     * enforce this
     */
    const fn = matcher[e["type"]];
    return matcher[e["type"]](inner);
  }

  export function matchOpt<E, R>(
    e: TaggedEnum<E>,
    matcher: MatcherFnOpt<E, R>,
  ): Option<R> {
    /**
     * not smart enough to follow the compiler logic - pretty sure typescript
     * can't infer this?
     */
    // @ts-ignore
    const inner: Exclude<E[keyof E], null | undefined> = e[e["type"]];
    /**
     * runtime nullable check since there's no way for the compiler to
     * enforce this
     */
    const fn = matcher[e["type"]];
    if (!fn) return null;
    return fn(inner);
  }

  export class Base<I> {
    internal: TaggedEnum<I>;

    constructor(i: TaggedEnum<I>) {
      this.internal = i;
    }

    valueOf(): TaggedEnum<I> {
      return this.internal;
    }

    // variant(): Exclude<TaggedEnum<I>[keyof E], null | undefined> {
    //   const e = this.internal;
    //   /**
    //    * not smart enough to follow the compiler logic - pretty sure typescript
    //    * can't infer this?
    //    */
    //   // @ts-ignore
    //   const inner: Exclude<E[keyof E], null | undefined> = e[e["type"]];
    //   return inner;
    // }

    match<R>(matcher: TaggedEnum.MatcherFn<I, R>): R {
      return TaggedEnum.match(this.internal, matcher);
    }

    matchOpt<R>(matcher: TaggedEnum.MatcherFnOpt<I, R>): Option<R> {
      return TaggedEnum.matchOpt(this.internal, matcher);
    }
  }
}
