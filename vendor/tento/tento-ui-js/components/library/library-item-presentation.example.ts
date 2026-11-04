import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { LibraryExampleFixtures as Fx } from "./library-example-fixtures";
import { LibraryItemPresentation } from "./library-item-presentation";

export class LibraryItemPresentationStoryBook extends Storybook.Default {
  tags(): string[] { return ["std-library-item-presentation"]; }

  title(): string { return "Library item presentation"; }

  examples(): Storybook.Example[] {
    return [{
      title: "Open a card: one surface slides up, the card stays in the grid",
      render: () => {
        const $page = document.createElement("div");
        $page.style.width = "560px";
        $page.style.maxWidth = "100%";
        const $grid = Fx.$grid();
        // A grid lays its tiles out absolutely and sizes itself; as a block
        // it gives the story card that height (the collection layout's items
        // slot does the same).
        $grid.removeAttribute("slot");
        $grid.style.display = "block";
        const open = (item: Fx.Item): void => {
          const $view = LibraryItemPresentation.make();
          const $content = Column.make();
          $content.assignStyles({ padding: "32px", gap: "16px", background: "var(--bg)", maxWidth: "640px" });
          const $source = [...$grid.children].find(($tile) =>
            $tile.textContent?.includes(item.title)
          ) as Option<HTMLElement>;
          const close = async (): Promise<void> => {
            await $view.dismiss();
            ($source?.querySelector("[role=button]") as Option<HTMLElement>)?.focus();
          };
          const $title = Typography.h2(item.title);
          $title.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px" });
          const $body = Typography.p(item.body);
          $body.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", "--line-height-ratio": "1.5", color: "var(--text-sec)" });
          const $close = Button.makeWith("Close", { type: "secondary", onClick: close });
          $close.style.alignSelf = "start";
          $content.append($title, $body, $close);
          $view.bind({ $source: $source ?? null, $content, label: item.title, onDismiss: close }).reveal();
        };
        Fx.fillGrid($grid, Fx.ITEMS, open);
        $page.append($grid);
        return $page;
      },
    }];
  }
}
