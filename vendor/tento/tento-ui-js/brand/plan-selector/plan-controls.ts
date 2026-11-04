import { NativeUi } from "@tento-brand/src/native-ui";
import { Button } from "../../components/button/button";
import { ButtonGroupRow } from "../../components/button-group-row";
import { EditableText } from "../../components/editable-text";
import { Typography } from "../../ui/typography";

/** Native controls shared by pricing/promotion surfaces and direct specimens. */
export namespace PlanControls {
  export type ButtonProps = { text: string; variant: "primary" | "secondary" | "default"; plan?: boolean; disabled?: boolean };
  export const button = NativeUi.define<HTMLButtonElement, ButtonProps>({
    component: "button",
    create: () => document.createElement("button"),
    bind: (element, props) => {
      element.type = "button"; element.textContent = props.text;
      element.toggleAttribute("primary", props.variant === "primary");
      element.toggleAttribute("secondary", props.variant === "secondary");
      element.disabled = !!props.disabled; element.classList.toggle("plan-action", !!props.plan);
      return element;
    },
    storyStyles: [Button.$style, ".plan-action { height:40px; width:100%; } .plan-action:hover { --bg-btn:var(--blue); --fg-btn:white; }"],
  });
  export const promoInput = NativeUi.define<EditableText, { placeholder: string; value?: string }>({
    component: "input",
    create: () => EditableText.make(),
    bind: (element, props) => { element.bind(props.value ?? null, props.placeholder); element.classList.add("promo-input"); return element; },
    storyStyles: [".promo-input { padding:8px 12px; border:1px solid var(--divider); border-radius:4px; background:var(--bg); color:var(--text-pri); }"],
  });
  export function billingLabel(text: string, savings?: string): HTMLElement {
    const label = document.createElement("div"); label.classList.add("annual-label");
    label.style.cssText = "display:flex;flex-direction:row;align-items:baseline;gap:6px;align-self:center;justify-content:center;flex-wrap:wrap";
    label.append(Typography.small(text));
    if (savings) {
      const note = document.createElement("span"); note.className = "annual-savings small"; note.textContent = savings;
      note.style.color = "var(--text-sec)"; note.style.setProperty("--font-size", "var(--text-8px)"); label.append(note);
    }
    return label;
  }
  export const billingCycle = {
    make(selected: "monthly" | "annual" = "annual"): ButtonGroupRow<"monthly" | "annual"> {
      const group = ButtonGroupRow.make() as ButtonGroupRow<"monthly" | "annual">;
      return this.bind(group, selected);
    },
    bind(group: ButtonGroupRow<"monthly" | "annual">, selected: "monthly" | "annual") {
      group.dataset.brandComponent = "button"; group.style.minHeight = "40px";
      group.bind(selected, [
        { identifier:"monthly", label:billingLabel("Monthly") },
        { identifier:"annual", label:billingLabel("Annual", "Save 15%") },
      ]);
      return group;
    },
  };
}
