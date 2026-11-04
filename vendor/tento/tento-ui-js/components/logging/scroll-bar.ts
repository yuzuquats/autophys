import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Div } from "../../component-builtin";
import { DomUtils } from "../../dom";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { MathUtils } from "@tento-core/math";
import { NumRangeLike } from "@tento-core/range";

type SpanItem = {
  timestamp: string;
};

@component({
  name: "std-scroll-bar",
})
export class ScrollBar extends LonaWebComponent {
  rect: Option<DOMRect>;
  currentPixelOffset: number = 0;
  spans: SpanItem[] = [];

  onScrollToSpan: Option<(s: SpanItem) => void>;

  constructor() {
    super();
    $$.measure(() => (this.rect = this.getBoundingClientRect()));
    this.onresize = () => (this.rect = this.getBoundingClientRect());

    this.$("root").onpointerup = (e) => {
      this.currentPixelOffset = MathUtils.clampR(
        e.offsetY - 6,
        this.scrollOffsetRange(),
      );
      this.$("cursor").style.setProperty("--y", this.currentPixelOffset + "px");
      const pctProgress =
        this.currentPixelOffset / this.scrollOffsetRange().end;
      const dateRangeMs = this.dateRangeMs();
      if (!dateRangeMs) return;
      const date = new Date(NumRangeLike.progress(pctProgress, dateRangeMs));

      // todo: write binary search cuz there's no builtin :(
      const foundSpan = this.spans.findLast(
        (s) => new Date(s.timestamp) < date,
      );
      if (foundSpan && this.onScrollToSpan) {
        this.onScrollToSpan(foundSpan);
      }
    };
  }

  scrollOffsetRange(): NumRangeLike {
    const rect = this.rect ?? this.getBoundingClientRect();
    return {
      start: 0,
      end: rect.height - 8,
    };
  }

  dateRangeMs(): Option<NumRangeLike> {
    if (this.spans.length < 2) return;
    return {
      start: new Date(this.spans[0].timestamp).getTime(),
      end: new Date(this.spans[this.spans.length - 1].timestamp).getTime(),
    };
  }

  setCursorOffset(span: SpanItem) {
    const dateRangeMs = this.dateRangeMs();
    if (!dateRangeMs) return;
    const progressPct = NumRangeLike.getProgressPct(
      new Date(span.timestamp).getTime(),
      dateRangeMs,
    );
    const offsetProgress = NumRangeLike.progress(
      progressPct,
      this.scrollOffsetRange(),
    );
    this.currentPixelOffset = offsetProgress;
    this.$("cursor").style.setProperty("--y", this.currentPixelOffset + "px");
  }

  bind(spans: SpanItem[]) {
    this.spans = spans;
    DomUtils.clearChildren(this.$("markers"));

    const dateRangeMs = this.dateRangeMs();
    if (!dateRangeMs) return;

    const start = new Date(dateRangeMs.start);
    start.setMinutes(0);
    start.setSeconds(0);
    start.setMilliseconds(0);
    const startOffsetPx = NumRangeLike.progress(
      NumRangeLike.getProgressPct(start.getTime(), dateRangeMs),
      this.scrollOffsetRange(),
    );

    const numMs = dateRangeMs.end - dateRangeMs.start;
    const numHours = numMs / (1_000 * 60 * 60);
    if (numHours < 1) return;

    const heightPerHour = this.scrollOffsetRange().end / numHours;
    const hoursPerDivider = Math.ceil(numHours / 10);
    if (hoursPerDivider < 1) return;

    const numDividers = numHours / hoursPerDivider;
    for (let i = 1; i < numDividers + 1; ++i) {
      const $label = Div.make();
      $label.textContent = `${(start.getHours() + i * hoursPerDivider) % 12}`;
      $label.classList.add("label");
      $label.style.top =
        i * hoursPerDivider * heightPerHour + startOffsetPx + 3 + "px";
      this.$("markers").appendChild($label);
    }
  }

  static $styles = [
    css`
      #root {
        position: relative;
        height: 100%;
        width: 32px;
        #background: #f0f0f0;
        background: #282828;
        border-radius: 4px;
        overflow: hidden;
      }

      #cursor {
        position: absolute;
        top: 0px;
        height: 4px;
        width: calc(100% - 4px);
        border-radius: 2px;
        background: #888;
        margin: 2px;
        transform: translateY(calc(var(--y, 0px)));
        transition: transform 0.15s ease;
      }

      #markers {
        position: absolute;
        top: 0;
        width: 100%;
      }

      .label {
        position: absolute;
        font-size: 10px;
        color: #aaa;
        width: 100%;
        padding-top: 4px;
        padding-left: 4px;
      }

      .label::before {
        content: "";
        position: absolute;
        top: 0px;
        height: 1px;
        left: 4px;
        right: 4px;
        background: #aaa;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <div id="markers"></div>
      <div id="cursor"></div>
    </div>
  `;
}
