import { $$ } from "../fastdom";
import { TextArea } from "./text-area/text-area";
import { OverflowList } from "./overflow-list/overflow-list";
import { HoverCard } from "./hover-card/hover-card";
import { FileInput } from "./file-input/file-input";

const check = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function verifyRebindingControls(): Promise<string[]> {
  const results: string[] = [];
  let $text = TextArea.make();
  const $list = OverflowList.make();
  const $trigger = document.createElement("button");
  const $outside = document.createElement("button");
  const $hover = HoverCard.make();
  const $file = FileInput.make();
  const $fixture = document.createElement("div");
  $fixture.style.width = "200px";
  document.body.append($fixture);
  $fixture.append($text, $trigger, $outside, $file);
  try {
    const textProps: TextArea.Props = {
      value: "one\ntwo\nthree\nfour\nfive", label: "Notes", placeholder: null, rows: 2,
      autoGrow: true, maxLength: null, helper: null, error: null, disabled: false,
      required: false, name: null, onChange: () => {}, onBlur: null,
    };
    const textarea = () => $text.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!;
    $text.bind(textProps);
    $text.bind({ ...textProps, autoGrow: false });
    await frame();
    check(textarea().style.height === "", "TextArea superseded measure restored auto-grow height");
    $text.bind(textProps);
    $$.measure(() => $text.bind({ ...textProps, autoGrow: false }));
    await frame();
    check(textarea().style.height === "", "TextArea superseded mutation restored auto-grow height");
    $text.bind(textProps);
    $text.remove();
    await frame();
    $fixture.append($text);
    await frame();
    check(parseFloat(textarea().style.height) > 0, "TextArea reconnect did not resume live auto-grow binding");
    const $previous = $text;
    $text.bind(textProps);
    TextArea.recycle($text);
    await frame();
    $text = TextArea.make();
    check($text === $previous, "TextArea test must exercise actual pool reuse");
    $text.bind({ ...textProps, autoGrow: false });
    $fixture.append($text);
    await frame();
    check(textarea().style.height === "", "TextArea pooled predecessor changed successor height");
    $text.style.setProperty("--text-ter", "rgb(3, 2, 1)");
    for (const maxLength of [100, 200]) {
      $text.bind({ ...textProps, autoGrow: false, maxLength });
      const $count = $text.shadowRoot!.querySelector<HTMLElement>(".count")!;
      const countStyle = getComputedStyle($count);
      check(!$count.hidden && countStyle.color === "rgb(3, 2, 1)" && parseFloat(countStyle.marginLeft) > 0, "TextArea character count lost styling after bind");
      check(textarea().getAttribute("aria-describedby")?.split(" ").includes($count.id) === true, "TextArea character count description is stale after rebind");
    }
    results.push("TextArea guards both queued growth phases and preserves reconnect/pool bindings");

    const listProps = (count: number, width: number): OverflowList.Props => ({
      items: Array.from({ length: count }, (_, index) => ({
        id: String(index), label: `Item ${index}`, onSelect: null,
        $render: () => {
          const $item = document.createElement("span");
          $item.style.cssText = `flex: 0 0 ${width}px; width: ${width}px;`;
          $item.textContent = `Item ${index}`;
          return $item;
        },
      })), overflowLabel: null,
    });
    const more = () => $list.shadowRoot!.querySelector<HTMLElement>("#more")!;
    const hiddenCount = () => $list.shadowRoot!.querySelectorAll("#items > [hidden]").length;
    $list.bind(listProps(3, 80));
    await frame();
    $fixture.append($list);
    await frame();
    check(hiddenCount() === 2 && !more().hidden && more().textContent === "+2", "OverflowList cached detached zero widths instead of folding constrained items");
    $list.style.display = "none";
    $list.bind(listProps(3, 80));
    await frame();
    $list.style.removeProperty("display");
    await frame();
    await frame();
    check(hiddenCount() === 2 && !more().hidden, "OverflowList cached hidden zero widths after becoming visible");
    $list.remove();
    $fixture.style.width = "400px";
    $fixture.append($list);
    await frame();
    check(hiddenCount() === 0 && more().hidden, "OverflowList reconnect did not recompute available geometry");
    $fixture.style.width = "200px";
    $list.bind(listProps(3, 80));
    $$.measure(() => $list.bind(listProps(2, 20)));
    await frame();
    check(hiddenCount() === 0 && more().hidden && $list.shadowRoot!.querySelector("#items")!.childElementCount === 2, "OverflowList old queued layout changed rebound items");
    $list.style.setProperty("--overflow-list-gap", "6px");
    for (const available of [90, 72]) {
      $fixture.style.width = `${available}px`;
      $list.bind(listProps(3, 20));
      await frame();
      const $row = $list.shadowRoot!.querySelector<HTMLElement>("#row")!;
      const $items = [...$list.shadowRoot!.querySelectorAll<HTMLElement>("#items > *")];
      check(hiddenCount() === 0 && more().hidden, `OverflowList reserved an unnecessary menu when all items fit in ${available}px`);
      check($row.getBoundingClientRect().width === available && parseFloat(getComputedStyle($row).columnGap) === 6 && $items.every($item => $item.getBoundingClientRect().width === 20), "OverflowList fit-all test requires measured fixed geometry");
    }
    $fixture.style.width = "200px";
    $list.bind(listProps(3, 80));
    await frame();
    check(hiddenCount() === 2 && !more().hidden && more().textContent === "+2", "OverflowList stopped reserving its menu when items genuinely overflow");
    results.push("OverflowList measures after attachment/visibility and retires rebound layout work");

    const $openedLink = document.createElement("a");
    $openedLink.href = "#details";
    $openedLink.textContent = "Read details";
    $trigger.textContent = "Details";
    $outside.textContent = "Outside";
    $hover.bind({
      $content: () => $openedLink, openDelayMs: 0, closeDelayMs: 30, placement: null,
    });
    $trigger.append($hover);
    $trigger.focus();
    await wait(60);
    await frame();
    check($openedLink.isConnected && !$trigger.contains($openedLink), "HoverCard test requires escaped card content");
    $openedLink.focus();
    check($openedLink.matches(":focus"), "HoverCard test requires actual keyboard focus in card");
    $trigger.dispatchEvent(new PointerEvent("pointerleave"));
    await wait(80);
    check($openedLink.isConnected && $openedLink.matches(":focus"), "HoverCard removed focused escaped card after trigger focusout");
    $outside.focus();
    await wait(80);
    check(!$openedLink.isConnected, "HoverCard did not close after focus left trigger and card");
    results.push("HoverCard retains keyboard focus across trigger/card and closes on exit");

    const fileProps: FileInput.Props = { accept: null, multiple: false, label: "Upload", hint: "Choose a document", dropZone: false, onFiles: () => {}, error: null };
    $file.style.setProperty("--text-ter", "rgb(1, 2, 3)");
    for (const multiple of [false, true]) {
      $file.bind({ ...fileProps, multiple });
      const $input = $file.shadowRoot!.querySelector<HTMLInputElement>('input[type="file"]')!;
      const $hint = $file.shadowRoot!.querySelector<HTMLElement>(`[id="${$input.id}-hint"]`)!;
      const inputStyle = getComputedStyle($input);
      check(inputStyle.position === "absolute" && inputStyle.width === "1px" && inputStyle.height === "1px" && inputStyle.opacity === "0" && inputStyle.pointerEvents === "none", "FileInput native input lost hidden styling after bind");
      check(getComputedStyle($hint).color === "rgb(1, 2, 3)" && getComputedStyle($hint).getPropertyValue("--margin-top").trim() === "0px", "FileInput hint lost styling after bind");
      check($file.shadowRoot!.querySelector("#button")!.getAttribute("aria-describedby") === $hint.id, "FileInput rebound hint relationship is stale");
    }
    $file.bind({ ...fileProps, hint: null });
    check(getComputedStyle($file.shadowRoot!.querySelector<HTMLElement>(".hint")!).display === "none", "FileInput omitted hint is visible after rebind");
    results.push("FileInput keeps native input hidden and hint styling/description linked across rebinds");
    return results;
  } finally {
    $fixture.remove();
    TextArea.recycle($text);
    OverflowList.recycle($list);
    HoverCard.recycle($hover);
    FileInput.recycle($file);
    await frame();
  }
}
