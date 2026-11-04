import { TokenInput } from "./token";

export function verifyTokenInput(): string[] {
  const changes: string[][] = [];
  const $field = TokenInput.makeWith({ tokens: [], placeholder: null, onChange: (tokens) => changes.push(tokens), separators: null, validate: null, label: "Tokens" });
  const $next = document.createElement("button");
  $next.textContent = "Next";
  document.body.append($field, $next);
  const $input = $field.shadowRoot?.querySelector("input");
  if (!($input instanceof HTMLInputElement)) throw new Error("Token input is missing");
  try {
    $input.focus(); $input.value = "draft"; $next.focus();
    if (document.activeElement !== $next || changes[0]?.[0] !== "draft") throw new Error("Blur must commit and preserve the destination focus");
    $input.focus(); $input.value = "second";
    $input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    if ($field.shadowRoot?.activeElement !== $input || changes[1]?.join(",") !== "draft,second") throw new Error("Enter must commit and keep the editor focused");
    return ["blur commits without taking focus back", "Enter commits while retaining editor focus"];
  } finally { $field.remove(); $next.remove(); }
}
