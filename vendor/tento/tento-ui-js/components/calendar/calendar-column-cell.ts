import {
  DateFragment,
  Duration,
  DurationTime,
  TimePoint,
} from "@tento-chrono";
import { LonaWebComponent } from "../../component";
import { Div } from "../../component-builtin";
import { component } from "../../component-decorators";
import { Constants } from "@tento-core/constants";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LazySync } from "../../lazy";
import { CalendarColumnCellContent } from "./calendar-column-cell-content";
import {
  adoptLightCellStyles,
} from "./calendar-column-cell-light";
import { CalendarColumnLayoutGroup } from "./calendar-column-layout-group";
import { PIXELS_PER_HOUR } from "./calendar-hour";
import { Point } from "@tento-core/point";

@component({
  name: "std-calendar-column-cell",
})
export class CalendarColumnCell<
  T extends HTMLElement,
> extends LonaWebComponent {
  private ignoreLayout: boolean = false;
  private _layoutInfo: Option<CalendarColumnLayoutGroup.LayoutInfo>;

  get visibleLayoutInfo(): Option<CalendarColumnLayoutGroup.LayoutInfo> {
    if (this.style.opacity === "0") return null;
    if (this.hidden) return null;
    if (this.ignoreLayout) return null;
    return this._layoutInfo;
  }

  private $handleTop = new LazySync(() => {
    const $d = Div.make();
    $d.classList.add("resize-handle");
    $d.toggleAttribute("top", true);
    return $d;
  });
  private $handleBottom = new LazySync(() => {
    const $d = Div.make();
    $d.classList.add("resize-handle");
    $d.toggleAttribute("bottom", true);
    return $d;
  });

  /**
   * The component base builds a cell without a shadow root
   * (`LonaWebComponent.lightDom`, read once at construction): the cell owns
   * its children (its chip first, then its resize handles) and its rules come
   * from one shared sheet it installs into the root it connects into
   * (calendar-column-cell-light.ts). Its chip is built the same way.
   */
  static lightDom(): boolean {
    return true;
  }

  connectedCallback(): void {
    super.connectedCallback();
    adoptLightCellStyles(this.getRootNode());
  }

  static makeWith<T extends HTMLElement = HTMLElement>(props: {
    id: string;
    time: TimePoint.Range;
    content?: T;
    background?: Option<string>;
  }): CalendarColumnCell<T> {
    const $cell = CalendarColumnCell.make();
    $cell.bind(props);
    if (props.content) {
      props.content.slot = "content";
      $cell.appendChild(props.content);
    }
    return $cell as CalendarColumnCell<T>;
  }

  bind({
    id,
    time,
    background,
    loading,
    ignoreLayout,
  }: CalendarColumnCell.Props) {
    // $$.assertFlushType("writes");

    this.ignoreLayout = ignoreLayout ?? false;
    this.bindLayoutInfo(
      new CalendarColumnLayoutGroup.LayoutInfo(
        id,
        new DurationTime.Range(
          time.start.toDuration(),
          time.start.add(time.duration).toDuration(),
        ),
      ),
    );

    if (background) {
      this.assignStyles({ "--std-calendar-cell-background": background });
    }
    if (loading != null) {
      this.toggleLoading(loading);
    } else {
      this.toggleLoading(false);
    }
  }

  bindLayoutInfo(info: CalendarColumnLayoutGroup.LayoutInfo) {
    this._layoutInfo = info;
    this.assignStyles({
      "--p-start-time-hrs": String(info.time.start.toHrsF),
      "--p-duration-mins": String(info.time.duration().toMinsF),
    });
  }

  /** Pointer x as a fraction (0..1) across the cell's width. Full-width
   *  cells (e.g. the sticker anchor) make this column-relative. Null
   *  before layout (zero width). */
  private xFractionAt(x: number): Option<number> {
    const width = this.offsetWidth;
    return width > 0 ? Math.max(0, Math.min(1, x / width)) : null;
  }

  /**
   * `offset` (an event's `offsetX/Y`, measured from its `target`) measured
   * from this cell. The cell's handles are its own children and are the
   * target themselves, measured from their 4px box.
   */
  private offsetInCell(offset: Point, target: Option<EventTarget>): Point {
    if (target == null || target === this || !(target instanceof HTMLElement)) return offset;
    if (target.parentElement !== this) return offset;
    return { x: offset.x + target.offsetLeft, y: offset.y + target.offsetTop };
  }

  bindCallbacks(callbacks: CalendarColumnCell.Callbacks, _context: string) {
    GESTURE_MANAGER.addPointerEvent(this, {
      onPointerDown: (at, e) => {
        if (!this._layoutInfo) return;
        const offset = this.offsetInCell(at, e?.target);
        const heightPx = this.offsetHeight;
        let resize: Option<"top" | "bottom">;
        if (offset.y <= 4) {
          resize = "top";
        } else if (offset.y >= heightPx - 4) {
          resize = "bottom";
        }
        callbacks.onPointerDown({
          handle: resize,
          position: new CalendarColumnCell.PointerPosition(
            offset,
            this._layoutInfo.time.start,
            this.xFractionAt(offset.x),
          ),
        });
      },
      onClick: (_, at, e) => {
        if (!this._layoutInfo) return;
        const offset = this.offsetInCell(at, e.target);
        callbacks.onPointerUpCell({
          position: new CalendarColumnCell.PointerPosition(
            offset,
            this._layoutInfo.time.start,
            this.xFractionAt(offset.x),
          ),
        });
      },
      onContextMenu: (_, at, e) => {
        if (!this._layoutInfo) return;
        const offset = this.offsetInCell(at, e?.target);
        callbacks.onContextMenu({
          position: new CalendarColumnCell.PointerPosition(
            offset,
            this._layoutInfo.time.start,
          ),
        });
      },
    });
    this.onpointermove = (e) => {
      e.stopPropagation();
      if (!this._layoutInfo) return;
      const offset = this.offsetInCell({ x: e.offsetX, y: e.offsetY }, e.target);
      const { shouldCapturePointer } = callbacks.onPointerMove({
        position: new CalendarColumnCell.PointerPosition(
          offset,
          this._layoutInfo.time.start,
          this.xFractionAt(offset.x),
        ),
      });
      if (shouldCapturePointer) {
        this.setPointerCapture(e.pointerId);
      } else {
        this.releasePointerCapture(e.pointerId);
      }
    };
    this.onpointerenter = () => {
      if (!this.hasAttribute("editable")) return;
      // The cell holds its handles after its chip (its first element child).
      this.appendChild(this.$handleBottom.get());
      this.appendChild(this.$handleTop.get());
    };
  }

  $content(): T {
    return this.firstElementChild as T;
  }

  toggleLoading(loading: boolean) {
    this.toggleAttribute("loading", loading);
    const $content = this.$content();
    if ($content) {
      $content.toggleAttribute("loading", loading);
    }
  }

}

