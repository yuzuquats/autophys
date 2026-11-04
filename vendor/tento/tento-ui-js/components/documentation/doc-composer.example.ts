import { Storybook } from "../../ui/storybook";
import { DocComposer } from "./doc-composer";

// Storybook for the doc composer — a textarea plus Cancel / Comment buttons,
// rendered inline inside the card (never at fixed coords). The card in a commit
// note shows the component only.

function $composer(vm: DocComposer.ViewModel): DocComposer {
  const $el = DocComposer.make();
  $el.bind(vm);
  return $el;
}

export class DocComposerStoryBook extends Storybook.Default {
  title(): string {
    return "DocComposer (std-doc-composer)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Composer",
        render: () =>
          $composer({
            onCancel: () => {},
            onSubmit: (_body: string) => {},
          }),
      },
    ];
  }
}

// → review-notes would cycle), so name it from here at module scope.
