import { Div } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Lightbox } from "./lightbox";

function $stage(): HTMLElement {
  const $d = Div.make();
  $d.style.width = "100%";
  $d.style.height = "100%";
  $d.style.background = "linear-gradient(135deg, var(--bg-surface-light), var(--divider))";
  return $d;
}

/** A lightbox is nothing until shown, so the example is its trigger. */
function $trigger(label: string, props: Lightbox.Props): HTMLElement {
  const $btn = Button.makeWith(label, { type: "secondary", onClick: () => Lightbox.show(props) });
  return $btn;
}

export class LightboxStoryBook extends Storybook.Default {
  title(): string {
    return "Lightbox";
  }

  tags(): string[] {
    return ["std-lightbox"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Native size 480×270 (Escape closes; focus returns)", render: () => $trigger("Open lightbox", { label: "hero.png · 480×270", nativeSize: { width: 480, height: 270 }, makeContent: $stage, inertContent: true }) },
      { title: "Larger than the viewport — scrolls", render: () => $trigger("Open large", { label: "sheet.png · 2400×1600", nativeSize: { width: 2400, height: 1600 }, makeContent: $stage, inertContent: true }) },
    ];
  }
}
