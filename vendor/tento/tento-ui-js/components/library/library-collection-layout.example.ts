import "./library-collection-layout";
import "./library-filter-sort-row";

import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { LibraryCollectionLayout } from "./library-collection-layout";
import { LibraryExampleFixtures as Fx } from "./library-example-fixtures";
import { LibraryFilterSortRow } from "./library-filter-sort-row";

export class LibraryCollectionLayoutStoryBook extends Storybook.Default {
  tags(): string[] { return ["std-library-collection-layout"]; }

  title(): string { return "Library collection layout"; }

  examples(): Storybook.Example[] {
    return [360, 960].map((width) => ({
      title: `${width}px · search, filter row and card grid`,
      render: () => {
        const $layout = LibraryCollectionLayout.make();
        $layout.style.width = `${width}px`;
        $layout.style.maxWidth = "100%";
        const $status = LibraryFilterSortRow.make();
        $status.slot = "status";
        const $grid = Fx.$grid();
        const $empty = Typography.p("Nothing matches. Change the search.");
        $empty.slot = "empty";
        $empty.style.color = "var(--text-ter)";
        let query = "";
        let order = "recent";
        const render = (): void => {
          const items = Fx.ITEMS.filter((item) => Fx.matches(item, query));
          if (order === "title") items.sort((a, b) => a.title.localeCompare(b.title));
          $status.bind({
            resultText: `Found ${items.length} ${items.length === 1 ? "item" : "items"}`,
            controls: [{
              id: "sort",
              label: "Sort",
              value: order,
              options: [
                { value: "recent", label: "Recently edited" },
                { value: "title", label: "Title A–Z" },
              ],
              onChange: (value) => { order = value; render(); },
            }],
          });
          Fx.fillGrid($grid, items, null);
          $empty.hidden = items.length > 0;
        };
        $layout.append(
          Fx.$search("Search items", (text) => { query = text; render(); }),
          $status,
          $grid,
          $empty,
        );
        render();
        return $layout;
      },
    }));
  }
}
