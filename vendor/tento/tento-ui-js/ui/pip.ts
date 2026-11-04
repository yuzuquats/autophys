import { LonaWebComponentClass } from "../component";
import { Style, css } from "../component-styles";
import { DomUtils } from "../dom";
import { $qsa } from "../dom-selectors";
import { $$ } from "../fastdom";

declare class DocumentPictureInPictureEvent extends Event {}

declare class DocumentPictureInPicture {
  requestWindow(
    options?: Optional<{
      disallowReturnToOpener: boolean;
      preferInitialWindowPlacement: boolean;
      height: number;
      width: number;
    }>,
  ): Promise<Window>;

  addEventListener(
    type: "enter",
    listener: (e: DocumentPictureInPictureEvent) => any,
    options?: boolean | AddEventListenerOptions,
  );

  onenter: (e: DocumentPictureInPictureEvent) => any;
}

// https://developer.chrome.com/docs/web-platform/document-picture-in-picture
export namespace Pip {
  const handle: Option<DocumentPictureInPicture> =
    window["documentPictureInPicture"];

  export type Options = Optional<{
    components: LonaWebComponentClass[];
    margin: string;
    size: Size;
    disallowReturnToOpener: boolean;
    theme: "light" | "dark";
  }>;

  export const components: Set<LonaWebComponentClass> = new Set();

  export async function show(
    $e: HTMLElement,
    options: Options = {},
  ): Promise<Option<Window>> {
    if (!handle) return null;
    const w = await handle.requestWindow({
      height: options.size?.height ?? 480,
      width: options.size?.width ?? 300,
      disallowReturnToOpener: options.disallowReturnToOpener,
    });
    w["is-pip"] = true;
    for (const c of options.components ?? [...components.values()]) {
      w.customElements.define(c.componentName, c);
    }
    window.focus();
    $$.mutate(() => {
      if (options.theme) {
        w.document.documentElement.style.colorScheme = options.theme;
      }
      w.document.body.style.backgroundColor = "#ffffff";
      w.document.body.style.color = "#000000";
      w.document.body.style.margin = options.margin ?? "";
      w.document.body.style.boxSizing = "border-box";
      w.document.body.append(
        ...[...$qsa("link[rel=stylesheet]")].map(($link) =>
          $link.cloneNode(true),
        ),
      );
      w.document.body.append(
        Style.makeWith(css`
          body {
            background: var(--bg);
            font-family: Helvetica, sans-serif;
          }
        `),
      );
      w.document.body.append($e);
    });
    await DomUtils.hydrateAndReveal(w.document.body);
    return w;
  }
}
