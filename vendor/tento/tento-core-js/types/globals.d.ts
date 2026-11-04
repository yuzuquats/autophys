/**
 * Runtime globals available in all JS environments (browser, Deno, Node, workers).
 * These are NOT DOM-specific — they're part of the web platform baseline.
 */

// Console
declare var console: {
  log(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  trace(...data: any[]): void;
  group(...data: any[]): void;
  groupEnd(): void;
};

// Fetch API
// The abort state read by TypedApi; the platform supplies the signal itself.
declare interface AbortSignal {
  readonly aborted: boolean;
}

declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

declare class Response {
  readonly status: number;
  readonly ok: boolean;
  readonly bodyUsed: boolean;
  readonly body: Option<{ readonly locked: boolean; cancel(): Promise<void> }>;
  readonly headers: Headers;
  /** True when the fetch followed at least one redirect; `url` is then the final URL. */
  readonly redirected: boolean;
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<any>;
  text(): Promise<string>;
}

declare class Headers {
  get(name: string): string | null;
}

declare class Request {
  readonly url: string;
  readonly method: string;
}

declare interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  credentials?: RequestCredentials;
  keepalive?: boolean;
  signal?: AbortSignal | null;
}

declare type RequestCredentials = "omit" | "same-origin" | "include";

// URL API
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  toString(): string;
}

declare class URLSearchParams {
  constructor(init?: string | Record<string, string>);
  append(name: string, value: string): void;
  get(name: string): string | null;
  toString(): string;
  readonly size: number;
  [Symbol.iterator](): Iterator<[string, string]>;
}

// Crypto
declare var crypto: {
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

// Performance
declare var performance: {
  now(): number;
  mark(name: string): void;
  measure(name: string, startMark: string, endMark: string): void;
  measure(name: string, options: { start: number; end: number }): void;
};

// Navigator (browser-only, guarded with typeof)
declare var navigator: {
  sendBeacon(url: string, data?: Blob | string): boolean;
};

// Blob
declare class Blob {
  constructor(blobParts?: any[], options?: { type?: string });
}

// Visibility (browser-only, guarded with typeof)
declare var document: {
  addEventListener(type: string, listener: () => void): void;
  visibilityState: string;
};

// Timers
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(id: number | undefined): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearInterval(id: number | undefined): void;

// Web Storage. Present in browsers and in Deno; absent in Node, which is why
// every use in this workspace is guarded by `typeof localStorage === "undefined"`.
declare var localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};
