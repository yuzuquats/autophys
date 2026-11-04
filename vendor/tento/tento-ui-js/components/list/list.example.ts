import { Storybook } from "@tento-ui/ui/storybook";
import { List } from "./list";
import { ListCellLayout } from "./list-cell-layout";
import { Round } from "../round";

export class ListStoryBook extends Storybook.Default {
  title(): string {
    return "List";
  }

  tags(): string[] {
    return ["std-list"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "List",
        render: () => {
          const $cells = [
            "Drag to reorder me",
            "Apple",
            "Blueberry",
            "Carrot",
            "Dragon Fruit",
            "Elderberry",
            "Fig",
            "Honeydew",
            "Jackfruit",
          ].map((title) => ListCellLayout.makeText(title));
          return Round.makeWithContent(
            List.make().bind($cells, () => true),
            {
              ...Round.Props.MODAL,
              bg: "var(--yellow)",
              radius: 32,
            },
          ).assignStyles({
            padding: "8px",
            maxWidth: "200px",
          });
        },
      },
      {
        title: "Empty List",
        render: () => {
          return Round.makeWithContent(
            List.make().bind([], () => true),
            {
              ...Round.Props.MODAL,
              bg: "var(--yellow)",
              radius: 32,
            },
          ).assignStyles({
            padding: "8px",
            maxWidth: "200px",
          });
        },
      },
    ];
  }
}
