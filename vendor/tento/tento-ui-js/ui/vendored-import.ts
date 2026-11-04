import { Tracing } from "@tento-core/tracing";

/**
 * Loads a vendored bundle (`/js/prosemirror.min.js`, `/js/codemirror.min.js`)
 * from the static base, with one same-origin retry.
 *
 * The retry exists for a storybook card: a separately bundled module graph
 * holds its own copy of `InstanceUrl`, never sees the base its host page set,
 * and resolves to a static subdomain that not every embedding origin can
 * reach. When the static base already IS the same-origin path the retry
 * would request the URL that just failed, so it is skipped. A load that
 * fails for good is logged at warn (`<label>/init-failed`, with the URL and
 * the error) before it rejects: a caller behind a `Lazy` may not observe the
 * rejection, and an editor that silently renders empty is the failure this
 * log makes visible.
 */
export namespace VendoredImport {
  export type Importer<T> = (url: string) => Promise<T>;

  export interface Source {
    /** Log label: `prosemirror`, `codemirror`. */
    readonly label: string;
    /** `InstanceUrl.staticUrl(path) + query`. */
    readonly url: string;
    /** The same-origin `/@/static` URL of the same file and query. */
    readonly fallbackUrl: string;
  }

  export async function load<T>(source: Source, importer: Importer<T>): Promise<T> {
    const { label, url, fallbackUrl } = source;
    try {
      return await importer(url);
    } catch (error) {
      if (fallbackUrl === url) {
        Tracing.warn("ui")(label + "/init-failed", {
          url,
          error: errorMessage(error),
          retried: false,
        });
        throw error;
      }
      Tracing.info("ui")(label + "/init-retry-same-origin", {
        url,
        fallbackUrl,
        reason: errorMessage(error),
      });
      try {
        return await importer(fallbackUrl);
      } catch (retryError) {
        Tracing.warn("ui")(label + "/init-failed", {
          url: fallbackUrl,
          error: errorMessage(retryError),
          firstUrl: url,
          firstError: errorMessage(error),
          retried: true,
        });
        throw retryError;
      }
    }
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
