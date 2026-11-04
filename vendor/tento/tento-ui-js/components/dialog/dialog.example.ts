import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Dialog } from "./dialog";

/** A dialog is nothing until shown, so each example is the trigger that shows
 * it; the dialog is what appears. */
function $trigger(label: string, props: Dialog.Props): HTMLElement {
  const $btn = Button.makeWith(label, {
    type: "secondary",
    onClick: () => {
      const $d = Dialog.show({
        ...props,
        actions: props.actions.map((a) => ({ ...a, onClick: () => { a.onClick(); $d.dismiss(); } })),
      });
    },
  });
  return $btn;
}

export class DialogStoryBook extends Storybook.Default {
  title(): string {
    return "Dialog";
  }

  tags(): string[] {
    return ["std-dialog"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Dialog (Escape or backdrop dismisses; focus returns)",
        render: () => $trigger("Open dialog", { title: "Rename sheet", description: "The name shows in the sidebar and in shared links.", $body: null, actions: [{ label: "Cancel", type: "secondary", onClick: () => {} }, { label: "Rename", type: "primary", onClick: () => {} }], alert: false, dismissible: true, onDismiss: null }),
      },
      {
        title: "Alert dialog (focus lands on the action; not dismissible)",
        render: () => $trigger("Open alert", { title: "Delete 12 rows?", description: "This cannot be undone.", $body: null, actions: [{ label: "Keep", type: "secondary", onClick: () => {} }, { label: "Delete", type: "destructive", onClick: () => {} }], alert: true, dismissible: false, onDismiss: null }),
      },
    ];
  }
}
