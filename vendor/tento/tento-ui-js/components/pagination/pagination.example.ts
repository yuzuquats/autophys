import { Storybook } from "../../ui/storybook";
import { Pagination } from "./pagination";

function $pager(page: number, pageCount: number, siblings: Option<number>): Pagination {
  let current = page;
  const $p = Pagination.make();
  const rebind = () => $p.bind({ page: current, pageCount, siblings, onChange: (n) => { current = n; rebind(); }, labels: null });
  rebind();
  return $p;
}

export class PaginationStoryBook extends Storybook.Default {
  title(): string {
    return "Pagination";
  }

  tags(): string[] {
    return ["std-pagination"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Page 5 of 20", render: () => $pager(5, 20, null) },
      { title: "First page of 3 (no ellipsis, prev disabled)", render: () => $pager(1, 3, null) },
      { title: "Wide window (siblings 2)", render: () => $pager(10, 40, 2) },
    ];
  }
}
