import { InstanceUrl, type ServiceDomain } from "./instance-url";

export type ResourceDomain = ServiceDomain | "root";

export type ResourceOrigin = {
  hostname: string;
  protocol: string;
  staticOrigin: Option<string>;
};

type ResourceTarget =
  | {
    kind: "domain";
    domain: ResourceDomain;
  }
  | {
    kind: "current-origin";
  };

type ResourceGlobal = typeof globalThis & {
  location?: Option<{
    hostname: string;
    protocol: string;
  }>;
  getStaticOrigin?: Option<() => string>;
  window?: Option<{
    getStaticOrigin?: Option<() => string>;
  }>;
};

const STATIC_ALIAS_PREFIX = "/@/static";
const HTTP_URL_PATTERN = /^https?:\/\//;

/**
 * Domain-aware loader for non-JSON-route resources such as static assets,
 * generated docs content, bundled markdown, and small registry files.
 *
 * Use TypedApi for generated API routes. This client is only for resources
 * where callers need text, bytes, or ad hoc JSON outside the route schema.
 */
export class ResourceClient {
  private constructor(
    private readonly target: ResourceTarget,
    private readonly origin: ResourceOrigin,
    private readonly fetchFn: ResourceClient.FetchFn,
  ) {}

  static forDomain(domain: ResourceDomain): ResourceClient {
    return new ResourceClient(
      { kind: "domain", domain },
      currentOrigin(),
      (url) => globalThis.fetch(url),
    );
  }

  static forOrigin(
    domain: ResourceDomain,
    origin: ResourceOrigin,
  ): ResourceClient {
    return new ResourceClient(
      { kind: "domain", domain },
      origin,
      (url) => globalThis.fetch(url),
    );
  }

  static currentOrigin(): ResourceClient {
    return new ResourceClient(
      { kind: "current-origin" },
      currentOrigin(),
      (url) => globalThis.fetch(url),
    );
  }

  static currentOriginFor(origin: ResourceOrigin): ResourceClient {
    return new ResourceClient(
      { kind: "current-origin" },
      origin,
      (url) => globalThis.fetch(url),
    );
  }

  withFetcher(fetchFn: ResourceClient.FetchFn): ResourceClient {
    return new ResourceClient(this.target, this.origin, fetchFn);
  }

  url(path: string): string {
    if (HTTP_URL_PATTERN.test(path)) return path;

    if (this.target.kind === "current-origin") {
      return ensureLeadingSlash(path);
    }

    const domain = this.target.domain;
    if (path.startsWith(STATIC_ALIAS_PREFIX)) {
      return this.staticUrl(path.slice(STATIC_ALIAS_PREFIX.length));
    }

    const suffix = ensureLeadingSlash(path);
    if (domain === "static") {
      return this.staticUrl(suffix);
    }

    if (domain === "root") {
      return InstanceUrl.urlForHostname(
        this.origin.hostname,
        suffix,
        null,
        this.origin.protocol,
      );
    }

    return InstanceUrl.urlForHostname(
      this.origin.hostname,
      suffix,
      domain,
      this.origin.protocol,
    );
  }

  async text(path: string): Promise<string> {
    return (await this.fetchResource(path)).text();
  }

  async bytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.fetchResource(path)).arrayBuffer());
  }

  async json<T>(
    path: string,
    parse: ResourceClient.JsonParser<T>,
  ): Promise<T> {
    return parse(JSON.parse(await this.text(path)));
  }

  private staticUrl(suffix: string): string {
    const origin = this.origin.staticOrigin ??
      InstanceUrl.urlForHostname(
        this.origin.hostname,
        "",
        "static",
        this.origin.protocol,
      );
    if (suffix.length === 0) return origin;
    return `${origin}${ensureLeadingSlash(suffix)}`;
  }

  private async fetchResource(path: string): Promise<Response> {
    const url = this.url(path);
    const response = await this.fetchFn(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GET ${url} failed with status ${response.status}`);
    }
    return response;
  }
}

export namespace ResourceClient {
  export type FetchFn = (url: string) => Promise<Response>;
  export type JsonParser<T> = (raw: UntypedJson) => T;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function currentOrigin(): ResourceOrigin {
  const globals = globalThis as ResourceGlobal;
  return {
    hostname: globals.location?.hostname ?? "",
    protocol: globals.location?.protocol ?? "https:",
    staticOrigin: currentStaticOrigin(globals),
  };
}

function currentStaticOrigin(globals: ResourceGlobal): Option<string> {
  const direct = globals.getStaticOrigin;
  if (direct) return direct();

  const fromWindow = globals.window?.getStaticOrigin;
  if (fromWindow) return fromWindow();

  return null;
}
