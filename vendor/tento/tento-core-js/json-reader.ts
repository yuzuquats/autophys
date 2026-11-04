/** Any JSON value: a string, number, boolean, `null`, array or object of JSON values. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

type JsonObject = {
  readonly [key: string]: JsonValue;
};

export namespace JsonReader {
  export type Object = JsonObject;

  export function parseObject(text: string, label: string): Object {
    return object(JSON.parse(text) as JsonValue, label);
  }

  export function object(value: JsonValue, label: string): Object {
    if (!isObject(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  }

  export function string(
    obj: Object,
    key: string,
    label: string,
  ): string {
    const value = obj[key] ?? null;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
    return value;
  }

  export function optionalString(
    obj: Object,
    key: string,
    label: string,
  ): Option<string> {
    const value = obj[key] ?? null;
    if (value == null) return null;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
    return value;
  }

  export function boolean(
    obj: Object,
    key: string,
    label: string,
  ): boolean {
    const value = obj[key] ?? null;
    if (typeof value !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
    return value;
  }

  export function optionalBoolean(
    obj: Object,
    key: string,
    label: string,
  ): Option<boolean> {
    const value = obj[key] ?? null;
    if (value == null) return null;
    if (typeof value !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
    return value;
  }

  export function positiveInteger(
    obj: Object,
    key: string,
    label: string,
  ): number {
    const value = obj[key] ?? null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
    return value;
  }

  export function optionalPositiveInteger(
    obj: Object,
    key: string,
    label: string,
  ): Option<number> {
    const value = obj[key] ?? null;
    if (value == null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
    return value;
  }

  export function childObject(
    obj: Object,
    key: string,
    label: string,
  ): Object {
    return object(obj[key] ?? null, `${label}.${key}`);
  }

  export function array(
    obj: Object,
    key: string,
    label: string,
  ): readonly JsonValue[] {
    const value = obj[key] ?? null;
    if (!Array.isArray(value)) {
      throw new Error(`${label}.${key} must be an array`);
    }
    return value;
  }

  function isObject(value: JsonValue): value is Object {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
