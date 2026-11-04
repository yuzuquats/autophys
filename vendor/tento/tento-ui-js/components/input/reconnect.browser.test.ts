import { CodeInput } from "./code-input";
import { ColorField } from "./color-field";
import { TableFooter } from "../table/table-footer";

export async function verifyInputReconnects(): Promise<string[]> {
  const results: string[] = [];
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  for (const cycles of [20, 100]) {
    let codeCalls = 0, colorCalls = 0, pageCalls = 0;
    const code = CodeInput.makeWith({ onChange: () => codeCalls++ });
    const color = ColorField.makeWith({ value: "#000000", onChange: () => colorCalls++ });
    const footer = TableFooter.make().bind({ totalItems: 100, onPageSizeChange: () => pageCalls++ });
    for (let i = 0; i < cycles; i++) { document.body.append(code, color, footer); code.remove(); color.remove(); footer.remove(); }
    document.body.append(code, color, footer);
    const digit = code.shadowRoot!.querySelector("input")!;
    digit.value = "3"; digit.dispatchEvent(new Event("input"));
    const input = color.shadowRoot!.querySelector("input")!;
    input.value = "#123456"; input.dispatchEvent(new Event("input"));
    const select = footer.shadowRoot!.querySelector("select")!;
    select.value = "10"; select.dispatchEvent(new Event("change"));
    const counts = [codeCalls, colorCalls, pageCalls];
    const valid = counts.every(n => n === 1) && code.getValue() === "3" && color.value === "#123456" && footer.shadowRoot!.querySelector("#item-count")!.textContent === "1-10 of 100";
    codeCalls = 0; let completed = 0; code.onComplete = () => completed++;
    const clipboardData = new DataTransfer(); clipboardData.setData("text", "123456");
    digit.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
    const pasted = codeCalls === 1 && completed === 1 && code.getValue() === "123456" &&
      code.shadowRoot!.activeElement === code.shadowRoot!.querySelectorAll("input")[5];
    CodeInput.recycle(code); ColorField.recycle(color); TableFooter.recycle(footer); await frame();
    if (!valid || !pasted) throw new Error(`${cycles} reconnects callback/visible value/paste failure: ${counts.join(",")}`);
    for (let i = 0; i < cycles; i++) {
      let old = 0, current = 0;
      const reused = CodeInput.makeWith({ onChange: () => old++ });
      const reusedColor = ColorField.makeWith({ value: "#000000", onChange: () => old++ });
      const reusedFooter = TableFooter.make().bind({ totalItems: 100, onPageSizeChange: () => old++ });
      if (reused !== code || reusedColor !== color || reusedFooter !== footer || reused.getValue() !== "") throw new Error("Input actual pooled reuse must start with replacement values");
      reused.bind({ onChange: () => current++ });
      reusedColor.bind({ value: "#000000", onChange: () => current++ });
      reusedFooter.bind({ totalItems: 100, onPageSizeChange: () => current++ });
      document.body.append(reused, reusedColor, reusedFooter);
      const rd = reused.shadowRoot!.querySelector("input")!; rd.value = "4"; rd.dispatchEvent(new Event("input"));
      const rc = reusedColor.shadowRoot!.querySelector("input")!; rc.value = "#654321"; rc.dispatchEvent(new Event("input"));
      const rs = reusedFooter.shadowRoot!.querySelector("select")!; rs.value = "10"; rs.dispatchEvent(new Event("change"));
      if (old !== 0 || current !== 3 || reusedColor.value !== "#654321" || rs.value !== "10" ||
        reused.shadowRoot!.activeElement !== reused.shadowRoot!.querySelectorAll("input")[1]) throw new Error("Input pooled callback/value/focus ownership");
      CodeInput.recycle(reused); ColorField.recycle(reusedColor); TableFooter.recycle(reusedFooter); await frame();
    }
    results.push(`${cycles} reconnects and ${cycles} actual pooled replacements`);
  }
  return results;
}
