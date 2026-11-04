import { Storybook } from "../../ui/storybook";
import { TokenInput } from "./token";

function $field(validate: Option<(s: string) => boolean>): TokenInput {
  let tokens = ["alice@lona.so", "bob@lona.so"];
  const $t = TokenInput.make();
  const rebind = () => $t.bind({ tokens, placeholder: "Add an address", onChange: (v) => { tokens = v; rebind(); }, separators: null, validate, label: "Recipients" });
  rebind();
  return $t;
}

export class TokenInputStoryBook extends Storybook.Default {
  title(): string {
    return "Token Input";
  }

  tags(): string[] {
    return ["std-token-input"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Enter or comma commits; Backspace on empty removes the last", render: () => $field(null) },
      { title: "Validated (must contain @)", render: () => $field((s) => s.includes("@")) },
    ];
  }
}
