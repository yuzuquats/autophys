import { TypedApi } from "@tento-core/typed-api";
import { Network } from "@tento-web/admin/system-routes";

export const AdminApi = TypedApi.makeWith<Network.Routes>(
  Network.REVIVERS,
);

/**
 * Get the main domain for API calls and redirects.
 * Admin pages are served from various subdomains but API lives on main domain.
 *
 * Examples:
 * - dev--calendar.lona.so -> https://dev.lona.so
 * - aws-04--calendar.lona.so -> https://aws-04.lona.so
 * - calendar.lona.so -> https://lona.so
 * - dev.lona.so -> https://dev.lona.so (already main)
 */
export function getMainDomain(): string {
  const host = window.location.hostname;

  // dev--calendar.lona.so -> dev.lona.so
  if (host.includes("--")) {
    const prefix = host.split("--")[0];
    return `https://${prefix}.lona.so`;
  }

  // calendar.lona.so -> lona.so
  // dev.lona.so -> dev.lona.so (already main)
  const parts = host.split(".");
  if (parts.length > 2 && parts[0] !== "dev" && !parts[0].startsWith("aws-")) {
    return `https://${parts.slice(1).join(".")}`;
  }

  return window.location.origin;
}
