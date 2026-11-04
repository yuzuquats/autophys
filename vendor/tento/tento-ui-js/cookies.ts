import { Utc } from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";

export namespace Cookies {
  export function set(
    name: string,
    options?: Optional<{
      value: string;
      days: number;
      maxAgeSec: number;
      domain: string;
      sameSite: "Lax" | "None";
    }>,
  ) {
    let cookieBuilder = `${name}=${options?.value ?? ""};`;
    if (options?.days != null) {
      // Use HTTP-date format (RFC 7231) for cookie Expires attribute
      const expiresDate = new Date(Utc.now().add({ days: options.days }).mse);
      cookieBuilder += ` Expires=${expiresDate.toUTCString()};`;
    }
    if (options?.maxAgeSec != null) {
      cookieBuilder += ` Max-Age=${options.maxAgeSec};`;
    }
    if (options?.domain) {
      cookieBuilder += ` domain=${options.domain};`;
    }
    if (options?.sameSite) {
      cookieBuilder += ` SameSite=${options.sameSite};`;
      if (options?.sameSite === "None") {
        cookieBuilder += " Secure;";
      }
    }
    cookieBuilder += " path=/";
    document.cookie = cookieBuilder;
  }

  export function has(name: string): boolean {
    return Cookies.get(name) != null;
  }

  export function get(name: string): Option<string> {
    const nameq = name + "=";
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(";");
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === " ") {
        c = c.substring(1);
      }
      if (c.indexOf(nameq) === 0) {
        return c.substring(nameq.length, c.length);
      }
    }
    return null;
  }

  export function toggle(
    name: string,
    options: Optional<{
      domain: string;
      force: boolean;
    }>,
  ): boolean {
    const on = options?.force != null ? options?.force : Cookies.has(name);
    if (on) {
      Cookies.set(name, {
        maxAgeSec: 999999999,
        domain: options.domain,
      });
    } else {
      Cookies.remove(name, options.domain);
    }
    return Cookies.get(name) != null;
  }

  export function remove(name: string, domain?: Option<string>) {
    // NOTE: path must match how the cookie was created!!
    let cookie = name + "=;";
    if (domain) {
      cookie += ` domain=${domain};`;
    }
    // Set both Max-Age and Expires for maximum browser compatibility
    // with cross-subdomain cookies (domain=.lona.so)
    cookie +=
      " Max-Age=-99999999; Expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    document.cookie = cookie;
  }
}
