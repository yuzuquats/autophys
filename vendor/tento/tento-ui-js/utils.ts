import { Globals } from "./globals";
import { Tracing } from "@tento-core/tracing";
import { Point } from "@tento-core/point";
import { replaceAll } from "@tento-core/polyfill";

export namespace Utils {
  export const isPresent = <T>(item: Option<T>): item is T => {
    return !!item;
  };

  export function uuidToDomId(prefix: string, uuid: Uuid): string {
    return prefix + "_" + replaceAll(uuid, "-", "");
  }

  export function debounce<T>(
    returnFunc: (...args: any[]) => T | Promise<T>,
    waitMs: number,
  ): (...args: any[]) => Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function (...args: any[]): Promise<T> {
      clearTimeout(timeout);
      return new Promise((resolve) => {
        timeout = setTimeout(() => {
          // @ts-ignore
          resolve(returnFunc.apply<any, any[], T | Promise<T>>(this, args));
        }, waitMs);
      });
    };
  }

  export function memoize<A, R>(fn: (a: A) => R): (a: A) => R {
    const cache: Map<A, R> = new Map();
    return (...args: any[]) => {
      const arg = args[0] as A;
      const maybeRes: Option<R> = cache.get(arg);
      if (maybeRes) {
        return maybeRes;
      }
      const result = fn(arg);
      cache.set(arg, result);
      return result;
    };
  }

  export function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  export function getOrdinal(n: number): string {
    if (n === -1) return "last";
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  }

  export function getOrDefault(
    s: Option<string>,
    defaultValue: string,
  ): string {
    if (s == null || s.length === 0) return defaultValue;
    return s;
  }

  export function passesJitterThreshold(
    p: Point,
    threshold: number = 3,
  ): boolean {
    return Math.abs(p.x) >= threshold || Math.abs(p.y) >= threshold;
  }

  export function debugPoint() {
    if (!Globals.isServiceAccount) return;
    Tracing.warn("ui")("debugpoint");
    // @ts-ignore
    // biome-ignore lint/suspicious/noDebugger: debugger
    debugger;
  }

  export function hash(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0; // 31 is a small prime
    }
    return hash >>> 0; // ensure unsigned 32-bit integer
  }

  export function hashToRange(s: string, n: number): number {
    const min = 0;
    const max = n;
    const range = max - min + 1;
    return min + (hash(s) % range);
  }
}
