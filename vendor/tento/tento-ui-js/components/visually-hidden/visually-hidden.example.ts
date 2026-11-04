import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { VisuallyHidden } from "./visually-hidden";

/** The component is invisible by definition, so each example is the one host
 * that makes its effect observable: a button whose visible text is a glyph and
 * whose accessible name comes from the hidden child. */
function $labelled(): HTMLElement {
  const $btn = Button.makeWith("✕", { type: "secondary", onClick: () => {} });
  const $hidden = VisuallyHidden.makeWith({ focusable: false });
  $hidden.textContent = "Close";
  $btn.appendChild($hidden);
  return $btn;
}

function $skipLink(): HTMLElement {
  const $hidden = VisuallyHidden.makeWith({ focusable: true });
  const $a = document.createElement("a");
  $a.href = "#main";
  $a.textContent = "Skip to content (Tab to reveal)";
  $hidden.appendChild($a);
  return $hidden;
}

export class VisuallyHiddenStoryBook extends Storybook.Default {
  title(): string {
    return "Visually Hidden";
  }

  tags(): string[] {
    return ["std-visually-hidden"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Accessible name for a glyph button", render: () => $labelled() },
      { title: "Skip link, revealed on focus", render: () => $skipLink() },
    ];
  }
}
