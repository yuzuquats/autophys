import type { JsonReader, JsonValue } from "./json-reader";

/**
 * A decoder/encoder for `T` over JSON: `safeHydrate` checks a received JSON
 * value and reports every mismatch as a `Model.Issue`, `hydrate` throws them
 * as a `ModelHydrationError`, and `serialize` writes a `T` back as JSON.
 */
export interface Model<T> {
  hydrate(raw: JsonValue): T;
  safeHydrate(raw: JsonValue): Model.Result<T>;
  serialize(value: T): JsonValue;
}

export interface Field<T> {
  readonly required: boolean;
  safeHydrate(
    raw: Option<JsonValue>,
    path: readonly string[],
    present: boolean,
  ): Model.Result<T>;
  serialize(value: T): Option<JsonValue>;
}

export class ModelHydrationError extends Error {
  constructor(readonly issues: readonly Model.Issue[]) {
    super(
      issues.map((issue) =>
        `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`
      ).join("; "),
    );
    this.name = "ModelHydrationError";
  }
}

export namespace Model {
  export interface Issue {
    readonly path: readonly string[];
    readonly code: string;
    readonly message: string;
  }

  export interface Ok<T> {
    readonly isOk: true;
    readonly value: T;
  }

  export interface Err {
    readonly isOk: false;
    readonly issues: readonly Issue[];
  }

  export type Result<T> = Ok<T> | Err;
  // A field of any value type: the object's `T` ties the fields together.
  export type Fields = Readonly<Record<string, Field<UntypedJson>>>;

  export interface Object<T> extends Model<T> {
    readonly fields: Fields;
  }

  export function ok<T>(value: T): Result<T> {
    return { isOk: true, value };
  }

  export function err(issue: Issue): Err {
    return { isOk: false, issues: [issue] };
  }

  export function issues(issues: readonly Issue[]): Err {
    return { isOk: false, issues };
  }

  export function issue(
    path: readonly string[],
    code: string,
    message: string,
  ): Issue {
    return { path, code, message };
  }

  export function object<T>(fields: Fields): Object<T> {
    return {
      fields,
      hydrate(raw: JsonValue): T {
        const result = this.safeHydrate(raw);
        if (result.isOk) return result.value;
        throw new ModelHydrationError(result.issues);
      },
      safeHydrate(raw: JsonValue): Result<T> {
        if (!isJsonObject(raw)) return err(issue([], "type", "expected object"));

        const source: JsonReader.Object = raw;
        const out: Record<string, UntypedJson> = {};
        const collected: Issue[] = [];

        for (const [name, field] of Object.entries(fields)) {
          const present = Object.prototype.hasOwnProperty.call(source, name);
          const result = field.safeHydrate(source[name], [name], present);
          if (result.isOk) {
            if (field.required || present) out[name] = result.value;
          } else {
            collected.push(...result.issues);
          }
        }

        if (collected.length > 0) return issues(collected);
        return ok(out as T);
      },
      serialize(value: T): JsonValue {
        const source = value as Record<string, UntypedJson>;
        const out: Record<string, JsonValue> = {};
        for (const [name, field] of Object.entries(fields)) {
          const serialized = field.serialize(source[name]);
          // An absent optional key stays absent; `JSON.stringify` drops an
          // `undefined` required value the same way.
          if (serialized !== undefined) out[name] = serialized;
        }
        return out;
      },
    };
  }

  /**
   * Resolves a model when decoding or encoding, after module initialization.
   * Use this for recursive or forward references; the resolver must return an
   * initialized model when an operation is called.
   */
  export function defer<T>(resolve: () => Model<T>): Model<T> {
    return {
      hydrate(raw: JsonValue): T {
        return resolve().hydrate(raw);
      },
      safeHydrate(raw: JsonValue): Result<T> {
        return resolve().safeHydrate(raw);
      },
      serialize(value: T): JsonValue {
        return resolve().serialize(value);
      },
    };
  }

  export function array<T>(item: Model<T>): Model<readonly T[]> {
    return {
      hydrate(raw: JsonValue): readonly T[] {
        const result = this.safeHydrate(raw);
        if (result.isOk) return result.value;
        throw new ModelHydrationError(result.issues);
      },
      safeHydrate(raw: JsonValue): Result<readonly T[]> {
        if (!Array.isArray(raw)) return err(issue([], "type", "expected array"));

        const out: T[] = [];
        const collected: Issue[] = [];
        for (let i = 0; i < raw.length; i++) {
          const result = item.safeHydrate(raw[i]);
          if (result.isOk) {
            out.push(result.value);
          } else {
            for (const nested of result.issues) {
              collected.push({
                ...nested,
                path: [String(i), ...nested.path],
              });
            }
          }
        }

        if (collected.length > 0) return issues(collected);
        return ok(out);
      },
      serialize(value: readonly T[]): JsonValue {
        return value.map((itemValue) => item.serialize(itemValue));
      },
    };
  }

