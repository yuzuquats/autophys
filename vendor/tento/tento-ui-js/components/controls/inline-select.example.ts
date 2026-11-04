import { LonaIcons } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { InlineSelect } from "./inline-select";

const PRIORITY_ITEMS: InlineSelect.Item<string>[] = [
  { id: "urgent", label: "Urgent", data: "urgent" },
  { id: "high", label: "High", data: "high", selected: true },
  { id: "medium", label: "Medium", data: "medium" },
  { id: "low", label: "Low", data: "low" },
];

const FRUIT_ITEMS: InlineSelect.Item<string>[] = [
  { id: "apple", label: "Apple", data: "apple" },
  { id: "banana", label: "Banana", data: "banana" },
  { id: "blueberry", label: "Blueberry", data: "blueberry" },
  { id: "cherry", label: "Cherry", data: "cherry" },
  { id: "grape", label: "Grape", data: "grape" },
  { id: "kiwi", label: "Kiwi", data: "kiwi" },
  { id: "lemon", label: "Lemon", data: "lemon" },
  { id: "mango", label: "Mango", data: "mango", selected: true },
  { id: "orange", label: "Orange", data: "orange" },
  { id: "peach", label: "Peach", data: "peach" },
  { id: "pear", label: "Pear", data: "pear" },
  { id: "strawberry", label: "Strawberry", data: "strawberry" },
];

function makeCircleIcon(color: string): HTMLElement {
  const svg = `<svg viewBox="0 0 16 16" fill="${color}" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6"/></svg>`;
  return LonaIcons.make(svg, { sizePx: 14 });
}

const STATUS_ITEMS: InlineSelect.Item<string>[] = [
  { id: "todo", label: "To Do", icon: makeCircleIcon("var(--gray)"), data: "todo" },
  { id: "in-progress", label: "In Progress", icon: makeCircleIcon("var(--blue)"), data: "in-progress", selected: true },
  { id: "done", label: "Done", icon: makeCircleIcon("var(--green)"), data: "done" },
  { id: "cancelled", label: "Cancelled", icon: makeCircleIcon("var(--red)"), data: "cancelled" },
];

const PILL_PRIORITY_ITEMS: InlineSelect.Item<string>[] = [
  InlineSelect.Pill({ id: "urgent", label: "Urgent", data: "urgent", pillOptions: { background: "var(--red)", color: "var(--text-pri)" } }),
  InlineSelect.Pill({ id: "high", label: "High", data: "high", selected: true, pillOptions: { background: "var(--orange)", color: "var(--text-pri)" } }),
  InlineSelect.Pill({ id: "medium", label: "Medium", data: "medium", pillOptions: { background: "var(--yellow)", color: "var(--text-pri)" } }),
  InlineSelect.Pill({ id: "low", label: "Low", data: "low", pillOptions: { background: "var(--blue)", color: "var(--text-pri)" } }),
];

const DATE_ITEMS: InlineSelect.Item<string>[] = [
  InlineSelect.Text({ id: "today", label: "Today", data: "today", selected: true }),
  InlineSelect.Text({ id: "tomorrow", label: "Tomorrow", data: "tomorrow" }),
  InlineSelect.Text({ id: "pick", label: "Pick a date...", data: "pick" }),
  InlineSelect.Text({ id: "clear", label: "No date", data: "clear" }),
];

const MIXED_ITEMS: InlineSelect.Item<string>[] = [
  InlineSelect.Pill({ id: "urgent", label: "Urgent", data: "urgent", selected: true, pillOptions: { background: "var(--red)", color: "var(--text-pri)" } }),
  InlineSelect.Text({ id: "today", label: "Today", data: "today" }),
  InlineSelect.Text({ id: "tomorrow", label: "Tomorrow", data: "tomorrow" }),
  InlineSelect.Pill({ id: "none", label: "None", data: "none", pillOptions: { background: "var(--gray)", color: "var(--text-pri)" } }),
];

export class InlineSelectStoryBook extends Storybook.Default {
  title(): string {
    return "Inline Select";
  }

  tags(): string[] {
    return ["std-inline-select", "std-inline-select-panel"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: PRIORITY_ITEMS,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
      {
        title: "Searchable",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: FRUIT_ITEMS,
            searchable: true,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
      {
        title: "With Icons",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: STATUS_ITEMS,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
      {
        title: "Pill Items",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: PILL_PRIORITY_ITEMS,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
      {
        title: "Text with Auto-Section",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: DATE_ITEMS,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
      {
        title: "Mixed Pill and Text",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $select = InlineSelect.make() as InlineSelect<string>;
          $select.assignStyles({ width: "200px" });
          $select.bind({
            items: MIXED_ITEMS,
            onSelect: (item) => {
              $status.bindText(`Selected: ${item.label}`);
            },
          });
          return { $content: $select, $status };
        },
      },
    ];
  }
}
