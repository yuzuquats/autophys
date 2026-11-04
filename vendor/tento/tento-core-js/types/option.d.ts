declare type Option<T> = null | T | undefined;

declare type Optional<T> = Partial<
  {
    [K in keyof T]: Option<T[K]>;
  }
>;
