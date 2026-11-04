import { Storybook } from "../ui/storybook";
import { EditableText } from "./editable-text";

export class EditableTextStoryBook extends Storybook.Default {
  title(): string {
    return "Editable Text";
  }

  tags(): string[] {
    return ["std-editable-text"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Editable Text",
        render: () => {
          const $c = EditableText.make();
          $c.style.width = "200px";
          $c.bind(null, "Type Here");
          $c.enableEditing();
          return $c;
        },
      },
    ];
  }
}
