import { LazyImage } from "./lazy-image";

export function verifyLazyImage(): string[] {
  const props: LazyImage.ViewModel = { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E", alt: "Image", width: 640, height: 480, onSettled: null, onError: null };
  const $field = LazyImage.makeWith(props);
  const $img = $field.shadowRoot?.querySelector("img");
  if (!($img instanceof HTMLImageElement)) throw new Error("Lazy image is missing");
  try {
    $field.bind({ ...props, width: null, height: 100 });
    if ($img.hasAttribute("width") || $img.getAttribute("height") !== "100") throw new Error("Null width must clear independently of height");
    $field.bind({ ...props, width: 200, height: null });
    if ($img.getAttribute("width") !== "200" || $img.hasAttribute("height")) throw new Error("Null height must clear independently of width");
    $field.bind({ ...props, width: null, height: null });
    if ($img.hasAttribute("width") || $img.hasAttribute("height")) throw new Error("A rebind without dimensions must clear the previous geometry");
    return ["rebind clears each omitted intrinsic dimension"];
  } finally { $field.onRecycle(); }
}
