import { Storybook } from "../../ui/storybook";
import { Outline } from "./outline";

const ITEMS: Outline.Item[] = [
  { id: "thesis", label: "A catalogue nobody can trust", level: 1 },
  { id: "gate", label: "The grounding gate", level: 2 },
  { id: "verdicts", label: "Verdicts", level: 2 },
  { id: "structural", label: "The structural verdicts", level: 3 },
  { id: "order", label: "What lands, in what order", level: 2 },
  { id: "unmeasured", label: "What is not measured", level: 1 },
];

function $outline(): Outline {
  let active: Option<string> = "verdicts";
  const $o = Outline.make();
  const rebind = () => $o.bind({ items: ITEMS, activeId: active, onSelect: (id) => { active = id; rebind(); }, label: "On this page" });
  rebind();
  $o.style.maxWidth = "260px";
  return $o;
}

export class OutlineStoryBook extends Storybook.Default {
  title(): string {
    return "Outline";
  }

  tags(): string[] {
    return ["std-outline"];
  }

  examples(): Storybook.Example[] {
    return [{ title: "Three levels, one current", render: () => $outline() }];
  }
}
