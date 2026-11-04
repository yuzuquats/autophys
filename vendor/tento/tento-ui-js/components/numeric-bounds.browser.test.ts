import { Pagination } from "./pagination/pagination";
import { Skeleton } from "./skeleton/skeleton";
import { PageIndiciatorDots } from "./page-indicator-dots";

const check = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const rejects = (run: () => void): void => {
  try { run(); } catch (error) { if (error instanceof RangeError) return; throw error; }
  throw new Error("Expected RangeError before replacing the current binding");
};

export async function verifyNumericBounds(): Promise<string[]> {
  const $pagination = Pagination.make();
  const $skeleton = Skeleton.make();
  const $dots = PageIndiciatorDots.make();
  document.body.append($pagination, $skeleton, $dots);
  try {
    let changed = 0;
    const props: Pagination.Props = { page: 5, pageCount: 10, siblings: 1, labels: null, onChange: page => { changed = page; } };
    $pagination.bind(props);
    const $nav = $pagination.shadowRoot!.querySelector("nav")!;
    const $current = $nav.querySelector('[aria-current="page"]');
    check(JSON.stringify(Pagination.window(5, 10, 1)) === '[1,"…",4,5,6,"…",10]', "Ordinary pagination window changed");
    // Invalid-but-finite first: running this regression against old source
    // fails promptly, before reaching the historic infinite-loop inputs.
    rejects(() => $pagination.bind({ ...props, siblings: -1 }));
    for (const value of [NaN, Infinity, -Infinity, 1e16, .5]) {
      rejects(() => $pagination.bind({ ...props, page: value }));
      rejects(() => $pagination.bind({ ...props, pageCount: value }));
      rejects(() => $pagination.bind({ ...props, siblings: value }));
    }
    rejects(() => $pagination.bind({ ...props, pageCount: 10000, siblings: 10000 }));
    check($nav.querySelector('[aria-current="page"]') === $current, "Invalid pagination replaced live buttons");
    $nav.querySelector<HTMLButtonElement>('button[data-page="6"]')!.click();
    check(changed === 6, "Invalid pagination replaced the previous callback");
    check(Pagination.window(1, 10, Number.MAX_SAFE_INTEGER).length === 10, "Sibling iteration was not clamped to actual pages");
    check(Pagination.window(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1).at(-1) === Number.MAX_SAFE_INTEGER, "Safe integer upper edge lost progress");
    check(Pagination.window(1, 0, 0).length === 0, "Zero-page domain should be empty");
    check(Pagination.window(1, 1000, 1000).length === Pagination.maxVisiblePages, "Pagination supported cardinality edge");

    const skeleton: Skeleton.Props = { shape: "text", lines: 3, widthPx: 120, heightPx: null, animated: true };
    $skeleton.bind(skeleton);
    const $firstBar = $skeleton.shadowRoot!.querySelector(".bar");
    for (const value of [-1, NaN, Infinity, -Infinity, .5, 1e16, Skeleton.maxLines + 1]) {
      rejects(() => $skeleton.bind({ ...skeleton, lines: value, widthPx: 999 }));
    }
    check($skeleton.shadowRoot!.querySelector(".bar") === $firstBar && $skeleton.style.getPropertyValue("--skeleton-width") === "120px", "Invalid skeleton changed existing content/styles");
    $skeleton.bind({ ...skeleton, lines: 0 });
    check($skeleton.shadowRoot!.querySelectorAll(".bar").length === 1, "Zero lines lost the existing one-line minimum");
    $skeleton.bind({ ...skeleton, lines: Skeleton.maxLines });
    check($skeleton.shadowRoot!.querySelectorAll(".bar").length === Skeleton.maxLines, "Skeleton supported cardinality edge");

    let selected = -1;
    $dots.onChange = index => { selected = index; };
    $dots.bind(0, 3, () => "red");
    await frame();
    const $firstDot = $dots.shadowRoot!.querySelector<HTMLElement>(".page-indicator-dot")!;
    for (const value of [-1, NaN, Infinity, -Infinity, .5, 1e16, PageIndiciatorDots.maxCount + 1]) {
      rejects(() => $dots.bind(0, value, () => "blue"));
    }
    await frame();
    check($dots.shadowRoot!.querySelector(".page-indicator-dot") === $firstDot && $firstDot.style.getPropertyValue("--dot-bg-color") === "red", "Invalid indicator changed current dots");
    $firstDot.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await frame();
    check(selected === 0, "Invalid indicator broke current keyboard selection");
    $dots.bind(0, 0);
    await frame();
    check($dots.shadowRoot!.querySelectorAll(".page-indicator-dot").length === 0, "Zero indicators must remain valid");
    $dots.bind(0, PageIndiciatorDots.maxCount);
    await frame();
    check($dots.shadowRoot!.querySelectorAll(".page-indicator-dot").length === PageIndiciatorDots.maxCount, "Indicator supported cardinality edge");
    return ["Pagination rejects invalid inputs before mutation and clamps work to the page domain", "Skeleton rejects invalid cardinality before changing content or styles", "PageIndicator rejects invalid cardinality while preserving keyboard selection", "Zero, maximum cardinality and safe-integer boundary contracts"];
  } finally {
    $pagination.remove(); $skeleton.remove(); $dots.remove();
  }
}
