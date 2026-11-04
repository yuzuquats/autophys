import { CheckmarkIcon, LinkIcon, SearchIcon, XIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { Icon } from "./icon";

export class IconStoryBook extends Storybook.Default {
  title(): string {
    return "Icon";
  }

  tags(): string[] {
    return ["std-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Decorative (aria-hidden)", render: () => Icon.makeWith({ svg: CheckmarkIcon, label: null, size: null }) },
      { title: "Named (role=img)", render: () => Icon.makeWith({ svg: SearchIcon, label: "Search", size: null }) },
      { title: "Sized 32px", render: () => Icon.makeWith({ svg: LinkIcon, label: "Link", size: 32 }) },
      {
        title: "Coloured by the knob",
        render: () => {
          const $i = Icon.makeWith({ svg: XIcon, label: "Close", size: 24 });
          $i.style.setProperty("--icon-color", "var(--blue)");
          return $i;
        },
      },
    ];
  }
}