  export function union<T>(models: readonly Model<UntypedJson>[]): Model<T> {
    return {
      hydrate(raw: JsonValue): T {
        const result = this.safeHydrate(raw);
        if (result.isOk) return result.value;
        throw new ModelHydrationError(result.issues);
      },
      safeHydrate(raw: JsonValue): Result<T> {
        const collected: Issue[] = [];
        for (const model of models) {
          const result = model.safeHydrate(raw);
          if (result.isOk) return result;
          collected.push(...result.issues);
        }
        return issues(collected.length > 0 ? collected : [
          issue([], "union", "value did not match any union branch"),
        ]);
      },
      serialize(value: T): JsonValue {
        const first = models[0];
        if (first) return first.serialize(value);
        return asJson(value);
      },
    };
  }

  export function scalar<T>(
    name: string,
    parse: (raw: JsonValue) => T,
    serializeValue: Option<(value: T) => JsonValue>,
  ): Model<T> {
    return {
      hydrate(raw: JsonValue): T {
        const result = this.safeHydrate(raw);
        if (result.isOk) return result.value;
        throw new ModelHydrationError(result.issues);
      },
      safeHydrate(raw: JsonValue): Result<T> {
        try {
          return ok(parse(raw));
        } catch {
          return err(issue([], "type", `expected ${name}`));
        }
      },
      serialize(value: T): JsonValue {
        return serializeValue ? serializeValue(value) : asJson(value);
      },
    };
  }
}

export namespace Field {
  export function required<T>(model: Model<T>): Field<T> {
    return {
      required: true,
      safeHydrate(
        raw: Option<JsonValue>,
        path: readonly string[],
        present: boolean,
      ): Model.Result<T> {
        if (!present || raw === null || raw === undefined) {
          return Model.err(Model.issue(path, "required", "missing required field"));
        }
        const result = model.safeHydrate(raw);
        if (result.isOk) return result;
        return Model.issues(prefixIssues(path, result.issues));
      },
      serialize(value: T): Option<JsonValue> {
        return model.serialize(value);
      },
    };
  }

  /**
   * A patch field (`field?: Patch<T>`): an absent key stays absent (keep),
   * a `null` decodes to `Patch.CLEAR` (clear), a value decodes through
   * `model` (set); serializing writes a clear as `null`.
   */
  export function patch<T>(model: Model<T>): Field<Option<Patch<T>>> {
    return {
      required: false,
      safeHydrate(
        raw: Option<JsonValue>,
        path: readonly string[],
        present: boolean,
      ): Model.Result<Option<Patch<T>>> {
        if (!present || raw === undefined) return Model.ok(undefined);
        if (raw === null) return Model.ok(Patch.CLEAR);
        const result = model.safeHydrate(raw);
        if (result.isOk) return result;
        return Model.issues(prefixIssues(path, result.issues));
      },
      serialize(value: Option<Patch<T>>): Option<JsonValue> {
        if (value === undefined) return undefined;
        if (value === null || Patch.isClear(value)) return null;
        return model.serialize(value);
      },
    };
  }

  export function optional<T>(model: Model<T>): Field<Option<T>> {
    return {
      required: false,
      safeHydrate(
        raw: Option<JsonValue>,
        path: readonly string[],
        present: boolean,
      ): Model.Result<Option<T>> {
        if (!present || raw === null || raw === undefined) return Model.ok(null);
        const result = model.safeHydrate(raw);
        if (result.isOk) return result;
        return Model.issues(prefixIssues(path, result.issues));
      },
      serialize(value: Option<T>): Option<JsonValue> {
        if (value === undefined) return undefined;
        if (value === null) return null;
        return model.serialize(value);
      },
    };
  }
}

/**
 * A patch field's value: `T` sets the field, `Patch.CLEAR` clears it, and an
 * absent key (`field?: Patch<T>`) leaves it as it is — keep, set or clear,
 * each spelled once. On the wire a clear is `null`: `Field.patch` decodes a
 * `null` to `Patch.CLEAR` and serializes it back, and `Patch.CLEAR` also
 * writes itself as `null` through `JSON.stringify`.
 */
export type Patch<T> = T | Patch.Clear;

export namespace Patch {
  /** The one clear marker (compare with `Patch.isClear`, or `=== Patch.CLEAR`). */
  export interface Clear {
    readonly patch: "clear";
    toJSON(): null;
  }

  /** Clear the field: the wire's `null` in a patch body. */
  export const CLEAR: Clear = Object.freeze({
    patch: "clear" as const,
    toJSON: (): null => null,
  });

  /** Whether `value` is the clear marker. */
  export function isClear<T>(value: Option<Patch<T>>): value is Clear {
    return value === CLEAR;
  }

  /**
   * What an applied patch field leaves: the value it sets, `null` for a
   * clear, and `current` when the key was absent.
   */
  export function apply<T>(value: Option<Patch<T>>, current: Option<T>): Option<T> {
    if (value === undefined) return current;
    if (value === null || isClear(value)) return null;
    return value;
  }

