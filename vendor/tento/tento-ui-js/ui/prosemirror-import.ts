import { InstanceUrl } from "@tento-core/instance-url";
import { Lazy } from "@tento-core/lazy";
import { Tracing } from "@tento-core/tracing";

import { DevModeUtils } from "../dev-mode";
import { VendoredImport } from "./vendored-import";

// @ts-ignore
export type Prosemirror = typeof import("@tento-plugins/prosemirror");

export namespace Prosemirror {
  // @ts-ignore
  export type EditorView = import("@tento-plugins/prosemirror").EditorView;
  // @ts-ignore
  export type Plugin = import("@tento-plugins/prosemirror").Plugin;
  // @ts-ignore
  export type Decoration = import("@tento-plugins/prosemirror").Decoration;
  // @ts-ignore
  export type DecorationSet = import("@tento-plugins/prosemirror").DecorationSet;
  // @ts-ignore
  export type Schema = import("@tento-plugins/prosemirror").Schema;
  // @ts-ignore
  export type DomSerializer = import("@tento-plugins/prosemirror").DOMSerializer;
  export type HtmlParser = any;
  export type HtmlSerializer = any;
  export type MarkdownParser = any;
  export type MarkdownSerializer = any;
  export namespace Markdown {
    export type Serde = {
      parser: MarkdownParser;
      serializer: MarkdownSerializer;
      schema: Schema;
    };
  }

  export interface LinkClickInfo {
    $anchor: HTMLAnchorElement;
    href: string;
    linkType: string | undefined;
    from: number;
    to: number;
    mark: any;
  }

  export type OnLinkClick = (view: EditorView, info: LinkClickInfo) => void;

  export interface LoadState {
    status: "idle" | "loading" | "loaded";
    getCallCount: number;
    loadStartCount: number;
    sharedWaitCount: number;
  }

  let getCallCount = 0;
  let loadStartCount = 0;
  let sharedWaitCount = 0;

  // Bump on every dist/prosemirror.min.js rebuild that changes the module's
  // surface. The static routes serve the bundle without Cache-Control, so a
  // browser happily reuses a stale cached copy across deploys — observed: a
  // pre-Decoration-export cache crashed doc-comments' plugin
  // (`DecorationSet.create` of undefined). The version busts that cache.
  const BUNDLE_VERSION = 6;

  // Startup can bind many ProseMirror-backed cells in the same frame. Keep the
  // module import behind one Lazy so every caller shares the same init.
  const prosemirrorModule: Lazy<Prosemirror> = new Lazy(
    async () => {
      loadStartCount++;
      const startedAt = performance.now();
      Tracing.info("ui")("prosemirror/init-start", {
        getCallCount,
        loadStartCount,
        sharedWaitCount,
      });
      const query = `?v=${BUNDLE_VERSION}&${DevModeUtils.queryParam}`;
      // Same-origin retry (a storybook card's own InstanceUrl), skipped when
      // the static base already is same-origin; a final failure logs
      // `prosemirror/init-failed` at warn (see VendoredImport).
      const loaded: Prosemirror = await VendoredImport.load(
        {
          label: "prosemirror",
          url: `${InstanceUrl.staticUrl("/js/prosemirror.min.js")}${query}`,
          fallbackUrl: `/@/static/js/prosemirror.min.js${query}`,
        },
        (url) => import(url),
      );
      Tracing.info("ui")("prosemirror/init-ready", {
        getCallCount,
        loadStartCount,
        sharedWaitCount,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return loaded;
    },
  );

  export async function get(): Promise<Prosemirror> {
    // TODO: try catch
    //
    // } catch (error) {
    //   console.error("Failed to initialize HTML editor:", error);
    //   return this;
    // }
    getCallCount++;
    if (!prosemirrorModule.hasResolved && loadStartCount > 0) {
      sharedWaitCount++;
    }
    return await prosemirrorModule.get();
  }

  export function preload(): Promise<Prosemirror> {
    return get();
  }

  export function loadState(): LoadState {
    return {
      status: prosemirrorModule.hasResolved
        ? "loaded"
        : loadStartCount > 0
        ? "loading"
        : "idle",
      getCallCount,
      loadStartCount,
      sharedWaitCount,
    };
  }
}
