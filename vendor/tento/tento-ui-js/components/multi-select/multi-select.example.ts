import { Storybook } from "../../ui/storybook";
import { MultiSelect } from "./multi-select";

const OPTIONS = ["Action", "Chat", "Container", "Content", "Feedback & Status", "Form Controls", "Layout", "Navigation", "Overlay", "Table & List", "Utility"].map((l) => ({ id: l.toLowerCase().replace(/[^a-z]+/g, "-"), label: l }));

function $field(searchable: boolean): MultiSelect {
  let values = ["action", "overlay"];
  const $m = MultiSelect.make();
  const rebind = () => $m.bind({ options: OPTIONS, values, onChange: (v) => { values = v; rebind(); }, searchable, placeholder: null, label: "Categories" });
  rebind();
  $m.style.maxWidth = "360px";
  return $m;
}

export class MultiSelectStoryBook extends Storybook.Default {
  title(): string {
    return "Multi Select";
  }

  tags(): string[] {
    return ["std-multi-select"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Searchable", render: () => $field(true) },
      { title: "Not searchable — ArrowDown lists the rest", render: () => $field(false) },
    ];
  }
}
