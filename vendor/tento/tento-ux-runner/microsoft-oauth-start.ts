/** Mirror InstanceUrl.root; discard spec queries such as fresh-auth or promo. */
export function appSigninUrl(appUrl: string): string {
  const url = new URL(appUrl);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("invalid app URL");
  }
  const parts = url.hostname.split(".");
  if (parts.length >= 3 && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    const label = parts[0];
    const prefix = label.includes("--")
      ? label.split("--")[0]
      : /^(dev|rc|[a-z]+-\d+)$/.test(label)
      ? label
      : "";
    url.hostname = [prefix, ...parts.slice(-2)].filter(Boolean).join(".");
  }
  url.pathname = "/signin";
  url.search = "";
  url.hash = "";
  url.searchParams.set("flag:outlook-provider", "true");
  return url.toString();
}

/** Accept only the app's common-tenant chooser flow, never a consumer home. */
export function isOAuthStart(value: string): boolean {
  const url = parse(value);
  return url?.origin === "https://login.microsoftonline.com" &&
    url.pathname === "/common/oauth2/v2.0/authorize" &&
    url.searchParams.get("prompt") === "select_account" &&
    url.searchParams.get("response_type") === "code" &&
    Boolean(url.searchParams.get("client_id")) &&
    Boolean(url.searchParams.get("redirect_uri"));
}

/** Validate the app-owned start endpoint as well as older direct-provider
 * starts. A server start must stay on the tested app's canonical root. */
export function oauthRedirectForStart(value: string, appUrl: string): string {
  const root = new URL(appSigninUrl(appUrl));
  const callback = new URL("/api/user/signin/outlook/redirect", root);
  const start = parse(value);
  if (start?.origin === callback.origin && start.pathname === callback.pathname &&
      start.searchParams.get("start") === "true" && !start.hash) {
    return callback.toString();
  }
  if (isOAuthStart(value) && start?.searchParams.get("redirect_uri") === callback.toString()) {
    return callback.toString();
  }
  throw new Error("app Microsoft OAuth start unavailable");
}

function parse(value: string): URL {
  try { return new URL(value); } catch { return new URL("about:blank"); }
}
