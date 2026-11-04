/** A value that may be absent: `null` or `undefined`. */
export type Option<T> = T | null | undefined;

/** `T` with every field optional and nullable. */
export type Optional<T> = Partial<{ [K in keyof T]: Option<T[K]> }>;