export namespace CalendarColumnCell {
  export class PointerPosition {
    constructor(
      readonly offset: Point,
      readonly offsetFromColumnStart: Option<DurationTime> = null,
      /** Pointer's horizontal fraction (0..1) across the day column,
       *  supplied by the delegate that knows the element width. Null
       *  when the source can't provide it. */
      readonly xFraction: Option<number> = null,
    ) {}

    resolve(windowed: DateFragment.Windowed, pxPerHr: number): DurationTime {
      if (!this.offsetFromColumnStart) {
        return Duration.Time.from({
          hrs: this.offset.y / pxPerHr + windowed.windowedStartHrs,
        });
      }

      // When we have offsetFromColumnStart (e.g., from clicking on a cell),
      // the offset.y is relative to the cell's top, not the column's top.
      // offsetFromColumnStart is the absolute time when the cell starts (e.g., 22:15).
      // We simply add the relative offset within the cell to get the absolute time.
      const offsetWithinCellHrs = this.offset.y / pxPerHr;
      return this.offsetFromColumnStart.add({ hrs: offsetWithinCellHrs });
    }
  }

  export type Props = {
    id: string;
    time: TimePoint.Range;
    background?: Option<string>;
    loading?: Option<boolean>;
    ignoreLayout?: Option<boolean>;
  };

  export type Callbacks = {
    onPointerDown: (event: {
      position: PointerPosition;
      handle: Option<"top" | "bottom">;
    }) => void;
    onPointerUpCell: (event: { position: PointerPosition }) => void;
    onPointerMove: (event: { position: PointerPosition }) => {
      shouldCapturePointer: boolean;
    };
    onContextMenu: (event: { position: PointerPosition }) => void;
  };

  export namespace Callbacks {
    export const DEFAULT: Callbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUpCell: Constants.EMPTY_FUNCTION,
      onPointerMove: () => ({ shouldCapturePointer: false }),
      onContextMenu: Constants.EMPTY_FUNCTION,
    };
  }

  export type Basic = CalendarColumnCell<CalendarColumnCellContent>;

  export function basic(): Basic {
    const $cell = CalendarColumnCell.make();
    const $content = CalendarColumnCellContent.make();
    $content.slot = "content";
    $cell.appendChild($content);
    return $cell as CalendarColumnCell.Basic;
  }
}
