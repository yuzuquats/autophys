import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { BottomSheet } from "./bottom-sheet";

function $content(): HTMLElement {
  const $c = Column.make();
  $c.style.gap = "8px";
  $c.appendChild(Typography.p("Share this sheet"));
  for (const label of ["Copy link", "Email", "Message"]) {
    $c.appendChild(Button.makeWith(label, { type: "secondary", onClick: () => {} }));
  }
  return $c;
}

/** A sheet is nothing until shown, so the example is its trigger. */
function $trigger(label: string, props: BottomSheet.Props): HTMLElement {
  const $btn = Button.makeWith(label, { type: "secondary", onClick: () => { const $s = BottomSheet.show(props); void $s; } });
  return $btn;
}

export class BottomSheetStoryBook extends Storybook.Default {
  title(): string {
    return "Bottom Sheet";
  }

  tags(): string[] {
    return ["std-bottom-sheet"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "No actions: modal surface receives focus", render: () => $trigger("Read sheet", { $content: () => Typography.p("A reading surface with no action in its body."), snapPoints: [0.35], initialSnap: 0, dismissible: true, onDismiss: null, label: "Read" }) },
      { title: "Nondismissible backdrop: caller-owned programmatic exit", render: () => {
        let sheet: Option<BottomSheet>;
        return Button.makeWith("Open controlled sheet", { type: "secondary", onClick: () => {
          sheet = BottomSheet.show({ $content: () => Button.makeWith("Finish", { onClick: () => sheet?.dismiss() }), snapPoints: [0.5], initialSnap: 0, dismissible: false, onDismiss: null, label: "Controlled sheet" });
        } });
      } },
      { title: "Two snap points (drag the handle; arrows on it move; Escape closes)", render: () => $trigger("Open sheet", { $content, snapPoints: [0.35, 0.8], initialSnap: 0, dismissible: true, onDismiss: null, label: "Share" }) },
    ];
  }
}
