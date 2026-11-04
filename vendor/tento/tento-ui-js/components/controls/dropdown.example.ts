import { Storybook } from "../../ui/storybook";
import { Dropdown } from "./dropdown";

const DROPDOWN_ROWS: Dropdown.Row<number>[] = [
  {
    content: "Apple",
    data: 0,
  },
  {
    content: "Blueberry",
    data: 1,
  },
  {
    content: "Carrot",
    data: 2,
  },
  {
    content: "Orange",
    data: 3,
  },
  {
    content: "Cherry",
    data: 4,
  },
  {
    content: "Mango",
    data: 5,
  },
];

export class DropdownStoryBook extends Storybook.Default {
  title(): string {
    return "Dropdown";
  }

  tags(): string[] {
    return ["std-dropdown", "std-dropdown-container"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $dropdown = Dropdown.Legacy.make();
          $dropdown.bind({
            rows: DROPDOWN_ROWS,
          });
          return $dropdown;
        },
      },
    ];
  }
}
