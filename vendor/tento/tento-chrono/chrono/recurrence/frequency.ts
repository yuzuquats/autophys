import type { Option } from "../option.ts";

export const frequencies = [
  "secondly",
  "minutely",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;
export type Frequency = (typeof frequencies)[number];
export const frequencySet: Set<string> = new Set(frequencies);

export namespace Frequency {
  export function parse(s: Option<string>): Option<Frequency> {
    if (!s) return null;
    const lower = s.toLowerCase();
    return frequencySet.has(lower) ? (lower as Frequency) : null;
  }

  export function serialize(freq: Frequency): string {
    return freq.toUpperCase();
  }
}
