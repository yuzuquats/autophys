import { DevModeUtils } from "../dev-mode";
import { InstanceUrl } from "@tento-core/instance-url";
import { Lazy } from "@tento-core/lazy";

export type Pretext = {
  prepare(text: string, font: string): Pretext.PreparedText;
  prepareWithSegments(
    text: string,
    font: string,
  ): Pretext.PreparedTextWithSegments;
  layout(
    prepared: Pretext.PreparedText,
    maxWidth: number,
    lineHeight: number,
  ): Pretext.LayoutResult;
  layoutWithLines(
    prepared: Pretext.PreparedTextWithSegments,
    maxWidth: number,
    lineHeight: number,
  ): Pretext.LayoutLinesResult;
  clearCache(): void;
};

export namespace Pretext {
  declare const brand: unique symbol;

  export type PreparedText = { readonly [brand]: true };
  export type PreparedTextWithSegments = PreparedText & {
    segments: string[];
  };

  export type LayoutResult = {
    lineCount: number;
    height: number;
  };

  export type LayoutLine = {
    text: string;
    width: number;
  };

  export type LayoutLinesResult = LayoutResult & {
    lines: LayoutLine[];
  };

  const module: Lazy<Pretext> = new Lazy(
    () =>
      import(
        `${InstanceUrl.staticUrl("/js/pretext.min.js")}?${DevModeUtils.queryParam}`
      ),
  );

  export async function get(): Promise<Pretext> {
    return await module.get();
  }

  export function preload(): void {
    module.get();
  }
}
