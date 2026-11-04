import { Div } from "../component-builtin";
import { LazySync } from "../lazy";
import { Tracing } from "@tento-core/tracing";
import { ZIndex } from "../z-index";

export namespace GhostImage {
  let $ghostImage: Option<HTMLElement>;
  const init = new LazySync<number>(() => {
    document.addEventListener("pointermove", (e) => {
      if (!$ghostImage) {
        return;
      }
      $ghostImage.style.opacity = String(0.9);
      $ghostImage.style.transform = `translate(${e.pageX}px, ${e.pageY}px)`;
    }, { capture: true });
    // todo: we need to return something because we check fo non-nullness
    return 0;
  });

  export function setGhostImage<T extends HTMLElement = HTMLElement>(
    ghostImageContent: Option<T | Node>,
    size?: {
      width?: number;
      height?: number;
    },
    offset?: {
      x?: number;
      y?: number;
    },
  ): Option<T> {
    init.get();

    if (ghostImageContent == null) {
      if ($ghostImage) {
        document.body.removeChild($ghostImage);
      }
      $ghostImage = null;
      return undefined;
    }
    $ghostImage = Div.make();
    $ghostImage.style.position = "absolute";
    $ghostImage.style.top = (offset?.y ?? 0) + "px";
    $ghostImage.style.left = (offset?.x ?? 0) + "px";
    $ghostImage.style.pointerEvents = "none";
    $ghostImage.style.userSelect = "none";
    if (size) {
      if (size.width) $ghostImage.style.width = size.width + "px";
      if (size.height) $ghostImage.style.height = size.height + "px";
    }
    $ghostImage.style.opacity = String(0);
    $ghostImage.style.zIndex = String(ZIndex.DRAG_GHOST);
    $ghostImage.appendChild(ghostImageContent);

    const $ghostImageContent = $ghostImage.lastElementChild as T;
    $ghostImageContent.style.pointerEvents = "none";
    for (const $child of $ghostImageContent.children) {
      if ($child instanceof HTMLElement) {
        $child.style.pointerEvents = "none";
      }
    }

    document.body.appendChild($ghostImage);
    return $ghostImageContent;
  }
}
