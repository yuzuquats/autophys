import { Storybook } from "../../../ui/storybook";
import { TagSelector } from "./tag-selector";
import { Column } from "../../../component-builtin";
import { Typography } from "../../../ui/typography";

type ExampleTag = {
  name: string;
  color: () => string;
  emoji?: string;
};

const EXAMPLE_TAGS: ExampleTag[] = [
  { name: "Work", color: () => "var(--blue-dimmed)", emoji: "💼" },
  { name: "Personal", color: () => "var(--green-dimmed)", emoji: "🏠" },
  { name: "Health", color: () => "var(--red-dimmed)", emoji: "❤️" },
  { name: "Finance", color: () => "var(--yellow-dimmed)", emoji: "💰" },
];

function makeTagList(onSelect: (tag: ExampleTag) => void): HTMLElement {
  const $list = Column.make();
  $list.style.padding = "8px";
  $list.style.gap = "4px";

  for (const tag of EXAMPLE_TAGS) {
    const $item = Typography.p(`${tag.emoji} ${tag.name}`, "small");
    $item.style.padding = "8px 12px";
    $item.style.cursor = "pointer";
    $item.style.borderRadius = "4px";
    $item.addEventListener("pointerenter", () => {
      $item.style.background = "var(--bg-surface-light)";
    });
    $item.addEventListener("pointerleave", () => {
      $item.style.background = "";
    });
    $item.addEventListener("click", () => onSelect(tag));
    $list.appendChild($item);
  }

  return $list;
}

export class TagSelectorStoryBook extends Storybook.Default {
  title(): string {
    return "Tag Selector";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default (Editable)",
        render: () => {
          const $selector = TagSelector.create<ExampleTag>(
            (tag) => console.log("Selected tag:", tag.name),
            makeTagList,
            "Add tags",
          );
          $selector.bind(EXAMPLE_TAGS[0], true);
          return $selector;
        },
      },
      {
        title: "Disabled (Read-only)",
        render: () => {
          const $selector = TagSelector.create<ExampleTag>(
            (tag) => console.log("Selected tag:", tag.name),
            makeTagList,
            "Add tags",
          );
          $selector.bind(EXAMPLE_TAGS[1], false);
          return $selector;
        },
      },
    ];
  }
}
