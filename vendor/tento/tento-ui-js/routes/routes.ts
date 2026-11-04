export namespace Routes {
  export function getQueryParams(
    url: URL = new URL(window.location.href, window.location.origin),
  ): Map<string, string> {
    const { searchParams } = url;
    return new Map(searchParams);
  }

  export function getHashParams(): Map<string, string> {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1) // drop the leading “#”
      : window.location.hash;

    if (!hash) return new Map(); // nothing to parse

    return new Map(
      hash.split("&").map((part) => {
        // Split on the *first* ":" only so values may also contain ":"
        const [rawKey, ...rest] = part.split(":");
        const rawValue = rest.join(":"); // re‑join in case “:” was in the value
        return [decodeURIComponent(rawKey), decodeURIComponent(rawValue)];
      }),
    );
  }

  export function setHashParam(
    key: string,
    value: string,
    soft: boolean = true,
  ): void {
    // getHashParams() must now return Map<string, string>
    const params: Map<string, string> = getHashParams();
    params.set(key, value); // mutate / add

    const newHash = [...params.entries()]
      .map(([k, v]) => `${encodeURIComponent(k)}:${encodeURIComponent(v)}`)
      .join("&");

    if (soft && window.history.replaceState) {
      window.history.replaceState(null, "", `#${newHash}`);
    } else {
      window.location.hash = `#${newHash}`;
    }
  }
}
