import { replaceAll } from "./polyfill";

export type PrefixedUuid<Prefix> = string & {
  readonly __prefix: Prefix;
};

export namespace PrefixedUuid {
  export function serialize(prefix: string, uuid: string): string {
    return `${prefix}_${replaceAll(uuid, "-", "")}`;
  }
}
