export type DevMode = "beta" | "rc" | "prod";

import { Cookies } from "./cookies";

export class DevModeUtils {
  static devModeIdentifier = "dev-mode";

  private static inferModeFromHost(): DevMode {
    const hostname = globalThis.location?.hostname ?? "";
    const subdomain = hostname.split(".")[0] ?? "";
    if (subdomain === "dev" || subdomain.startsWith("dev--")) return "beta";
    if (subdomain === "rc" || subdomain.startsWith("rc--")) return "rc";
    // A fleet miniapp can serve a frozen dev/RC frontend on a hostname that
    // carries no stage. Keep runtime module requests on its declared stage.
    const declared = globalThis.document?.querySelector<HTMLMetaElement>(
      'meta[name="frontend-default-stage"]',
    )?.content;
    if (declared === "beta" || declared === "rc" || declared === "prod") {
      return declared;
    }
    return "prod";
  }

  static get queryParam(): string {
    return `dev-mode=${DevModeUtils.getMode()}`;
  }

  static clear(domain?: Option<string>) {
    Cookies.remove(DevModeUtils.devModeIdentifier, domain);
  }

  static setMode(
    mode: DevMode,
    domain: Option<string> = ".lona.so",
    sameSite: Option<"None" | "Lax"> = "None",
  ) {
    Cookies.set(DevModeUtils.devModeIdentifier, {
      value: mode,
      domain,
      sameSite,
    });
    DevModeUtils.emitUpdate();
    location.reload();
  }

  static getMode(): DevMode {
    return (
      (Cookies.get(DevModeUtils.devModeIdentifier) as DevMode) ??
      DevModeUtils.inferModeFromHost()
    );
  }

  static emitUpdate() {
    const mode = DevModeUtils.getMode();
    const meta =
      (document.getElementById("dev-mode") as HTMLMetaElement) ??
      document.createElement("meta");
    meta.id = "dev-mode";
    meta.name = "dev-mode";
    meta.content = mode;
    document.head.appendChild(meta);

    globalThis.dispatchEvent(
      new CustomEvent("devModeChanged", {
        detail: {
          mode,
        },
      }),
    );
  }
}