  /** The field as a wire value: a clear is `null`, an absent key `undefined`. */
  export function toWire<T>(value: Option<Patch<T>>): Option<T> {
    if (isClear(value)) return null;
    return value;
  }

  /** A wire patch value as a `Patch`: `null` is a clear. */
  export function fromWire<T>(value: Option<T>): Option<Patch<T>> {
    if (value === null) return CLEAR;
    return value;
  }
}

export namespace Scalar {
  export const string: Model<string> = Model.scalar<string>(
    "string",
    (raw) => {
      if (typeof raw !== "string") throw new Error("expected string");
      return raw;
    },
    null,
  );

  export const number: Model<number> = Model.scalar<number>(
    "number",
    (raw) => {
      if (typeof raw !== "number") throw new Error("expected number");
      return raw;
    },
    null,
  );

  /** A JSON number with no fractional part. */
  export const integer: Model<number> = Model.scalar<number>(
    "integer",
    (raw) => {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new Error("expected integer");
      }
      return raw;
    },
    null,
  );

  export const boolean: Model<boolean> = Model.scalar<boolean>(
    "boolean",
    (raw) => {
      if (typeof raw !== "boolean") throw new Error("expected boolean");
      return raw;
    },
    null,
  );

  export const nullValue: Model<null> = Model.scalar<null>(
    "null",
    (raw) => {
      if (raw !== null) throw new Error("expected null");
      return null;
    },
    null,
  );

  export const json: Model<JsonValue> = Model.scalar<JsonValue>(
    "json",
    (raw) => raw,
    null,
  );

  /**
   * A conversion that does NOT check its input: `parse` decides alone what
   * it accepts (a throw or a `null`/`undefined` result refuses the value).
   * A wire decoder uses `checked`, which validates the JSON first.
   */
  export function revive<T>(
    name: string,
    // Unchecked by design: `parse` receives the JSON as it arrived and
    // alone decides what it accepts (a `string` parser refuses a non-string
    // by throwing or returning `null`).
    parse: (raw: UntypedJson) => Option<T>,
    serializeValue: Option<(value: T) => JsonValue>,
  ): Model<T> {
    return Model.scalar<T>(
      name,
      (raw) => {
        const value = parse(raw);
        if (value === null || value === undefined) {
          throw new Error(`expected ${name}`);
        }
        return value;
      },
      serializeValue,
    );
  }

  /**
   * An imported type `T` decoded from the JSON `wire` describes: `raw` is
   * validated against `wire` first (a mismatch reports `wire`'s issues, with
   * their paths), then `wire`'s hydrated value `W` is converted with `parse`,
   * which may still refuse it (a throw or a `null`/`undefined` result:
   * "expected `name`"). `parse` is typed `W -> Option<T>`, so a conversion
   * paired with the wrong wire shape or the wrong `T` does not compile. Its
   * second argument is the JSON as received (already checked against
   * `wire`), for a type that keeps what `wire` does not declare — an open
   * union whose envelope is checked and whose other keys pass through.
   * `serializeValue` writes a `T` back as a `W` (which `wire` serializes);
   * without one the value is written as it is.
   */
  export function checked<W, T>(
    name: string,
    wire: Model<W>,
    parse: (value: W, raw: JsonValue) => Option<T>,
    serializeValue: Option<(value: T) => W>,
  ): Model<T> {
    return {
      hydrate(raw: JsonValue): T {
        const result = this.safeHydrate(raw);
        if (result.isOk) return result.value;
        throw new ModelHydrationError(result.issues);
      },
      safeHydrate(raw: JsonValue): Model.Result<T> {
        const shape = wire.safeHydrate(raw);
        if (!shape.isOk) return shape;
        try {
          const value = parse(shape.value, raw);
          if (value !== null && value !== undefined) return Model.ok(value);
        } catch {
          // A throwing conversion refuses the value like a `null` result.
        }
        return Model.err(Model.issue([], "type", `expected ${name}`));
      },
      serialize(value: T): JsonValue {
        return serializeValue ? wire.serialize(serializeValue(value)) : asJson(value);
      },
    };
  }

  export function stringUnion<T extends string>(
    values: readonly T[],
  ): Model<T> {
    const allowed = new Set<string>(values);
    const isMember = (raw: JsonValue): raw is T =>
      typeof raw === "string" && allowed.has(raw);
    return Model.scalar<T>(
      values.join(" | "),
      (raw) => {
        if (!isMember(raw)) throw new Error("expected string union");
        return raw;
      },
      null,
    );
  }
}

/**
 * A value a model writes as it is (no `serializeValue`): the model's `T` is
 * already its JSON — a decoded wire string, number, array or object.
 */
function isJsonObject(raw: JsonValue): raw is JsonReader.Object {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function asJson<T>(value: T): JsonValue {
  const json: UntypedJson = value;
  return json;
}

function prefixIssues(
  path: readonly string[],
  issues: readonly Model.Issue[],
): readonly Model.Issue[] {
  return issues.map((issue) => ({
    ...issue,
    path: [...path, ...issue.path],
  }));
}
