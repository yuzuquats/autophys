/**
 * Instance-aware URL utilities for cross-subdomain navigation.
 *
 * This module only constructs URLs for links, redirects, dynamic imports, and
 * other navigation-style uses. Use ResourceClient for code that loads resource
 * bodies, and TypedApi for generated API routes.
 *
 * Subdomain patterns:
 * - Production: calendar.lona.so, lona.so
 * - Dev: dev--calendar.lona.so, dev.lona.so
 * - RC: rc--calendar.lona.so, rc.lona.so
 * - Fleet: aws-04--calendar.lona.so, aws-04.lona.so
 */

export type ServiceDomain =
  | "calendar"
  | "static"
  | "ui"
  | "tasks"
  | "blog"
  | "admin"
  | "booking";

export namespace InstanceUrl {
  export type ParsedOrigin = {
    prefix: Option<string>;
    rootDomain: string;
  };

  function currentHostname(): string {
    if (typeof globalThis === "undefined" || !globalThis.location?.hostname) {
      return "";
    }
    return globalThis.location.hostname;
  }

  function currentProtocol(): string {
    if (typeof globalThis === "undefined" || !globalThis.location?.protocol) {
      return "https:";
    }
    return globalThis.location.protocol;
  }

  function isFleetPrefix(name: string): boolean {
    if (name === "dev" || name === "rc") {
      return true;
    }

    const dashIndex = name.lastIndexOf("-");
    if (dashIndex > 0) {
      const provider = name.slice(0, dashIndex);
      const number = name.slice(dashIndex + 1);
      return (
        provider.length > 0 &&
        /^[a-z]+(?:-[a-z]+)*$/.test(provider) &&
        number.length > 0 &&
        /^\d+$/.test(number)
      );
    }
    return false;
  }

  function formatServiceHost(
    parsed: ParsedOrigin,
    service: Option<ServiceDomain>,
  ): string {
    if (service === null) {
      return parsed.prefix
        ? `${parsed.prefix}.${parsed.rootDomain}`
        : parsed.rootDomain;
    }

    const hostLabel = parsed.prefix ? `${parsed.prefix}--${service}` : service;
    return `${hostLabel}.${parsed.rootDomain}`;
  }

  export function parseHostname(hostname: string): ParsedOrigin {
    const parts = hostname.split(".");
    if (parts.length < 3) {
      return { prefix: null, rootDomain: hostname };
    }

    const subdomainPart = parts[0];
    const rootDomain = parts.slice(-2).join(".");

    if (subdomainPart.includes("--")) {
      const [prefix] = subdomainPart.split("--");
      return { prefix, rootDomain };
    }

    if (isFleetPrefix(subdomainPart)) {
      return { prefix: subdomainPart, rootDomain };
    }

    return { prefix: null, rootDomain };
  }

  export function parseOrigin(): ParsedOrigin {
    return parseHostname(currentHostname());
  }

  // Whether `hostname` is the bare root domain (apex), ignoring fleet host
  // prefixes (dev, rc, aws-04, rwc-01). Service subdomains (blog, static, admin,
  // calendar, …) are NOT the root domain. Mirrors the canonical server-side
  // DomainType::extract_from_host_uri classifier so client and server agree:
  //   lona.so / dev.lona.so / rc.lona.so / rwc-01.lona.so / www.lona.so → true
  //   blog.lona.so / dev--blog.lona.so / rc--blog.lona.so / static.lona.so → false
  export function isRootDomainForHostname(hostname: string): boolean {
    const host = hostname.split(":")[0]; // strip :port
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // bare IPv4 (matches Rust)

    const components = host.split(".");
    if (components.length < 3) return true; // lona.so, localhost

    const subdomainPart = components[components.length - 3];

    const dashIndex = subdomainPart.indexOf("--");
    if (dashIndex >= 0) {
      const fleetPrefix = subdomainPart.slice(0, dashIndex);
      const actualSubdomain = subdomainPart.slice(dashIndex + 2);
      if (isFleetPrefix(fleetPrefix) && actualSubdomain.length > 0) return false;
    }

    return subdomainPart === "www" || isFleetPrefix(subdomainPart);
  }

  export function isRootDomain(): boolean {
    return isRootDomainForHostname(currentHostname());
  }

  export function subdomainForHostname(
    hostname: string,
    service: ServiceDomain = "static",
  ): string {
    const parts = hostname.split(".");
    if (parts.length < 3) return service;

    const parsed = parseHostname(hostname);
    return parsed.prefix ? `${parsed.prefix}--${service}` : service;
  }

  export function subdomain(service: ServiceDomain = "static"): string {
    return subdomainForHostname(currentHostname(), service);
  }

  export function hostForHostname(
    hostname: string,
    service: Option<ServiceDomain> = "static",
  ): string {
    return formatServiceHost(parseHostname(hostname), service);
  }

  export function urlForHostname(
    hostname: string,
    path: string = "",
    service: Option<ServiceDomain> = "static",
    protocol: string = "https:",
  ): string {
    return `${protocol}//${hostForHostname(hostname, service)}${path}`;
  }

  export function url(
    path: string = "",
    service: Option<ServiceDomain> = "static",
  ): string {
    return urlForHostname(currentHostname(), path, service, currentProtocol());
  }

  export function calendar(path: string = ""): string {
    return url(path, "calendar");
  }

  export function blog(path: string = ""): string {
    return url(path, "blog");
  }

  export function root(path: string = ""): string {
    return url(path, null);
  }

  // Opt-in base override for hosts with no static.* subdomain: tento.localhost
  // serves vendored copies of the static-domain assets (runtime modules like
  // prosemirror/codemirror.min.js) under /@/static and points this at it at
  // page bootstrap. Affects only staticUrl(); other services keep the
  // subdomain scheme.
  let staticBase: Option<string> = null;

  /** Route every staticUrl() at `base` (e.g. "/@/static") instead of the
   * instance's static subdomain. Call before anything resolves a static URL. */
  export function setStaticBase(base: string): void {
    staticBase = base;
  }

  /** Whether a base has been declared. Lets an embedder set one only when
   * nothing else has, instead of overriding a host that got it right. */
  export function hasStaticBase(): boolean {
    return staticBase != null;
  }

  export function staticUrl(path: string = ""): string {
    if (staticBase != null) return `${staticBase}${path}`;
    return url(path, "static");
  }

  export function allowedOriginsForHostname(
    hostname: string,
    protocol: string = "https:",
  ): string[] {
    return [
      urlForHostname(hostname, "", null, protocol),
      urlForHostname(hostname, "", "calendar", protocol),
    ];
  }

  export function allowedOrigins(): string[] {
    return allowedOriginsForHostname(currentHostname(), currentProtocol());
  }

  export function isAllowedOrigin(origin: string): boolean {
    return allowedOrigins().includes(origin);
  }
}
