import { RelativeTime } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// Relative time that keeps itself current. `RelativeTime.compact` exists and
// is called by hand; there was no element. This renders a `<time>` with the
// ISO `datetime` and the absolute time as `title`, in relative, absolute or
// both forms, and re-renders on an interval that is set in `connectedCallback`
// and cleared in BOTH `disconnectedCallback` and `onRecycle` — the pooling
// rule the text input got wrong once.
@component({ name: "std-timestamp" })
export class Timestamp extends LonaWebComponent {
  private $time: HTMLTimeElement = this.$("time");
  private props: Option<Timestamp.Props>;
  private tick: Option<number>;

  bind(props: Timestamp.Props): this {
    this.props = props;
    this.render();
    this.arm();
    return this;
  }

  private render(): void {
    const props = this.props;
    if (props == null) return;
    const date = new Date(props.epochMs);
    const absolute = new Intl.DateTimeFormat(
      undefined,
      props.format ?? { dateStyle: "medium", timeStyle: "short" },
    ).format(date);
    const relative = RelativeTime.compact(props.epochMs, Date.now());
    this.$time.dateTime = date.toISOString();
    this.$time.title = absolute;
    this.$time.textContent =
      props.mode === "absolute"
        ? absolute
        : props.mode === "relative"
          ? relative
          : `${relative} · ${absolute}`;
  }

  private arm(): void {
    this.disarm();
    const props = this.props;
    if (props == null || props.mode === "absolute" || !this.isConnected) return;
    this.tick = window.setInterval(() => this.render(), props.tickMs ?? 30_000);
  }

  private disarm(): void {
    if (this.tick != null) window.clearInterval(this.tick);
    this.tick = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.arm();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disarm();
  }

  onRecycle(): void {
    super.onRecycle();
    this.disarm();
    this.props = null;
    this.$time.textContent = "";
    this.$time.removeAttribute("datetime");
    this.$time.removeAttribute("title");
  }

  static makeWith(props: Timestamp.Props): Timestamp {
    return Timestamp.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --timestamp-color: var(--timestamp-color-preset, var(--text-ter));

        display: inline;
        color: var(--timestamp-color);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  static $html = html`<time id="time"></time>`;
}

export namespace Timestamp {
  export type Props = {
    epochMs: number;
    mode: "relative" | "absolute" | "both";
    /** Re-render period for relative text; default 30s. Ignored for absolute. */
    tickMs: Option<number>;
    format: Option<Intl.DateTimeFormatOptions>;
  };
}
