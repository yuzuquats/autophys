import { Storybook } from "../../ui/storybook";
import { SelectToolbar } from "./doc-select-toolbar";

// Storybook for the selection mini-toolbar — the floating "💬 Comment" button
// shown over a text selection. Rendered inline in the card (positionAt is not
// called), so it lays out in flow rather than escaping to fixed coordinates.

function $toolbar(vm: SelectToolbar.ViewModel): SelectToolbar {
  const $el = SelectToolbar.make();
  $el.bind(vm);
  return $el;
}

export class SelectToolbarStoryBook extends Storybook.Default {
  title(): string {
    return "SelectToolbar (std-doc-select-toolbar)";
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Comment button", render: () => $toolbar({ onComment: () => {} }) },
    ];
  }
}

// → review-notes would cycle), so name it from here at module scope.
