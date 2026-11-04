import { SearchIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { EmptyState } from "./empty-state";

export class EmptyStateStoryBook extends Storybook.Default {
  title(): string {
    return "Empty State";
  }

  tags(): string[] {
    return ["std-empty-state"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Icon, description, two actions",
        render: () =>
          EmptyState.makeWith({
            title: "No results",
            description: "Nothing matches that search. Try fewer words, or clear the filters.",
            icon: SearchIcon,
            $illustration: null,
            primary: { label: "Clear filters", onClick: () => {} },
            secondary: { label: "New search", onClick: () => {} },
            announce: true,
          }),
      },
      {
        title: "Title only",
        render: () => EmptyState.makeWith({ title: "Nothing here yet", description: null, icon: null, $illustration: null, primary: null, secondary: null, announce: false }),
      },
    ];
  }
}
