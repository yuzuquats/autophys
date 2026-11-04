import { nonnull_noexcept } from "@tento-core/assert";

export const $ = <T extends HTMLElement = HTMLElement>(
  id: string,
  $e?: HTMLElement | ShadowRoot,
): T => {
  const selector = `#${escapeCssId(id)}`;
  return nonnull_noexcept(
    $e ? $e.querySelector(selector) : document.getElementById(id),
  ) as T;
};

export const $_maybe = <T extends HTMLElement = HTMLElement>(
  id: string,
  $e?: HTMLElement | ShadowRoot,
): Option<T> => {
  const selector = `#${escapeCssId(id)}`;
  return ($e ? $e.querySelector(selector) : document.getElementById(id)) as T;
};

function escapeCssId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export const $qs = <T extends HTMLElement = HTMLElement>(
  s: string,
  $e?: HTMLElement | ShadowRoot,
): T => {
  return nonnull_noexcept(($e ?? document).querySelector(s)) as T;
};

export const $qs_maybe = <T extends HTMLElement = HTMLElement>(
  s: string,
  $e?: HTMLElement | ShadowRoot,
): Option<T> => {
  return ($e ?? document).querySelector(s) as T;
};

export const $qsa = <T extends HTMLElement = HTMLElement>(
  s: string,
  $e?: Option<HTMLElement | ShadowRoot>,
): NodeListOf<T> => {
  return ($e ?? document).querySelectorAll(s) as NodeListOf<T>;
};
