import { NaiveDate } from "@tento-chrono";
import { ScrollEngine } from "@tento-scroll/engine/scroll-engine";
import { ColumnIndex } from "./column-index";

export class SheetNavigator {
  #mapper: Option<ColumnIndex.Mapper<any>>;

  constructor(readonly scrollEngine: ScrollEngine<any>) {}

  setMapper(mapper: ColumnIndex.Mapper<any>) {
    this.#mapper = mapper;
  }

  get mapper(): ColumnIndex.Mapper<any> {
    return this.#mapper!;
  }

  // toggleSnap(force: boolean = this.scrollEngine.snappingEnabled): boolean {
  //   const scrollManager = this.scrollEngine;
  //   scrollManager.snappingEnabled = force;
  //   if (scrollManager.snappingEnabled) {
  //     scrollManager.snapToNearestIndex();
  //   }
  //   return scrollManager.snappingEnabled;
  // }

  /**
   * Current top-of-viewport index. `null` when the scroll
   * engine hasn't initialized its viewport yet — first-load
   * structural rebinds can fire before the viewport binds,
   * and consumers (e.g. `bindSheet`'s `unchangedSheetIndex`)
   * already treat the result as `Option<number>`.
   */
  currentIndex(): Option<number> {
    return this.scrollEngine.viewport?.visible?.indexRange.start ?? null;
  }

  currentDate(): Option<NaiveDate> {
    const start = this.currentIndex();
    if (start == null) return null;
    const key = this.#mapper?.resolveKey(ColumnIndex.Key.fromIndex(start));
    if (!key) return null;

    if (key.type === "custom") {
      return key.start();
    } else {
      return key.pd.start;
    }
  }

  /**
   * A navigator jump moves the view and nothing else: the index space is
   * unchanged, so the map stands and the bound content stands with it. The
   * `navigator` source is what makes `bindIndex` emit the destination range
   * ahead of the scroll settling.
   */
  private static readonly REVEAL: ScrollEngine.IndexBind = {
    kind: "reveal",
    at: {
      position: "start",
      scrollBehavior: "smooth",
      useNativeScrollTo: false,
    },
    viewportChangeSource: "navigator",
  };

  jumpTo(key: ColumnIndex.Key) {
    const { index } = this.mapper.indexOfKey(key);
    this.scrollEngine.bindIndex(index, SheetNavigator.REVEAL);
  }

  back(count: number = 1) {
    const scrollManager = this.scrollEngine;
    scrollManager.bindIndex(
      scrollManager.viewport.visible.indexStartOptimistic - count,
      SheetNavigator.REVEAL,
    );
  }

  forward(count: number = 1) {
    this.back(-count);
  }
}
